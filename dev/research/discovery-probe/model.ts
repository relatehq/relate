/** One model step: at most one code cell, plus the provider items to replay. */
export interface ModelTurn {
  readonly code?: string;
  readonly callId?: string;
  /** Provider output items, appended to the conversation before the cell result. */
  readonly items: readonly unknown[];
  readonly usage: {
    readonly input: number;
    readonly cached: number;
    readonly output: number;
  };
  readonly usd: number;
  readonly seconds: number;
}

export interface Model {
  readonly name: string;
  next(input: readonly unknown[]): Promise<ModelTurn>;
}

const tool = {
  type: 'function',
  name: 'execute_code',
  description:
    'Execute the next code cell in the persistent TypeScript interpreter and return its printed output. Inspect the result before choosing the next cell.',
  strict: true,
  parameters: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
    additionalProperties: false,
  },
};

/** Published per-million-token rates: [input, cached input, output]. */
const rates: Record<string, readonly [number, number, number]> = {
  'gpt-5.4-mini': [0.75, 0.075, 4.5],
  'gpt-5.4-nano': [0.2, 0.02, 1.25],
};

/**
 * OpenAI Responses with one forced `execute_code` call per step. Requests are
 * stateless (`store: false`), so encrypted reasoning is replayed in `items`.
 */
export function openAiModel(options: {
  apiKey: string;
  model: string;
  reasoning: 'none' | 'low' | 'medium';
  maxOutputTokens: number;
}): Model {
  const rate = rates[options.model];

  if (!rate) throw new Error(`No published rate for ${options.model}`);

  return {
    name: options.model,
    async next(input) {
      const started = performance.now();
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          store: false,
          input,
          reasoning: { effort: options.reasoning },
          max_output_tokens: options.maxOutputTokens,
          include: ['reasoning.encrypted_content'],
          tools: [tool],
          tool_choice: { type: 'function', name: 'execute_code' },
          parallel_tool_calls: false,
        }),
        signal: AbortSignal.timeout(180_000),
      });

      if (!response.ok)
        // Never echo request headers; the body is the provider's error only.
        throw new Error(
          `OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`,
        );

      const result = (await response.json()) as {
        output: {
          type: string;
          name?: string;
          call_id?: string;
          arguments?: string;
        }[];
        usage: {
          input_tokens: number;
          output_tokens: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      };
      const calls = result.output.filter(
        (item) => item.type === 'function_call' && item.name === 'execute_code',
      );
      const call = calls.length === 1 ? calls[0]! : undefined;
      const cached = result.usage.input_tokens_details?.cached_tokens ?? 0;
      const usage = {
        input: result.usage.input_tokens,
        cached,
        output: result.usage.output_tokens,
      };

      return {
        ...(call
          ? {
              code: (JSON.parse(call.arguments!) as { code: string }).code,
              callId: call.call_id!,
            }
          : {}),
        items: result.output,
        usage,
        usd:
          ((usage.input - cached) * rate[0] +
            cached * rate[1] +
            usage.output * rate[2]) /
          1_000_000,
        seconds: (performance.now() - started) / 1000,
      };
    },
  };
}

/** Plays fixed cells in order, for testing the probe without a provider. */
export function scriptedModel(cells: readonly string[]): Model {
  let index = 0;

  return {
    name: 'scripted',
    async next() {
      const code = cells[index];
      const callId = `call_${index++}`;

      return {
        ...(code !== undefined ? { code, callId } : {}),
        items:
          code !== undefined
            ? [
                {
                  type: 'function_call',
                  name: 'execute_code',
                  call_id: callId,
                  arguments: JSON.stringify({ code }),
                },
              ]
            : [],
        usage: { input: 0, cached: 0, output: 0 },
        usd: 0,
        seconds: 0,
      };
    },
  };
}
