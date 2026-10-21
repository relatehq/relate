import type { AppDefinition, GraphDefinition, ObjectRegistry } from 'relate';
import { createRuntime } from './runtime.js';
import type { Relate } from './types.js';
import type { Principal } from '@relate/runtime';

type Graph = GraphDefinition & { readonly objects: ObjectRegistry };

/**
 * Run `setup` once, compose the runtime and own the cleanup registered for
 * this start. Setup or compilation failure releases resources already
 * registered before rethrowing. `close()` drains operations, then disposes.
 */
export async function startApp<G extends Graph>(
  app: AppDefinition<G>,
): Promise<Relate<G>> {
  const disposers: (() => void | Promise<void>)[] = [];
  const dispose = async () => {
    const failures: unknown[] = [];

    for (const entry of disposers.splice(0).reverse()) {
      try {
        await entry();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length === 1) throw failures[0];

    if (failures.length)
      throw new AggregateError(failures, 'Application cleanup failed');
  };
  let runtime: Relate<G>;

  try {
    const bindings = app.setup
      ? await app.setup({
          onDispose(entry) {
            if (typeof entry !== 'function')
              throw new Error('onDispose requires a function');

            disposers.push(entry);
          },
        })
      : { bindings: [] };

    const analytical =
      Object.keys(app.graph.datasets ?? {}).length > 0 ||
      Object.values(app.graph.objects ?? {}).some((object) =>
        Object.values(object?.properties ?? {}).some(
          (property) => property?.origin?.kind === 'computed',
        ),
      );
    // Ordinary apps do not import or initialize the parser implementation.
    const sqlParser = analytical
      ? await (await import('@relate/sql-parser')).createSqlParser()
      : undefined;

    runtime = createRuntime({
      ...bindings,
      graph: app.graph,
      ...(sqlParser ? { sqlParser } : {}),
    });
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Application startup and cleanup failed',
      );
    }

    throw error;
  }

  return Object.freeze({
    as: (principal: Principal) => runtime.as(principal),
    operations: (
      principal: Principal,
      context?: Parameters<Relate<G>['operations']>[1],
    ) => runtime.operations(principal, context),
    host: runtime.host,
    async close() {
      await runtime.close();
      await dispose();
    },
  });
}
