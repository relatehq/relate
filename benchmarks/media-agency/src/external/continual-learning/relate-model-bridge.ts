/** Trusted provider bridge. Receives public prompts/tools only, never task answers. */
import { createInterface } from 'node:readline';
import { createModel } from '../../harness/providers/index.js';
import { appendFile } from 'node:fs/promises';

for await (const line of createInterface({ input: process.stdin })) {
  try {
    const input = JSON.parse(line);
    if (
      !Number.isInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 1 ||
      input.maxOutputTokens > 8192
    )
      throw new Error('Invalid remaining output budget');
    const model = createModel({
      provider: 'openai',
      model: 'gpt-6-luna',
      reasoning: 'medium',
      maxOutputTokens: input.maxOutputTokens,
    });
    const reply = await model.complete({
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      signal: AbortSignal.timeout(180_000),
    });
    if (input.transcript)
      await appendFile(
        input.transcript,
        JSON.stringify({ input, reply }) + '\n',
        { mode: 0o600 },
      );
    process.stdout.write(JSON.stringify(reply) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }) + '\n',
    );
  }
}
