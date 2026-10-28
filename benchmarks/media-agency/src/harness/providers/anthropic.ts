import { providerRequest } from './request.js';
import type { Model, ModelConfig, Block } from './types.js';
import type { Row } from '../../systems/simulators.js';
import { json } from '../../world/model.js';

export function anthropicModel(config: ModelConfig, key: string): Model {
  return {
    name: config.model,
    async complete(input) {
      const raw = (await providerRequest(
        'Anthropic',
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: json({
            model: config.model,
            max_tokens: config.maxOutputTokens,
            cache_control: { type: 'ephemeral' },
            system: input.system,
            messages: input.messages.map((m) => ({
              role: m.role,
              content:
                m.continuation ??
                m.content.map((b) => {
                  if (b.type === 'tool_call')
                    return {
                      type: 'tool_use',
                      id: b.id,
                      name: b.name,
                      input: b.input,
                    };

                  if (b.type === 'tool_result')
                    return {
                      type: 'tool_result',
                      tool_use_id: b.id,
                      content: b.content,
                      is_error: b.isError,
                    };

                  return b;
                }),
            })),
            tools: input.tools.map(({ parameters, ...tool }) => ({
              ...tool,
              input_schema: parameters,
            })),
          }),
          signal: input.signal,
        },
        input.trace,
      )) as {
        content: Row[];
        stop_reason: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      const content: Block[] = [];

      for (const b of raw.content) {
        if (b.type === 'text')
          content.push({ type: 'text', text: String(b.text) });

        if (b.type === 'tool_use')
          content.push({
            type: 'tool_call',
            id: String(b.id),
            name: String(b.name),
            input: b.input as Row,
          });
      }

      return {
        content,
        continuation: raw.content,
        usage: {
          inputTokens: raw.usage?.input_tokens,
          outputTokens: raw.usage?.output_tokens,
          cacheReadTokens: raw.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: raw.usage?.cache_creation_input_tokens ?? 0,
        },
        stopReason:
          raw.stop_reason === 'max_tokens'
            ? 'limit'
            : ['end_turn', 'tool_use', 'stop_sequence'].includes(
                  raw.stop_reason,
                )
              ? 'complete'
              : 'error',
        raw,
      };
    },
  };
}
