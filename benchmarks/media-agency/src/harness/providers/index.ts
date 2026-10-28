import { z } from 'zod';
import { anthropicModel } from './anthropic.js';
import { openaiModel } from './openai.js';
import type { ModelConfig, Model } from './types.js';

export const modelConfigSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']),
    model: z.string().trim().min(1),
    maxOutputTokens: z.number().int().positive().default(8192),
    reasoning: z
      .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
      .optional(),
  })
  .strict()
  .refine((c) => c.provider === 'openai' || c.reasoning === undefined, {
    message: '--reasoning is supported only by the OpenAI adapter',
  });

const providers = {
  anthropic: { key: 'ANTHROPIC_API_KEY', create: anthropicModel },
  openai: { key: 'OPENAI_API_KEY', create: openaiModel },
} as const;

/** Credentials are supplied separately and never enter the manifest. */
export function createModel(
  config: ModelConfig,
  env: Record<string, string | undefined> = process.env,
): Model {
  const parsed = modelConfigSchema.parse(config);
  const provider = providers[parsed.provider];
  const key = env[provider.key];

  if (!key?.trim())
    throw new Error(
      `${provider.key} is required for ${parsed.provider} model runs`,
    );

  return provider.create(parsed, key);
}
