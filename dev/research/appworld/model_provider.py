"""Provider wire protocols and usage. No automatic request retries."""
import json
import freezegun.api as clock
import requests

MODELS = ('gpt-5.4-nano', 'gpt-5.4-mini', 'claude-haiku-5-5')


class ProviderError(RuntimeError):
    def __init__(self, status, request, response):
        super().__init__(f'Provider HTTP {status}')
        self.details = {'http_status': status, 'request': request, 'response': response}


def rates(model, input_tokens=0):
    if model == 'claude-haiku-5-5':
        return (0.10, 0.01, 0.50) if input_tokens <= 100000 else (0.50, 0.05, 2.50)
    return (0.20, 0.02, 1.25) if 'nano' in model else (0.75, 0.075, 4.5)


def reservation_rates(model):
    # Long-context rate makes the pre-dispatch reservation conservative.
    incoming, _, outgoing = rates(model, 100001)
    return incoming, outgoing


def anthropic_messages(messages):
    system = '\n'.join(m['content'] for m in messages if m.get('role') == 'system')
    turns = []
    for m in messages:
        if m.get('role') == 'system':
            continue
        if m.get('type') == 'function_call_output':
            turns.append({'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': m['call_id'], 'content': m['output']}]})
        else:
            turns.append(m)
    return system, turns


def call(key, model, messages, max_output, reasoning, schema):
    start = clock.real_perf_counter()
    description = 'Execute the next code cell in the persistent interpreter and return its printed output. Inspect the result before choosing the next cell.'
    anthropic = model.startswith('claude-')
    if anthropic:
        system, turns = anthropic_messages(messages)
        payload = {
            'model': model, 'system': system, 'messages': turns,
            'max_tokens': max_output, 'thinking': {'type': 'adaptive'},
            'output_config': {'effort': reasoning},
            'tools': [{'name': 'execute_code', 'description': description, 'input_schema': schema}],
            'tool_choice': {'type': 'auto', 'disable_parallel_tool_use': True},
        }
        headers = {'x-api-key': key, 'anthropic-version': '2023-06-01'}
        url = 'https://api.anthropic.com/v1/messages'
    else:
        payload = {
            'model': model, 'store': False, 'input': messages,
            'reasoning': {'effort': reasoning}, 'max_output_tokens': max_output,
            'include': ['reasoning.encrypted_content'],
            'tools': [{'type': 'function', 'name': 'execute_code', 'description': description, 'strict': True, 'parameters': schema}],
            'tool_choice': {'type': 'function', 'name': 'execute_code'}, 'parallel_tool_calls': False,
        }
        headers = {'Authorization': f'Bearer {key}'}
        url = 'https://api.openai.com/v1/responses'
    response = requests.post(url, headers=headers, json=payload, timeout=180)
    if response.status_code != 200:
        raise ProviderError(response.status_code, payload, response.text)
    result = response.json()
    raw_usage = result.get('usage', {})
    if anthropic:
        cached = raw_usage.get('cache_read_input_tokens', 0)
        created = raw_usage.get('cache_creation_input_tokens', 0)
        incoming = raw_usage.get('input_tokens', 0)
        usage = {'input_tokens': incoming + cached + created, 'output_tokens': raw_usage.get('output_tokens', 0), 'input_tokens_details': {'cached_tokens': cached, 'cache_creation_tokens': created}}
        content = result.get('content', [])
        calls = [c for c in content if c.get('type') == 'tool_use']
        valid = len(calls) == 1 and calls[0].get('name') == 'execute_code'
        action, call_id = (json.dumps(calls[0].get('input')), calls[0]['id']) if valid else ('', None)
        replay = [{'role': 'assistant', 'content': content}]
        rate_in, rate_cache, rate_out = rates(model, usage['input_tokens'])
        cost = (incoming * rate_in + cached * rate_cache + created * rate_in * 1.25 + usage['output_tokens'] * rate_out) / 1e6
    else:
        usage = raw_usage
        cached = usage.get('input_tokens_details', {}).get('cached_tokens', 0)
        replay = result.get('output', [])
        calls = [c for c in replay if c.get('type') == 'function_call']
        valid = len(calls) == 1 and calls[0].get('name') == 'execute_code'
        action, call_id = (calls[0]['arguments'], calls[0]['call_id']) if valid else ('', None)
        rate_in, rate_cache, rate_out = rates(model)
        cost = ((usage['input_tokens'] - cached) * rate_in + cached * rate_cache + usage['output_tokens'] * rate_out) / 1e6
    return action, {
        'usage': usage, 'provider_usage': raw_usage,
        'provider_request': payload, 'provider_response': result,
        'provider_output': replay, 'call_id': call_id, 'estimated_usd': cost,
        'model': result.get('model', model), 'status': result.get('stop_reason', result.get('status')),
        'seconds': clock.real_perf_counter() - start,
    }
