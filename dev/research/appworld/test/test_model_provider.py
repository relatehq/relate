import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_provider import call, ProviderError, anthropic_messages, protocol_feedback
from harness_protocol import SCHEMA


class ProviderTests(unittest.TestCase):
    def test_haiku_preserves_blocks_and_replays_tool_results(self):
        blocks = [{'type': 'thinking', 'thinking': 'retained', 'signature': 'signed'}, {'type': 'tool_use', 'id': 'one', 'name': 'execute_code', 'input': {'code': 'print(1)'}}]
        result = {'model': 'claude-haiku-5-5', 'content': blocks, 'usage': {'input_tokens': 10, 'cache_read_input_tokens': 20, 'cache_creation_input_tokens': 4, 'output_tokens': 5}, 'stop_reason': 'tool_use'}
        response = Mock(status_code=200); response.json.return_value = result
        messages = [{'role': 'system', 'content': 'instructions'}, {'role': 'user', 'content': 'task'}]
        with patch('model_provider.requests.post', return_value=response) as post:
            code, model = call('secret', 'claude-haiku-5-5', messages, 4096, 'low', SCHEMA)
        self.assertEqual(model['provider_response'], result)
        self.assertEqual(model['usage']['input_tokens'], 34)
        self.assertAlmostEqual(model['estimated_usd'], (1 + .2 + .5 + 2.5) / 1e6)
        self.assertNotIn('secret', str(model))
        self.assertEqual(post.call_args.kwargs['json']['tool_choice']['type'], 'auto')
        messages += model['provider_output'] + [{'type': 'function_call_output', 'call_id': 'one', 'output': '1'}]
        system, turns = anthropic_messages(messages)
        self.assertEqual(turns[1]['content'], blocks)
        self.assertEqual(turns[2]['content'][0]['tool_use_id'], 'one')

    def test_openai_preserves_raw_response_and_request_without_credentials(self):
        result = {'model': 'gpt-5.4-nano', 'output': [{'type': 'reasoning', 'encrypted_content': 'opaque'}, {'type': 'function_call', 'name': 'execute_code', 'call_id': 'c', 'arguments': '{"code":"print(1)"}'}], 'usage': {'input_tokens': 100, 'output_tokens': 10}, 'status': 'completed'}
        response = Mock(status_code=200); response.json.return_value = result
        with patch('model_provider.requests.post', return_value=response):
            _, model = call('secret', 'gpt-5.4-nano', [], 4096, 'low', SCHEMA)
        self.assertEqual(model['provider_response'], result)
        self.assertEqual(model['call_id'], 'c')
        self.assertNotIn('secret', str(model))

    def test_retained_request_does_not_grow_with_later_conversation(self):
        response = Mock(status_code=200)
        response.json.return_value = {'model': 'gpt-5.4-nano', 'output': [], 'usage': {'input_tokens': 1, 'output_tokens': 2}}
        messages = [{'role': 'user', 'content': 'initial task'}]
        with patch('model_provider.requests.post', return_value=response):
            _, model = call('secret', 'gpt-5.4-nano', messages, 4096, 'low', SCHEMA)
        messages.append({'role': 'assistant', 'content': 'later response'})
        self.assertEqual(model['provider_request']['input'], [{'role': 'user', 'content': 'initial task'}])

    def test_http_failure_retains_body_and_is_never_retried(self):
        with patch('model_provider.requests.post', return_value=Mock(status_code=429, text='rate limit')) as post:
            with self.assertRaises(ProviderError) as raised:
                call('secret', 'claude-haiku-5-5', [], 4096, 'low', SCHEMA)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(raised.exception.details['response'], 'rate limit')
        self.assertNotIn('secret', str(raised.exception.details))

    def test_multiple_actions_retained_but_not_executed(self):
        blocks = [{'type': 'tool_use', 'id': str(i), 'name': 'execute_code', 'input': {'code': 'x'}} for i in range(2)]
        response = Mock(status_code=200); response.json.return_value = {'content': blocks, 'usage': {'input_tokens': 1, 'output_tokens': 2}}
        with patch('model_provider.requests.post', return_value=response):
            _, model = call('secret', 'claude-haiku-5-5', [], 4096, 'low', SCHEMA)
        self.assertIsNone(model['call_id'])
        self.assertEqual(model['provider_response']['content'], blocks)


class RecoveryTranscriptTests(unittest.TestCase):
    def test_all_anthropic_calls_get_errors_in_one_user_message(self):
        blocks = [{'type': 'tool_use', 'id': str(i), 'name': 'completeTask', 'input': {}} for i in range(2)]
        replay = [{'role': 'assistant', 'content': blocks}]
        replies = protocol_feedback({'provider_output': replay}, 'typed error')
        _, turns = anthropic_messages(replay + replies)
        self.assertEqual(len(turns), 2)
        self.assertEqual([b['tool_use_id'] for b in turns[-1]['content']], ['0', '1'])
        self.assertTrue(all(b['is_error'] for b in turns[-1]['content']))

    def test_openai_results_have_no_anthropic_only_fields(self):
        replay = [{'type': 'function_call', 'call_id': str(i), 'name': 'completeTask'} for i in range(2)]
        replies = protocol_feedback({'provider_output': replay}, 'typed error')
        self.assertEqual([r['call_id'] for r in replies], ['0', '1'])
        self.assertTrue(all(set(r) == {'type', 'call_id', 'output'} for r in replies))
