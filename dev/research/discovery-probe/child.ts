// Child process for one episode. The host spawns it without credentials and
// under Node's permission model; the JSON-lines control protocol on
// stdin/stdout is never visible to agent code.
import { createInterface } from 'node:readline';
import { startDesk } from './desk.js';
import { goals } from './goals.js';
import { createRepl, instrument, type CallRecord } from './repl.js';
import { loadSdk } from './sdk.js';

async function main() {
  const send = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value)}\n`);
  const repl = createRepl();
  const calls: CallRecord[] = [];
  let submitted: { value: unknown } | undefined;
  let close: (() => Promise<void>) | undefined;

  repl.context.submit = (value: unknown) => {
    submitted = { value: structuredClone(value) };

    return 'Answer submitted.';
  };

  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line) as
      | { type: 'init'; checkout: string; goal: string }
      | { type: 'execute'; code: string }
      | { type: 'close' };

    try {
      if (message.type === 'init') {
        const desk = await startDesk(await loadSdk(message.checkout));
        const goal = goals.find((g) => g.id === message.goal)!;

        close = desk.close;
        repl.context.relate = instrument(desk.consumer, '', calls);
        send({ type: 'ready', truth: await goal.truth(desk.consumer) });
      } else if (message.type === 'execute') {
        const before = calls.length;

        submitted = undefined;
        const { output, error } = await repl.run(message.code);

        // Let rejected handles record their errors before reporting the cell.
        await new Promise((resolve) => setImmediate(resolve));
        send({
          type: 'result',
          output,
          error,
          calls: calls.slice(before),
          ...(submitted ? { submitted } : {}),
        });
      } else {
        await close?.();
        repl.close();
        send({ type: 'closed' });

        return;
      }
    } catch (error) {
      send({
        type: 'error',
        error: error instanceof Error ? error.stack : String(error),
      });
    }
  }
}

await main();
