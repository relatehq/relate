// The control protocol is host-only. Agent cells receive the actual SDK consumer.
import { create as createDomain } from 'node:domain';
import { createInterface } from 'node:readline';
import { start } from 'node:repl';
import { PassThrough, Writable } from 'node:stream';
import { inspect } from 'node:util';
import ts from 'typescript';
import { createSdkSnapshot } from './sdk-graph.mjs';

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let output = '';
const repl = start({
  prompt: '',
  input: new PassThrough(),
  output: new Writable({
    write(chunk, _, done) {
      output += chunk.toString();
      done();
    },
  }),
  terminal: false,
  useGlobal: false,
  ignoreUndefined: true,
});

// Keep the REPL's lexical persistence and top-level await, but expose no host secrets.
for (const name of [
  'process',
  'require',
  'module',
  '__filename',
  '__dirname',
  'fetch',
])
  Object.defineProperty(repl.context, name, {
    value: undefined,
    configurable: false,
  });

const print = (...args) => {
  output +=
    args
      .map((x) =>
        typeof x === 'string'
          ? x
          : inspect(x, {
              depth: null,
              maxArrayLength: null,
              maxStringLength: null,
            }),
      )
      .join(' ') + '\n';
};

repl.context.console = { log: print, info: print, warn: print, error: print };
let snapshot;
let nextCall = 0;
const pending = new Map();

// Task submission is shared by both Node modes. SDK mode has no app API proxy.
repl.context.completeTask = (options = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextCall;

    pending.set(id, { resolve, reject });
    send({ type: 'complete', id, options });
  });

async function evaluate(code) {
  // Transpile TS syntax only. This is an execution REPL, not a typechecker.
  const compiled = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.Preserve,
    },
    reportDiagnostics: true,
  });
  const errors = compiled.diagnostics?.filter(
    (x) => x.category === ts.DiagnosticCategory.Error,
  );

  if (errors?.length)
    throw new SyntaxError(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => '',
        getNewLine: () => '\n',
      }),
    );

  return new Promise((resolve, reject) => {
    // Node's default REPL evaluator routes runtime failures through the active
    // domain rather than its callback. Keep them as recoverable cell errors.
    const domain = createDomain();

    domain.on('error', reject);
    domain.run(() =>
      repl.eval(
        compiled.outputText,
        repl.context,
        'agent-cell.ts',
        (error, value) => {
          if (error) reject(error);
          else resolve(value);
        },
      ),
    );
  });
}

const lines = createInterface({ input: process.stdin });
let busy = false;

lines.on('line', async (line) => {
  const message = JSON.parse(line);

  if (message.type === 'completion-result' || message.type === 'api-result') {
    const waiter = pending.get(message.id);

    pending.delete(message.id);

    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message.result);

    return;
  }

  if (busy) {
    send({ type: 'error', error: 'Concurrent cells are not supported' });

    return;
  }

  busy = true;

  try {
    if (message.type === 'init') {
      if (message.mode === 'sdk') {
        snapshot = await createSdkSnapshot(message.rows);
        repl.context.relate = snapshot.consumer;
      } else if (message.mode === 'raw_ts') {
        repl.context.tokens = message.tokens;
        repl.context.apis = new Proxy(
          {},
          {
            get: (_, app) =>
              new Proxy(
                {},
                {
                  get:
                    (_, api) =>
                    (args = {}) =>
                      new Promise((resolve, reject) => {
                        const id = ++nextCall;
                        pending.set(id, { resolve, reject });
                        send({ type: 'api', id, app, api, args });
                      }),
                },
              ),
          },
        );
      } else throw new Error('Unknown Node mode');
      output = '';
      send({ type: 'ready', snapshot_fetches: snapshot?.fetchCount() ?? 0 });
    } else if (message.type === 'execute') {
      output = '';
      const before = snapshot?.fetchCount() ?? 0;
      let error = null;

      try {
        await evaluate(message.code);
      } catch (caught) {
        error = `${caught.name}: ${caught.message}`;
        output += error + '\n';
      }

      send({
        type: 'result',
        output,
        error,
        snapshot_fetches: (snapshot?.fetchCount() ?? 0) - before,
      });
    } else if (message.type === 'close') {
      await snapshot?.close();
      repl.close();
      send({ type: 'closed' });
      lines.close();
      process.stdin.pause();
    } else throw new Error('Unknown host command');
  } catch (error) {
    send({ type: 'error', error: `${error.name}: ${error.message}` });
  } finally {
    busy = false;
  }
});
