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

/** One projection defines both advertised metadata and executable routes. */
function projectBinding(binding: GraphBinding): BindingSnapshot {
  const overview = binding.operations.discovery.describe();
  const source = binding.description;

  if (
    source.formatVersion !== 1 ||
    source.graphDefinitionId !== overview.definitionId ||
    source.definitionRevision !== overview.definitionRevision
  )
    throw new Error('Consumer description does not match the operations model');

  const objects: Record<string, ObjectDescription> = Object.create(null);
  const actions: Record<string, ActionDescription> = Object.create(null);
  const routes = Object.entries(source.objects).filter(([name, route]) => {
    if (!Object.hasOwn(overview.objects, name)) return false;

    const detail = binding.operations.discovery.describeObject(
      route.definitionId,
    );

    if (!detail) return false;

    objects[route.definitionId] = detail;

    return true;
  });
  const names = new Set(routes.map(([name]) => name));
  const objectRoutes = Object.fromEntries(
    routes.map(([name, route]) => {
      const detail = objects[route.definitionId]!;
      const traversals = Object.fromEntries(
        Object.entries(route.traversals).filter(
          ([edge, target]) =>
            names.has(target.target) &&
            Object.hasOwn(overview.objects[name]!.traversals, edge) &&
            detail.traversals.some((item) => item.name === edge),
        ),
      );

      objects[route.definitionId] = {
        ...detail,
        traversals: detail.traversals.filter((edge) =>
          Object.hasOwn(traversals, edge.name),
        ),
      };

      return [name, { definitionId: route.definitionId, traversals }];
    }),
  );
  const actionRoutes = Object.fromEntries(
    Object.entries(source.actions).filter(([name, route]) => {
      if (!Object.hasOwn(overview.actions, name)) return false;

      const detail = binding.operations.discovery.describeAction(
        route.definitionId,
      );

      if (!detail) return false;

      actions[route.definitionId] = {
        ...detail,
        creates: detail.creates.filter((object) => names.has(object.apiName)),
        adopts: detail.adopts.filter((object) => names.has(object.apiName)),
      };

      return true;
    }),
  );

  return {
    description: { ...source, objects: objectRoutes, actions: actionRoutes },
    overview: {
      ...overview,
      objects: Object.fromEntries(
        Object.entries(objectRoutes).map(([name, route]) => [
          name,
          {
            ...overview.objects[name],
            traversals: Object.fromEntries(
              Object.entries(route.traversals).map(([edge, target]) => [
                edge,
                {
                  ...overview.objects[name]!.traversals[edge],
                  ...target,
                },
              ]),
            ),
          },
        ]),
      ),
      actions: Object.fromEntries(
        Object.keys(actionRoutes).map((name) => [
          name,
          {
            ...overview.actions[name],
            creates: overview.actions[name]!.creates.filter((target) =>
              names.has(target),
            ),
            adopts: overview.actions[name]!.adopts.filter((target) =>
              names.has(target),
            ),
          },
        ]),
      ),
    },
    objects,
    actions,
  };
}

/** Discovery needs the projection, but neither a facade nor a deep IPC snapshot. */
export function describeBinding(binding: GraphBinding): GraphDescription {
  return projectBinding(binding).overview;
}

/** Only actor-visible routing crosses IPC; discovery never grants authorization. */
export function snapshotBinding(binding: GraphBinding): BindingSnapshot {
  return structuredClone(projectBinding(binding));
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
