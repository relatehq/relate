"""Audit the single-pass schedule, raw usage, official scores, and source identity."""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
from retained_usage import episode_usage, read_json
from model_provider import rates
from results_explorer import request_transcript

HERE = Path(__file__).resolve().parent


def audit(batch):
    ledger = read_json(HERE / '.local/batches' / batch / 'manifest.json', {})
    expected = set(itertools.product(ledger['tasks'], ledger['models'], ledger['conditions']))
    attempts = ledger['episodes']
    observed = [(e['task'], e['model'], e['condition']) for e in attempts]
    assert len(observed) == len(set(observed)) == len(expected) == 96
    assert set(observed) == expected
    assert all(e['status'] in ('finished', 'incomplete') for e in attempts)
    rows = []
    for e in attempts:
        root = HERE / '.local/runs' / e['run']
        config = read_json(root / 'config.json', {})
        assert config['model'] == e['model'] and config['repeats'] == 1
        assert config['tasks'] == [e['task']] and config['conditions'] == [e['condition']]
        assert config['steps'] == 28 and config['generated_budget'] == 14000 and config['max_output_tokens'] == 4096
        for name, value in config['source_sha256'].items():
            assert hashlib.sha256((root / 'source' / name).read_bytes()).hexdigest() == value == ledger['source_sha256'][name]
        case = root / f"{e['task']}__{e['condition']}__0"
        result = read_json(case / 'result.json', {})
        score = read_json(case / 'evaluation.json', {})
        steps = read_json(case / 'steps.json', [])
        if result:
            assert score and (result['success'] == score['success'] or result['success'] is None and result['termination'] == 'infrastructure-error')
            assert len(steps) == result['steps']
        for step in steps:
            model = step['model']
            raw = model['provider_response']
            assert raw['model'] == model['model']
            assert model['provider_request']['model'] == e['model']
            assert raw['usage'] == model['provider_usage']
            u = raw['usage']
            if e['model'].startswith('claude-'):
                cached = u.get('cache_read_input_tokens', 0)
                created = u.get('cache_creation_input_tokens', 0)
                count = u['input_tokens'] + cached + created
                rin, rc, rout = rates(e['model'], count)
                cost = (u['input_tokens'] * rin + cached * rc + created * rin * 1.25 + u['output_tokens'] * rout) / 1e6
            else:
                count = u['input_tokens']
                cached = u.get('input_tokens_details', {}).get('cached_tokens', 0)
                rin, rc, rout = rates(e['model'])
                cost = ((count - cached) * rin + cached * rc + u['output_tokens'] * rout) / 1e6
            assert model['usage']['input_tokens'] == count
            assert model['usage']['output_tokens'] == u['output_tokens']
            assert abs(cost - model['estimated_usd']) < 1e-10
        transcript = request_transcript(case, steps)
        assert len(transcript) == len(steps)
        usage = episode_usage(case)
        if result:
            assert abs(usage['estimated_usd'] - result['estimated_usd']) < 1e-10
            assert usage['generated_tokens'] == result['generated_tokens'] <= 14000
            assert usage['prompt_tokens'] == result['prompt_tokens']
        rows.append({'task': e['task'], 'model': e['model'], 'condition': e['condition'], 'status': e['status'], 'success': result.get('success'), 'termination': result.get('termination'), 'steps': len(steps), 'seconds': result.get('seconds'), 'model_seconds': result.get('model_seconds'), 'trajectory': e['run'], **usage})
    groups = []
    for model, condition in itertools.product(ledger['models'], ledger['conditions']):
        subset = [r for r in rows if r['model'] == model and r['condition'] == condition]
        groups.append({'model': model, 'condition': condition, 'attempts': len(subset), 'passed': sum(r['success'] is True for r in subset), 'failed': sum(r['success'] is False for r in subset), 'incomplete': sum(r['success'] is None for r in subset), 'estimated_usd': sum(r['estimated_usd'] for r in subset), 'mean_turns': sum(r['steps'] for r in subset) / len(subset)})
    report = {'batch': batch, 'git_head': ledger['git_head'], 'build_sha256': ledger['build_sha256'], 'source_sha256': ledger['source_sha256'], 'episodes': len(rows), 'single_attempt_per_combination': True, 'official_scores_verified': True, 'raw_provider_usage_verified': True, 'exact_request_transcripts_reconstructed': True, 'wall_seconds': ledger['finished_at'] - ledger['started_at'], 'attempted_requests': sum(r['attempted_requests'] for r in rows), 'requests_without_usage': sum(r['requests_without_usage'] for r in rows), 'estimated_usd': sum(r['estimated_usd'] for r in rows), 'groups': groups, 'rows': rows}
    path = HERE / 'evidence' / f'{batch}-results.json'
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k not in ('rows', 'source_sha256')}, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch', required=True)
    audit(parser.parse_args().batch)
