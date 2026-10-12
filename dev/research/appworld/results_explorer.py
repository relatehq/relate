"""Export a complete batch and serve only its local, protected result files."""
import argparse
import copy
import hashlib
import json
import shutil
from pathlib import Path
from retained_usage import read_json, episode_usage

HERE = Path(__file__).resolve().parent
FAMILIES = {'e7a10f8': 'Playlist duration', '82e2fac': 'Song selection', 'd0b1f43': 'Payment totals', 'afc0fce': 'Comments and likes'}


def request_transcript(case, steps):
    """Recover each exact OpenAI input prefix from the retained full conversation.

    The first frozen runner retained a mutable request.input reference. It grew
    with subsequent turns in steps.json. Responses and final_messages are intact;
    this separate derivative restores the wire-time prefix without altering them.
    """
    final = read_json(case / 'final_messages.json', [])
    initial = read_json(case / 'initial_messages.json', [])
    cursor = len(initial)
    requests = []
    for step in steps:
        model = step['model']
        payload = copy.deepcopy(model.get('provider_request', {}))
        if 'input' in payload:
            assert final[:len(initial)] == initial
            payload['input'] = copy.deepcopy(final[:cursor])
            response = model['provider_output']
            assert final[cursor:cursor + len(response)] == response
            cursor += len(response)
            if cursor < len(final) and final[cursor].get('type') == 'function_call_output':
                assert final[cursor]['call_id'] == model['call_id']
                cursor += 1
        requests.append({'turn': step['turn'], 'request': payload})
    return requests


def build(batch, output):
    output = output.resolve()
    if output.is_relative_to(HERE.parents[2]):
        raise ValueError('Protected browser data must stay outside the repository')
    output.mkdir(parents=True, exist_ok=True)
    manifest = read_json(HERE / '.local/batches' / batch / 'manifest.json', {})
    episodes = []
    for attempt in manifest['episodes']:
        case = HERE / '.local/runs' / attempt['run'] / f"{attempt['task']}__{attempt['condition']}__0"
        result = read_json(case / 'result.json', {})
        initial = read_json(case / 'initial_messages.json', [])
        context = {}
        if initial:
            try:
                context = json.loads(initial[-1]['content'])
            except (ValueError, TypeError):
                pass
        usage = episode_usage(case)
        destination = output / 'trajectories' / attempt['run']
        destination.mkdir(parents=True, exist_ok=True)
        files = []
        if case.exists():
            for path in sorted(case.iterdir()):
                if path.is_file():
                    shutil.copy2(path, destination / path.name)
                    files.append({'name': path.name, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        config_path = case.parent / 'config.json'
        if config_path.exists():
            shutil.copy2(config_path, destination / 'config.json')
        steps = read_json(case / 'steps.json', [])
        exact_requests = request_transcript(case, steps) if (case / 'final_messages.json').exists() else []
        if exact_requests:
            (destination / 'request_transcript.json').write_text(json.dumps(exact_requests))
        trace = {'exact_requests': exact_requests, 'id': attempt['run'], 'task': attempt['task'], 'family': FAMILIES[attempt['task'].split('_')[0]], 'model': attempt['model'], 'condition': attempt['condition'], 'attempt_status': attempt['status'], 'instruction': context.get('task', ''), 'result': result, 'usage': usage, 'files': files, 'messages': initial, 'final_messages': read_json(case / 'final_messages.json', []), 'steps': steps, 'requests': read_json(case / 'requests.json', []), 'evaluation': read_json(case / 'evaluation.json', {}), 'api_calls': read_json(case / 'api_calls.json', [])}
        (destination / 'trajectory.json').write_text(json.dumps(trace))
        episodes.append({k: v for k, v in trace.items() if k not in ('steps', 'messages', 'final_messages', 'requests', 'evaluation', 'api_calls', 'files', 'exact_requests')})
    (output / 'data.json').write_text(json.dumps({'manifest': manifest, 'episodes': episodes}))
    shutil.copy2(HERE / 'results_explorer.html', output / 'index.html')
    print(json.dumps({'output': str(output), 'episodes': len(episodes)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.batch, args.output)
