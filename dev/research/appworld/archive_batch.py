"""Archive every batch artifact and verify every restored byte."""
import argparse
import hashlib
import json
import shutil
import tempfile
from pathlib import Path
from appworld.common.constants import PASSWORD, SALT
from results_explorer import request_transcript
from retained_usage import read_json
from appworld.common.utils import pack_bundle, unpack_bundle

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive(batch):
    source = HERE / '.local/batches' / batch
    manifest = json.loads((source / 'manifest.json').read_text())
    assert all(e['status'] in ('finished', 'incomplete') for e in manifest['episodes']), 'Batch is not finished'
    destination = HERE / 'evidence' / f'{batch}.bundle'
    if destination.exists():
        raise FileExistsError(destination)
    with tempfile.TemporaryDirectory() as temp:
        staging = Path(temp) / 'staging'
        restored = Path(temp) / 'restored'
        staging.mkdir()
        (staging / 'runs').mkdir()
        (staging / 'world-outputs').mkdir()
        shutil.copytree(source, staging / 'batch')
        for entry in manifest['episodes']:
            run = HERE / '.local/runs' / entry['run']
            if run.exists():
                shutil.copytree(run, staging / 'runs' / entry['run'])
                for case in run.glob('*__*__*'):
                    if (case / 'final_messages.json').exists():
                        transcript = request_transcript(case, read_json(case / 'steps.json', []))
                        (staging / 'runs' / entry['run'] / case.name / 'request_transcript.json').write_text(json.dumps(transcript))
            config = json.loads((run / 'config.json').read_text()) if (run / 'config.json').exists() else {}
            for condition in config.get('conditions', []):
                experiment = f"{entry['run']}-{condition}-0"
                output = HERE / '.local/world/experiments/outputs' / experiment
                if output.exists():
                    shutil.copytree(output, staging / 'world-outputs' / experiment)
        reporting = staging / 'batch/reporting-source'
        reporting.mkdir()
        for name in ['results_explorer.py', 'results_explorer.html', 'archive_batch.py', 'audit_two_model.py', 'task_catalog.py']:
            shutil.copy2(HERE / name, reporting / name)
        pack_bundle(bundle_file_path=str(destination), base_directory=str(staging), include_directories=['batch', 'runs', 'world-outputs'], password=PASSWORD, salt=SALT)
        expected = {str(p.relative_to(staging)): digest(p) for p in staging.rglob('*') if p.is_file()}
        unpack_bundle(bundle_file_path=str(destination), base_directory=str(restored), password=PASSWORD, salt=SALT)
        actual = {str(p.relative_to(restored)): digest(p) for p in restored.rglob('*') if p.is_file()}
        assert expected == actual, 'Restored artifact hashes differ'
    report = {'batch': batch, 'bundle': destination.name, 'bundle_sha256': digest(destination), 'bytes': destination.stat().st_size, 'verified_files': len(expected), 'restored_identical': True, 'files': expected}
    # Filenames and hashes contain no benchmark instructions or application records.
    (HERE / 'evidence' / f'{batch}-archive.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'files'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch', required=True)
    archive(parser.parse_args().batch)
