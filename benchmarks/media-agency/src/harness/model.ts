import { z } from 'zod';
import type { ArmHandle } from './arms.js';
import type { Submission } from '../tasks/grading.js';
import { json } from '../world/model.js';
import type { Row } from '../systems/simulators.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelReply {
  content: Row[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: Row[];
}

export interface Model {
  name: string;
  complete(input: {
    system: string;
    messages: Message[];
    tools: ArmHandle['tools'];
    signal: AbortSignal;
  }): Promise<ModelReply>;
}

/** Thin Messages API adapter. No hidden retries; errors retain the attempted run. */
export function anthropicModel(name: string, key: string): Model {
  if (!key) throw new Error('ANTHROPIC_API_KEY is required for model runs');

  return {
    name,
    async complete(input) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: json({
          model: name,
          max_tokens: 8192,
          cache_control: { type: 'ephemeral' },
          system: input.system,
          messages: input.messages,
          tools: input.tools,
        }),
        signal: input.signal,
      });

      if (!response.ok)
        throw new Error(
          `Messages API HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`,
        );

      return (await response.json()) as ModelReply;
    },
  };
}

export const defaultBudgets = {
  turns: 40,
  inputTokens: 3000000,
  wallMs: 15 * 60000,
};

export const submissionSchema = z
  .object({
    answer: z.json(),
    refused: z
      .object({ reason: z.string().min(1) })
      .strict()
      .optional(),
    caveats: z.array(
      z.object({ kind: z.string(), detail: z.string() }).strict(),
    ),
  })
  .strict();

export async function agentLoop(input: {
  model: Model;
  arm: ArmHandle;
  system: string;
  prompt: string;
  emit: (event: Row) => Promise<void>;
  budgets?: typeof defaultBudgets;
}) {
  const budget = input.budgets ?? defaultBudgets;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), budget.wallMs);
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: input.prompt }] },
  ];
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let submission: Submission | undefined,
    turns = 0,
    toolCalls = 0,
    bytesReturnedByTools = 0,
    modelMs = 0,
    toolMs = 0,
    stop = 'gave-up';
  let usageComplete = true;
  let assistant = '',
    tools = '';

  try {
    for (; turns < budget.turns;) {
      if (controller.signal.aborted) {
        stop = 'budget';
        break;
      }

      const start = performance.now();

      usageComplete = false;
      const reply = await input.model.complete({
        system: input.system,
        messages,
        tools: input.arm.tools,
        signal: controller.signal,
      });

      modelMs += performance.now() - start;
      turns++;
      await input.emit({ type: 'model', reply });

      if (
        !Number.isSafeInteger(reply.usage?.input_tokens) ||
        !Number.isSafeInteger(reply.usage?.output_tokens) ||
        reply.usage.input_tokens < 0 ||
        reply.usage.output_tokens < 0 ||
        ![
          reply.usage.cache_read_input_tokens ?? 0,
          reply.usage.cache_creation_input_tokens ?? 0,
        ].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error('Model response has no token usage');

      usageComplete = true;
      usage.inputTokens += reply.usage.input_tokens;
      usage.outputTokens += reply.usage.output_tokens;
      usage.cacheReadTokens += reply.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += reply.usage.cache_creation_input_tokens ?? 0;
      assistant += json(reply.content) + '\n';
      messages.push({ role: 'assistant', content: reply.content });

      if (
        controller.signal.aborted ||
        usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens >
          budget.inputTokens
      ) {
        stop = 'budget';
        break;
      }

      const results: Row[] = [];
      let submittedThisTurn = false;

      for (const block of reply.content) {
        if (controller.signal.aborted) {
          submission = undefined;
          stop = 'budget';
          break;
        }

        if (block.type !== 'tool_use') continue;

        if (submittedThisTurn) {
          submission = undefined;
          stop = 'invalid-after-submit';
          break;
        }

        toolCalls++;
        const start = performance.now();
        let result: unknown,
          isError = false;

        try {
          if (block.name === 'submit_answer') {
            submission = submissionSchema.parse(block.input);
            submittedThisTurn = true;
            stop = 'submitted';
            result = { accepted: true };
          } else
            result = await input.arm.call(
              String(block.name),
              block.input as Row,
              controller.signal,
            );
        } catch (error) {
          result = { error: String(error) };
          isError = true;
        }

        toolMs += performance.now() - start;
        const text = json(result);

        bytesReturnedByTools += Buffer.byteLength(text);
        tools += text + '\n';
        const response = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: text,
          is_error: isError,
        };

        results.push(response);
        await input.emit({
          type: 'tool',
          name: block.name,
          input: block.input,
          result,
          isError,
        });
      }

      if (submittedThisTurn) break;

      if (!results.length) {
        stop = 'gave-up';
        break;
      }

      messages.push({ role: 'user', content: results });
    }

    if (!submission && turns >= budget.turns) stop = 'budget';
  } catch (error) {
    stop = controller.signal.aborted ? 'budget' : 'model-error';
    await input.emit({ type: 'error', error: String(error) });
  } finally {
    clearTimeout(timer);
  }

  return {
    submission,
    usage,
    usageComplete,
    turns,
    toolCalls,
    bytesReturnedByTools,
    modelMs,
    toolMs,
    stop,
    transcript: { assistant, tools },
  };
}

export function cost(usage: Usage, price?: Price) {
  if (!price) return { costUsd: null, costUsdUncached: null };

  return {
    costUsd:
      (usage.inputTokens * price.input +
        usage.outputTokens * price.output +
        usage.cacheReadTokens * price.cacheRead +
        usage.cacheWriteTokens * price.cacheWrite) /
      1e6,
    costUsdUncached:
      ((usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) *
        price.input +
        usage.outputTokens * price.output) /
      1e6,
  };
}
