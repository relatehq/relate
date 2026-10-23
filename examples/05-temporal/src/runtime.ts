import { createRuntime } from '@relate/node';
import { createPostgresStore } from '@relate/postgres';
import { graph, implementations } from './model.js';

export async function openRelate(connectionString: string, graphId: string) {
  const store = createPostgresStore({ connectionString });

  try {
    await store.migrate();
    const relate = createRuntime({
      graph,
      graphId,
      store,
      bindings: [],
      actionImplementations: implementations,
    });

    return {
      relate,
      async close() {
        await relate.close();
        await store.close();
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
