import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import results_explorer


class ExplorerTests(unittest.TestCase):
    def test_request_history_uses_only_messages_present_at_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp)
            initial = [{'role': 'system', 'content': 'instructions'}, {'role': 'user', 'content': 'task'}]
            call1 = {'type': 'function_call', 'call_id': 'a', 'arguments': '{}'}
            output1 = {'type': 'function_call_output', 'call_id': 'a', 'output': 'first'}
            call2 = {'type': 'function_call', 'call_id': 'b', 'arguments': '{}'}
            output2 = {'type': 'function_call_output', 'call_id': 'b', 'output': 'second'}
            final = initial + [call1, output1, call2, output2]
            (case / 'initial_messages.json').write_text(json.dumps(initial))
            (case / 'final_messages.json').write_text(json.dumps(final))
            steps = [{'turn': i + 1, 'model': {'provider_request': {'input': final}, 'provider_output': [call], 'call_id': call['call_id']}} for i, call in enumerate([call1, call2])]
            result = results_explorer.request_transcript(case, steps)
            self.assertEqual(result[0]['request']['input'], initial)
            self.assertEqual(result[1]['request']['input'], initial + [call1, output1])
            self.assertEqual(steps[0]['model']['provider_request']['input'], final)

    def test_export_preserves_every_provider_block_and_incomplete_attempt(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as output:
            here = Path(root) / 'repo/dev/research/appworld'
            here.mkdir(parents=True)
            (here / 'results_explorer.html').write_text('<html></html>')
            batch = here / '.local/batches/example'
            batch.mkdir(parents=True)
            entry = {'task': 'e7a10f8_1', 'condition': 'sdk', 'model': 'gpt-5.4-nano', 'run': 'example-run', 'status': 'incomplete'}
            (batch / 'manifest.json').write_text(json.dumps({'episodes': [entry]}))
            case = here / '.local/runs/example-run/e7a10f8_1__sdk__0'
            case.mkdir(parents=True)
            response = {'output': [{'type': 'reasoning', 'encrypted_content': 'opaque'}, {'type': 'function_call', 'arguments': '{"code":"print(1)"}'}]}
            steps = [{'model': {'provider_response': response, 'provider_output': response['output'], 'usage': {'input_tokens': 2, 'output_tokens': 3}, 'estimated_usd': .01}}]
            content = json.dumps(steps)
            (case / 'steps.json').write_text(content)
            (case / 'requests.json').write_text('[{"status":"responded"},{"status":"failed"}]')
            with patch.object(results_explorer, 'HERE', here):
                results_explorer.build('example', Path(output))
            trace = json.loads((Path(output) / 'trajectories/example-run/trajectory.json').read_text())
            self.assertEqual(trace['steps'], steps)
            self.assertEqual(trace['usage']['requests_without_usage'], 1)
            self.assertEqual(trace['attempt_status'], 'incomplete')
            self.assertEqual((Path(output) / 'trajectories/example-run/steps.json').read_text(), content)
            self.assertEqual((case / 'steps.json').read_text(), content)
