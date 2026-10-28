import { z } from 'zod';
import type { ArmHandle } from './arms.js';
import type { Submission } from '../tasks/grading.js';
import { json } from '../world/model.js';
import type { Row } from '../systems/simulators.js';

import type { Usage, Price, Model, Message, Block } from './providers/types.js';

export type { Usage, Price, Model } from './providers/types.js';

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
        !reply.usage ||
        ![
          reply.usage.inputTokens,
          reply.usage.outputTokens,
          reply.usage.cacheReadTokens,
          reply.usage.cacheWriteTokens,
        ].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error('Model response has no valid token usage');

      usageComplete = true;
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
      usage.cacheReadTokens += reply.usage.cacheReadTokens;
      usage.cacheWriteTokens += reply.usage.cacheWriteTokens;
      assistant += json(reply.content) + '\n';
      messages.push({
        role: 'assistant',
        content: reply.content,
        ...(reply.continuation ? { continuation: reply.continuation } : {}),
      });

      if (reply.stopReason !== 'complete') {
        stop =
          reply.stopReason === 'limit' ? 'model-output-limit' : 'model-error';
        break;
      }

      if (
        controller.signal.aborted ||
        usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens >
          budget.inputTokens
      ) {
        stop = 'budget';
        break;
      }

      const results: Block[] = [];
      let submittedThisTurn = false;

      for (const block of reply.content) {
        if (controller.signal.aborted) {
          submission = undefined;
          stop = 'budget';
          break;
        }

        if (block.type !== 'tool_call') continue;

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
          if (block.argumentError) throw new Error(block.argumentError);

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
        const response: Block = {
          type: 'tool_result',
          id: block.id,
          content: text,
          isError,
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
