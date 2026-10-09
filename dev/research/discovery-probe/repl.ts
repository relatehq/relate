// A persistent TypeScript REPL for one episode, and the consumer instrumentation.
import { create as createDomain } from 'node:domain';
import { start } from 'node:repl';
import { PassThrough, Writable } from 'node:stream';
import { inspect } from 'node:util';
import ts from 'typescript';

export interface CallRecord {
  readonly path: string;
  error?: string;
}

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const outputLimit = 14_000;

/**
 * Mirror the consumer tree with logging wrappers. Frozen SDK objects cannot be
 * proxied with different values, so this builds a parallel frozen tree and
 * keeps each operation's own `toString`/inspect behaviour.
 */
export function instrument<T>(value: T, path: string, log: CallRecord[]): T {
  if (typeof value === 'function') {
    const original = value as unknown as (...args: unknown[]) => unknown;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const entry: CallRecord = { path };
      const fail = (error: unknown) => {
        entry.error =
          error instanceof Error
            ? `${error.name}: ${error.message.split('\n')[0]}`
            : String(error);
      };

      log.push(entry);

      try {
        const result = Reflect.apply(original, this, args);

        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        )
          (result as PromiseLike<unknown>).then(undefined, fail);

        return result;
      } catch (error) {
        fail(error);
        throw error;
      }
    };

    Object.defineProperty(wrapped, 'name', { value: original.name });
    Object.defineProperty(wrapped, 'toString', {
      value: Object.hasOwn(original, 'toString')
        ? () => String(original)
        : () => Function.prototype.toString.call(original),
    });

    if (Object.hasOwn(original, inspectSymbol))
      Object.defineProperty(wrapped, inspectSymbol, {
        value: () => inspect(original),
      });

    for (const key of Object.keys(original))
      Object.defineProperty(wrapped, key, {
        value: instrument(
          (original as unknown as Record<string, unknown>)[key],
          `${path}.${key}`,
          log,
        ),
        enumerable: true,
      });

    return Object.freeze(wrapped) as unknown as T;
  }

  if (value && typeof value === 'object')
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          instrument(child, path ? `${path}.${key}` : key, log),
        ]),
      ),
    ) as T;

  return value;
}

/**
 * Top-level `const`/`let` become `var`, so a later cell can reuse a name as in
 * a notebook. Otherwise a redeclaration costs a turn, which measures REPL
 * habits rather than discovery.
 */
const redeclarable: ts.TransformerFactory<ts.SourceFile> = () => (file) =>
  ts.factory.updateSourceFile(
    file,
    file.statements.map((statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.BlockScoped
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

export function createRepl() {
  let output = '';
  const repl = start({
    prompt: '',
    input: new PassThrough(),
    output: new Writable({
      write(chunk, _, done) {
        output += String(chunk);
        done();
      },
    }),
    terminal: false,
    useGlobal: false,
    ignoreUndefined: true,
  });

  // Keep lexical persistence and top-level await; expose no host capabilities.
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

  const print = (...args: unknown[]) => {
    output +=
      args
        .map((x) =>
          typeof x === 'string'
            ? x
            : inspect(x, { depth: 8, maxArrayLength: 200 }),
        )
        .join(' ') + '\n';
  };

  repl.context.console = { log: print, info: print, warn: print, error: print };

  async function evaluate(code: string) {
    // Transpile TypeScript syntax only; cells are not typechecked.
    const compiled = ts.transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.Preserve,
      },
      reportDiagnostics: true,
      transformers: { before: [redeclarable] },
    });
    const errors = compiled.diagnostics?.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );

    if (errors?.length)
      throw new SyntaxError(
        ts.formatDiagnostics(errors, {
          getCanonicalFileName: (x) => x,
          getCurrentDirectory: () => '',
          getNewLine: () => '\n',
        }),
      );

    return new Promise((resolve, reject) => {
      // The REPL evaluator routes async failures through the active domain.
      const domain = createDomain();

      domain.on('error', reject);
      domain.run(() =>
        repl.eval(
          compiled.outputText,
          repl.context,
          'cell.ts',
          (error, value) => (error ? reject(error) : resolve(value)),
        ),
      );
    });
  }

  return {
    context: repl.context,
    async run(code: string) {
      output = '';
      let error: string | null = null;

      try {
        await evaluate(code);
      } catch (caught) {
        error =
          caught instanceof Error
            ? `${caught.name}: ${caught.message}`
            : String(caught);
        output += `${error}\n`;
      }

      if (output.length > outputLimit)
        output = `${output.slice(0, outputLimit)}\n[output truncated]\n`;

      return { output, error };
    },
    close: () => repl.close(),
  };
}
