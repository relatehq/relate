import { afterEach, expect, it, vi } from 'vitest';
import { createModel } from '../src/harness/providers/index.js';
import type { Provider } from '../src/harness/providers/types.js';
import { agentLoop } from '../src/harness/model.js';
import type { ArmHandle } from '../src/harness/arms.js';

const tools = [
  {
    name: 'lookup',
    description: 'Find a row',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'submit_answer',
    description: 'Submit',
    parameters: {
      type: 'object',
      properties: { answer: {}, caveats: { type: 'array' } },
    },
  },
];
const usage = {
  input_tokens: 100,
  output_tokens: 12,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 },
};
const answer = { answer: { id: 'one' }, caveats: [] };

afterEach(() => vi.unstubAllGlobals());

it.each(['openai', 'anthropic'] as Provider[])(
  'runs the same two-turn tool protocol through %s, retaining continuation and usage',
  async (provider) => {
    const native =
      provider === 'openai'
        ? [
            {
              type: 'reasoning',
              id: 'reason',
              encrypted_content: 'opaque',
              summary: [],
            },
            {
              type: 'function_call',
              call_id: 'call-one',
              id: 'fc-one',
              name: 'lookup',
              arguments: '{"id":"one"}',
              status: 'completed',
            },
          ]
        : [
            { type: 'thinking', thinking: 'native state', signature: 'opaque' },
            {
              type: 'tool_use',
              id: 'call-one',
              name: 'lookup',
              input: { id: 'one' },
            },
          ];
    const replies =
      provider === 'openai'
        ? [
            { output: native, status: 'completed', usage },
            {
              output: [
                {
                  type: 'function_call',
                  call_id: 'submit',
                  name: 'submit_answer',
                  arguments: JSON.stringify(answer),
                },
              ],
              status: 'completed',
              usage,
            },
          ]
        : [
            {
              content: native,
              stop_reason: 'tool_use',
              usage: {
                input_tokens: 60,
                output_tokens: 12,
                cache_read_input_tokens: 40,
                cache_creation_input_tokens: 5,
              },
            },
            {
              content: [
                {
                  type: 'tool_use',
                  id: 'submit',
                  name: 'submit_answer',
                  input: answer,
                },
              ],
              stop_reason: 'tool_use',
              usage: {
                input_tokens: 60,
                output_tokens: 12,
                cache_read_input_tokens: 40,
                cache_creation_input_tokens: 5,
              },
            },
          ];
    const requests: Record<string, unknown>[] = [];
    const request = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      expect(init.signal).toBeInstanceOf(AbortSignal);

      return Response.json(replies[requests.length - 1]);
    });

    vi.stubGlobal('fetch', request);
    const call = vi.fn(async () => {
      throw Error('Temporary lookup failure');
    });
    const events: unknown[] = [];
    const model = createModel(
      {
        provider,
        model: 'test-model',
        maxOutputTokens: 1024,
        ...(provider === 'openai' ? { reasoning: 'low' as const } : {}),
      },
      { OPENAI_API_KEY: 'secret-test', ANTHROPIC_API_KEY: 'secret-test' },
    );
    const result = await agentLoop({
      model,
      arm: { tools, call } as unknown as ArmHandle,
      system: 'rules',
      prompt: 'task',
      emit: async (e) => {
        events.push(e);
      },
    });

    expect(result.submission).toEqual(answer);
    expect(result.stop).toBe('submitted');
    expect(result.usage).toEqual({
      inputTokens: provider === 'openai' ? 110 : 120,
      outputTokens: 24,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
    expect(call).toHaveBeenCalledExactlyOnceWith(
      'lookup',
      { id: 'one' },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(events)).not.toContain('secret-test');

    if (provider === 'openai') {
      expect(requests[0]).toMatchObject({
        store: false,
        reasoning: { effort: 'low' },
        max_output_tokens: 1024,
        tools: tools.map((t) => ({ ...t, type: 'function', strict: false })),
      });
      expect(requests[1]!.input).toEqual([
        { role: 'user', content: 'task' },
        ...native,
        {
          type: 'function_call_output',
          call_id: 'call-one',
          output: expect.stringContaining('Temporary lookup failure'),
        },
      ]);
    } else {
      expect(requests[0]).toMatchObject({
        max_tokens: 1024,
        cache_control: { type: 'ephemeral' },
        tools: tools.map(({ parameters, ...tool }) => ({
          ...tool,
          input_schema: parameters,
        })),
      });
      expect(requests[1]!.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'task' }] },
        { role: 'assistant', content: native },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-one',
              is_error: true,
              content: expect.stringContaining('Temporary lookup failure'),
            },
          ],
        },
      ]);
    }
  },
);

it('validates provider configuration and credentials without exposing values', () => {
  expect(() =>
    createModel(
      { provider: 'openai', model: 'luna', maxOutputTokens: 1024 },
      {},
    ),
  ).toThrow('OPENAI_API_KEY');
  expect(() =>
    createModel(
      {
        provider: 'anthropic',
        model: 'claude',
        maxOutputTokens: 1024,
        reasoning: 'low',
      },
      { ANTHROPIC_API_KEY: 'secret' },
    ),
  ).toThrow('--reasoning');
  expect(() =>
    createModel(
      { provider: 'openai', model: '', maxOutputTokens: 1024 },
      { OPENAI_API_KEY: 'secret' },
    ),
  ).toThrow();
});

it.each(['incomplete', 'failed'])(
  'does not execute tool calls from an OpenAI %s response but counts usage',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          status,
          usage,
          output: [
            {
              type: 'function_call',
              call_id: 'one',
              name: 'lookup',
              arguments: '{"id":"one"}',
            },
          ],
        }),
      ),
    );
    const call = vi.fn();
    const result = await agentLoop({
      model: createModel(
        { provider: 'openai', model: 'test', maxOutputTokens: 1024 },
        { OPENAI_API_KEY: 'secret' },
      ),
      arm: { tools, call } as unknown as ArmHandle,
      system: 'rules',
      prompt: 'task',
      emit: async () => {},
    });

    expect(call).not.toHaveBeenCalled();
    expect(result.usageComplete).toBe(true);
    expect(result.usage.outputTokens).toBe(12);
    expect(result.stop).toBe(
      status === 'incomplete' ? 'model-output-limit' : 'model-error',
    );
  },
);

it('reports malformed arguments back to the model without invoking the tool', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        status: 'completed',
        usage,
        output: [
          {
            type: 'function_call',
            call_id: 'one',
            name: 'lookup',
            arguments: '{broken',
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        status: 'completed',
        usage,
        output: [
          {
            type: 'function_call',
            call_id: 'submit',
            name: 'submit_answer',
            arguments: JSON.stringify(answer),
          },
        ],
      }),
    );

  vi.stubGlobal('fetch', request);
  const call = vi.fn();
  const result = await agentLoop({
    model: createModel(
      { provider: 'openai', model: 'test', maxOutputTokens: 1024 },
      { OPENAI_API_KEY: 'secret' },
    ),
    arm: { tools, call } as unknown as ArmHandle,
    system: 'rules',
    prompt: 'task',
    emit: async () => {},
  });

  expect(call).not.toHaveBeenCalled();
  expect(result.submission).toEqual(answer);
  expect(
    JSON.parse(request.mock.calls[1]![1].body).input.at(-1).output,
  ).toContain('Invalid JSON object');
});

it.each(['openai', 'anthropic'] as Provider[])(
  'retains a %s provider error with unknown usage and no hidden retry',
  async (provider) => {
    const request = vi.fn(
      async () => new Response('rate limit', { status: 429 }),
    );

    vi.stubGlobal('fetch', request);
    const events: unknown[] = [];
    const result = await agentLoop({
      model: createModel(
        { provider, model: 'test', maxOutputTokens: 1024 },
        { OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret' },
      ),
      arm: { tools, call: vi.fn() } as unknown as ArmHandle,
      system: 'rules',
      prompt: 'task',
      emit: async (e) => {
        events.push(e);
      },
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe('model-error');
    expect(result.usageComplete).toBe(false);
    expect(JSON.stringify(events)).toContain('429');
  },
);
