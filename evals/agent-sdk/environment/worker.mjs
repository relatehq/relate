import { createInterface } from 'node:readline';
import { create as createDomain } from 'node:domain';
import { start } from 'node:repl';
import { PassThrough, Writable } from 'node:stream';
import { inspect } from 'node:util';
import ts from 'typescript';
import { createConsumer } from 'relate/consumer';

// Docker is the code-execution boundary. The REPL is an ergonomic notebook,
// not a security boundary. This image contains no world data or grading code.
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map();
let sequence = 0;
let output = '';
let truncated = false;
let submitted;
let rejectEvaluation;
// Node's default REPL evaluator routes thrown errors to its own domain. The
// pinned Node image and recovery tests cover this small Node-specific adapter.

const outputLimit = 24000;
const append = (value) => {
  if (output.length + value.length > outputLimit) truncated = true;

  output = (output + value).slice(0, outputLimit);
};
const repl = start({
  prompt: '',
  input: new PassThrough(),
  output: new Writable({
    write(chunk, _, done) {
      append(String(chunk));
      done();
    },
  }),
  terminal: false,
  ignoreUndefined: true,
});

repl._domain.on('error', (error) => rejectEvaluation?.(error));
const print = (...args) =>
  append(
    `${args.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 12, maxArrayLength: 250, maxStringLength: 20000 }))).join(' ')}\n`,
  );

repl.context.console = { log: print, info: print, warn: print, error: print };
repl.context.submit = (value) => {
  submitted = JSON.parse(JSON.stringify(value));

  return 'Answer submitted.';
};
const rpc = (method, args) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;

    pending.set(id, { resolve, reject });
    send({ type: 'operation', id, method, args });
  });
const redeclarable = () => (file) =>
  ts.factory.updateSourceFile(
    file,
    file.statements.map((statement) =>
      ts.isVariableStatement(statement)
        ? ts.factory.updateVariableStatement(
            statement,
            statement.modifiers,
            ts.factory.createVariableDeclarationList(
              statement.declarationList.declarations,
              ts.NodeFlags.None,
            ),
          )
        : statement,
    ),
  );

async function execute(code) {
  output = '';
  truncated = false;
  submitted = undefined;
  let error = null;

  try {
    const compiled = ts.transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.Preserve,
      },
      transformers: { before: [redeclarable] },
    });

    await new Promise((resolve, reject) => {
      rejectEvaluation = reject;
      const domain = createDomain();

      domain.on('error', reject);
      domain.run(() =>
        repl.eval(compiled.outputText, repl.context, 'cell.ts', (err, value) =>
          err ? reject(err) : resolve(value),
        ),
      );
    });
  } catch (caught) {
    error = `${caught.name}: ${caught.message}`;
    append(`${error}\n`);
  }

  rejectEvaluation = undefined;
  send({
    type: 'result',
    output,
    truncated,
    error,
    ...(submitted !== undefined ? { submitted } : {}),
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);

  if (request.type === 'reply') {
    const waiter = pending.get(request.id);

    if (!waiter) continue;

    pending.delete(request.id);

    if (request.ok) waiter.resolve(request.result);
    else
      waiter.reject(
        Object.assign(new Error(request.error.message), request.error),
      );
  } else if (request.type === 'init') {
    const { routing, overview, objectDetails, actionDetails } =
      request.bootstrap;
    const ops = Object.fromEntries(
      ['get', 'query', 'traverse', 'invoke', 'getReceipt'].map((method) => [
        method,
        (...args) => rpc(method, args),
      ]),
    );

    ops.discovery = {
      describe: () => overview,
      describeObject: (id) => objectDetails[id],
      describeAction: (id) => actionDetails[id],
    };
    repl.context.relate = createConsumer(routing, ops);
    send({ type: 'ready' });
  } else if (request.type === 'execute') {
    // Do not await: RPC replies arrive through this same input loop.
    void execute(request.code);
  }
}

repl.close();
