import { providerRequest } from './request.js';
import type { Model, ModelConfig, Block } from './types.js';
import type { Row } from '../../systems/simulators.js';
import { json } from '../../world/model.js';

export function openaiModel(config: ModelConfig, key: string): Model {
  return {
    name: config.model,
    async complete(input) {
      const items: Row[] = [];

      for (const m of input.messages) {
        if (m.continuation) {
          items.push(...m.continuation);
          continue;
        }

        for (const b of m.content) {
          if (b.type === 'text') items.push({ role: m.role, content: b.text });

          if (b.type === 'tool_call')
            items.push({
              type: 'function_call',
              call_id: b.id,
              name: b.name,
              arguments: json(b.input),
            });

          if (b.type === 'tool_result')
            items.push({
              type: 'function_call_output',
              call_id: b.id,
              output: b.content,
            });
        }
      }

      const raw = (await providerRequest(
        'OpenAI',
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body: json({
            model: config.model,
            store: false,
            include: ['reasoning.encrypted_content'],
            instructions: input.system,
            input: items,
            max_output_tokens: config.maxOutputTokens,
            ...(config.reasoning
              ? { reasoning: { effort: config.reasoning } }
              : {}),
            tools: input.tools.map((tool) => ({
              type: 'function',
              ...tool,
              strict: false,
            })),
          }),
          signal: input.signal,
        },
        input.trace,
      )) as {
        output: Row[];
        status: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          input_tokens_details?: {
            cached_tokens?: number;
            cache_write_tokens?: number;
          };
        };
      };
      const content: Block[] = [];

      for (const item of raw.output ?? []) {
        if (item.type === 'message')
          for (const b of item.content as Row[]) {
            if (b.type === 'output_text')
              content.push({ type: 'text', text: String(b.text) });

            if (b.type === 'refusal')
              content.push({ type: 'text', text: String(b.refusal) });
          }

        if (item.type === 'function_call') {
          let args: Row = {},
            argumentError: string | undefined;

          try {
            const parsed: unknown = JSON.parse(String(item.arguments));

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw Error('Expected an object');

            args = parsed as Row;
          } catch {
            argumentError = 'Invalid JSON object in tool arguments';
          }

          content.push({
            type: 'tool_call',
            id: String(item.call_id),
            name: String(item.name),
            input: args,
            ...(argumentError ? { argumentError } : {}),
          });
        }
      }

      const cacheReadTokens =
        raw.usage?.input_tokens_details?.cached_tokens ?? 0;
      const cacheWriteTokens =
        raw.usage?.input_tokens_details?.cache_write_tokens ?? 0;

      return {
        content,
        continuation: raw.output,
        usage: {
          inputTokens:
            raw.usage?.input_tokens - cacheReadTokens - cacheWriteTokens,
          outputTokens: raw.usage?.output_tokens,
          cacheReadTokens,
          cacheWriteTokens,
        },
        stopReason:
          raw.status === 'completed'
            ? 'complete'
            : raw.status === 'incomplete'
              ? 'limit'
              : 'error',
        raw,
      };
    },
  };
}
