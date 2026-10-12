"""Run each implemented task/model/interface exactly once in isolated processes."""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path
from retained_usage import episode_usage

HERE = Path(__file__).resolve().parent
TASKS = [f'{family}_{i}' for family in ('e7a10f8', '82e2fac', 'd0b1f43', 'afc0fce') for i in (1, 2, 3)]
MODELS = ['gpt-5.4-nano', 'claude-haiku-5-5']
CONDITIONS = ['raw', 'raw_ts', 'sdk', 'snapshot_ts']
SOURCES = ['sdk_runner.py', 'model_provider.py', 'sdk-repl.mjs', 'sdk-graph.mjs', 'acquire.py', 'source_writes.py', 'explainer_support.py', 'runner.py', 'prompts.py', 'two_model_eval.py']


def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(path)


def hashes():
    return {n: hashlib.sha256((HERE / n).read_bytes()).hexdigest() for n in SOURCES}


def build_hash():
    digest = hashlib.sha256()
    for path in sorted(HERE.parents[2].glob("packages/*/dist/**/*.js")):
        digest.update(str(path.relative_to(HERE.parents[2])).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def run(args):
    tasks = getattr(args, 'tasks', None) or TASKS
    conditions = getattr(args, 'conditions', None) or CONDITIONS
    if len(set(tasks)) != len(tasks) or len(set(conditions)) != len(conditions):
        raise ValueError('Duplicate task or condition would repeat an episode')
    root = HERE / '.local/batches' / args.batch
    root.mkdir(parents=True, exist_ok=False)
    schedule = []
    for ti, task in enumerate(tasks):
        for ci in range(len(conditions)):
            condition = conditions[(ci + ti) % len(conditions)]
            for model in MODELS[ti % 2:] + MODELS[:ti % 2]:
                short = 'nano' if 'nano' in model else 'haiku'
                schedule.append({'task': task, 'condition': condition, 'model': model, 'run': f'{args.batch}-{short}-{task}-{condition}', 'status': 'not-started'})
    frozen = hashes()
    frozen_build = build_hash()
    ledger = {'batch': args.batch, 'planned': len(schedule), 'repeats': 1, 'tasks': tasks, 'models': MODELS, 'conditions': conditions, 'source_sha256': frozen, 'build_sha256': frozen_build, 'git_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=HERE, text=True).strip(), 'jobs': args.jobs, 'max_cost_usd': args.max_cost_usd, 'episodes': schedule, 'started_at': time.time()}
    save(root / 'manifest.json', ledger)
    running = []
    known_cost = 0.0
    pending = iter(schedule)
    next_item = next(pending, None)
    while next_item is not None or running:
        while next_item is not None and len(running) < args.jobs:
            if hashes() != frozen or build_hash() != frozen_build:
                raise RuntimeError('Runner changed after execution freeze')
            available = args.max_cost_usd - known_cost - sum(item['allowance'] for _, _, item in running)
            if available < 1:
                if running:
                    break
                ledger['termination'] = 'batch-cost-budget'
                next_item = None
                break
            item = next_item
            item.update(status='started', started_at=time.time(), allowance=1.0)
            save(root / 'manifest.json', ledger)
            command = [str(HERE / '.venv/bin/python'), str(HERE / 'sdk_runner.py'), '--run', item['run'], '--tasks', item['task'], '--conditions', item['condition'], '--repeats', '1', '--model', item['model'], '--credentials', str(args.credentials), '--reasoning', 'low', '--steps', '28', '--max-output-tokens', '4096', '--generated-budget', '14000', '--output-chars', '14000', '--max-cost-usd', str(item['allowance'])]
            log = (root / (item['run'] + '.log')).open('w')
            child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, cwd=HERE.parents[2])
            running.append((child, log, item))
            next_item = next(pending, None)
        for child, log, item in list(running):
            if child.poll() is None:
                continue
            log.close()
            case = HERE / '.local/runs' / item['run'] / f"{item['task']}__{item['condition']}__0"
            usage = episode_usage(case)
            known_cost += usage['estimated_usd']
            result_path = case / 'result.json'
            result = json.loads(result_path.read_text()) if result_path.exists() else {}
            item.update(status='finished' if child.returncode == 0 else 'incomplete', exit_code=child.returncode, finished_at=time.time(), usage=usage, result=result)
            ledger['known_estimated_usd'] = known_cost
            save(root / 'manifest.json', ledger)
            print(json.dumps({'finished': sum(i['status'] in ('finished', 'incomplete') for i in schedule), 'planned': len(schedule), 'task': item['task'], 'model': item['model'], 'condition': item['condition'], 'success': result.get('success'), 'status': item['status'], 'known_usd': round(known_cost, 5)}), flush=True)
            running.remove((child, log, item))
        if running:
            time.sleep(1)
    ledger['finished_at'] = time.time()
    save(root / 'manifest.json', ledger)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch', required=True)
    parser.add_argument('--tasks', nargs='+', choices=TASKS)
    parser.add_argument('--conditions', nargs='+', choices=CONDITIONS)
    parser.add_argument('--credentials', type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=3)
    parser.add_argument('--max-cost-usd', type=float, default=20)
    run(parser.parse_args())
