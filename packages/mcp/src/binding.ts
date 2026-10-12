import { createConsumer } from 'relate/consumer';
import type {
  ActionDescription,
  GraphDescription,
  ObjectDescription,
} from '@relate/protocol';
import type { GraphBinding } from './executor.js';

export interface BindingSnapshot {
  description: GraphBinding['description'];
  overview: GraphDescription;
  objects: Record<string, ObjectDescription>;
  actions: Record<string, ActionDescription>;
}

/** Only actor-visible routing crosses IPC; discovery never grants authorization. */
export function snapshotBinding(binding: GraphBinding): BindingSnapshot {
  // Validate the host's complete artifact before projecting visible routes.
  createConsumer(binding.description, binding.operations);
  const overview = binding.operations.discovery.describe();
  const objects: Record<string, ObjectDescription> = Object.create(null);
  const actions: Record<string, ActionDescription> = Object.create(null);
  const routes = Object.entries(binding.description.objects).filter(
    ([name, route]) => {
      if (!Object.hasOwn(overview.objects, name)) return false;

      const detail = binding.operations.discovery.describeObject(
        route.definitionId,
      );

      if (!detail) return false;

      objects[route.definitionId] = detail;

      return true;
    },
  );
  const names = new Set(routes.map(([name]) => name));
  const description: GraphBinding['description'] = {
    ...binding.description,
    objects: Object.fromEntries(
      routes.map(([name, route]) => [
        name,
        {
          definitionId: route.definitionId,
          traversals: Object.fromEntries(
            Object.entries(route.traversals).filter(
              ([edge, target]) =>
                names.has(target.target) &&
                objects[route.definitionId]!.traversals.some(
                  (item) => item.name === edge,
                ),
            ),
          ),
        },
      ]),
    ),
    actions: Object.fromEntries(
      Object.entries(binding.description.actions).filter(([name, route]) => {
        if (!Object.hasOwn(overview.actions, name)) return false;

        const detail = binding.operations.discovery.describeAction(
          route.definitionId,
        );

        if (!detail) return false;

        actions[route.definitionId] = detail;

        return true;
      }),
    ),
  };

  return structuredClone({ description, overview, objects, actions });
}

export function snapshotDiscovery(snapshot: BindingSnapshot) {
  return {
    describe: () => snapshot.overview,
    describeObject: (id: string) =>
      Object.hasOwn(snapshot.objects, id) ? snapshot.objects[id] : undefined,
    describeAction: (id: string) =>
      Object.hasOwn(snapshot.actions, id) ? snapshot.actions[id] : undefined,
  };
}
