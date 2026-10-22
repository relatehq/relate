import type { Binding, DatasetBinding, GraphDefinition } from 'relate';
import type { CompiledModel } from 'relate/model';
import type { LogicalType } from 'relate/analytics';
import type {
  AnalyticalConnector,
  PhysicalSchema,
  SourceBinding,
} from 'relate/connectors';
import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import { leaseConnectionQueue } from './connection-queues.js';
import type { RuntimeOptions } from '@relate/runtime';
import type { StatementQueue, StatementQueueOptions } from '@relate/runtime';

export interface BoundDataset {
  readonly binding: DatasetBinding;
  readonly connector: AnalyticalConnector;
  readonly queue: StatementQueue;
}

/** One host generation owns these queues; application setup owns connections. */
export interface HostBindings {
  readonly sources: Readonly<Record<string, SourceBinding>>;
  readonly datasets: ReadonlyMap<string, BoundDataset>;
  readonly analyticalBinding: NonNullable<
    RuntimeOptions['analytics']
  >['binding'];
  describe(): Promise<void>;
  retire(): Promise<void>;
}

function sameLogicalType(left: LogicalType, right: LogicalType): boolean {
  return (
    left.type === right.type &&
    (left.type !== 'timestamp' ||
      (right.type === 'timestamp' && left.precision === right.precision))
  );
}

function validateSchema(
  dataset: NonNullable<CompiledModel['manifest']['datasets']>[number],
  schema: PhysicalSchema,
): void {
  const failures: string[] = [];

  for (const column of dataset.columns) {
    const physical =
      schema?.columns && Object.hasOwn(schema.columns, column.name)
        ? schema.columns[column.name]
        : undefined;

    if (!physical) failures.push(`${column.name}: physical column is missing`);
    else if (
      !Array.isArray(physical.supportedTypes) ||
      !physical.supportedTypes.some(
        (type) => type && sameLogicalType(type, column.schema),
      )
    )
      failures.push(
        `${column.name}: physical type cannot represent the declared ${column.schema.type}`,
      );
    else if (
      typeof physical.nullable !== 'boolean' ||
      (!column.schema.nullable && physical.nullable)
    )
      failures.push(
        `${column.name}: physical nullability does not satisfy the declaration`,
      );
  }

  if (failures.length)
    throw new Error(
      `Invalid dataset binding ${dataset.apiName}: ${failures.join('; ')}`,
    );
}

/** Validate every supplied definition/capability before opening any resource. */
export function bindHostResources(
  graph: GraphDefinition,
  model: CompiledModel,
  bindings: readonly Binding[],
  queueOptions: StatementQueueOptions = {},
): HostBindings {
  const bindingSecret = randomBytes(32);
  const sources: Record<string, SourceBinding> = {};
  const datasets = new Map<string, BoundDataset>();
  const connections = new Map<string, object>();
  const queues = new Map<object, StatementQueue>();
  const sourceDefinitions = new Set(
    Object.values(graph.objects).flatMap((object) =>
      'resource' in object.membership ? [object.membership.resource] : [],
    ),
  );
  const datasetDefinitions = new Set(Object.values(graph.datasets ?? {}));

  if (!Array.isArray(bindings))
    throw new Error('Application bindings must be an array');

  try {
    for (const binding of bindings) {
      if (
        !binding ||
        typeof binding !== 'object' ||
        typeof binding.connectionId !== 'string' ||
        !binding.connectionId.trim() ||
        typeof binding.resourceId !== 'string' ||
        !binding.resourceId.trim()
      )
        throw new Error('Invalid resource binding identity');

      const connection =
        binding.connection ??
        ('connector' in binding ? binding.connector : undefined);

      if (
        !connection ||
        typeof connection !== 'object' ||
        (binding.connection &&
          binding.connection.connectionId !== binding.connectionId)
      )
        throw new Error('Invalid configured connection identity');

      const existing = connections.get(binding.connectionId);

      if (existing && existing !== connection)
        throw new Error(
          'Conflicting instances for configured connection identity',
        );

      connections.set(binding.connectionId, connection);

      if ('dataset' in binding) {
        if (!datasetDefinitions.has(binding.dataset))
          throw new Error('Unregistered dataset binding');

        if (datasets.has(binding.dataset.id))
          throw new Error('Duplicate dataset binding');

        const connector = binding.connection.analytics;

        if (
          !connector ||
          ['describe', 'parameterBudget', 'plan', 'execute'].some(
            (method) =>
              typeof connector[method as keyof AnalyticalConnector] !==
              'function',
          ) ||
          !Number.isSafeInteger(connector.limits?.maxParameters) ||
          connector.limits.maxParameters < 1 ||
          (connector.limits.maxConcurrentStatements !== undefined &&
            (!Number.isSafeInteger(connector.limits.maxConcurrentStatements) ||
              connector.limits.maxConcurrentStatements < 1)) ||
          !binding.resource ||
          typeof binding.resource !== 'object'
        )
          throw new Error('Missing or unsupported analytical capability');

        let queue = queues.get(connection);

        if (!queue) {
          queue = leaseConnectionQueue(
            connection,
            queueOptions,
            connector.limits.maxConcurrentStatements,
          );
          queues.set(connection, queue);
        }

        datasets.set(
          binding.dataset.id,
          Object.freeze({
            binding: Object.freeze({
              ...binding,
              columns: Object.freeze({ ...binding.columns }),
            }),
            connector,
            queue,
          }),
        );
      } else {
        if (!sourceDefinitions.has(binding.source))
          throw new Error('Unregistered source connection');

        if (Object.hasOwn(sources, binding.source.id))
          throw new Error('Duplicate source connection');

        Object.defineProperty(sources, binding.source.id, {
          value: binding,
          enumerable: true,
        });
      }
    }

    for (const definition of datasetDefinitions)
      if (!datasets.has(definition.id))
        throw new Error('Missing dataset binding');
  } catch (error) {
    for (const queue of queues.values()) void queue.retire();

    throw error;
  }

  let retired = false;
  const controller = new AbortController();

  return Object.freeze({
    sources: Object.freeze(sources),
    datasets,
    analyticalBinding(datasetId: string) {
      const dataset = datasets.get(datasetId);

      if (!dataset) throw new Error('Missing analytical binding');

      return {
        resource: dataset.binding.resource,
        connector: dataset.connector,
        queue: dataset.queue,
        bindingRevision: `hmac-sha256:${createHmac('sha256', bindingSecret)
          .update(
            canonicalJson({
              connectionId: dataset.binding.connectionId,
              resourceId: dataset.binding.resourceId,
              columns: dataset.binding.columns,
            }),
          )
          .digest('hex')}`,
      };
    },
    async describe() {
      for (const dataset of model.manifest.datasets ?? []) {
        controller.signal.throwIfAborted();
        const entry = datasets.get(dataset.id)!;
        let schema: PhysicalSchema;

        try {
          schema = await entry.queue.run(
            (signal) =>
              entry.connector.describe(entry.binding.resource, { signal }),
            { signal: controller.signal },
          );
        } catch (cause) {
          throw new Error(
            `Could not inspect dataset binding ${dataset.apiName}`,
            { cause },
          );
        }

        controller.signal.throwIfAborted();
        validateSchema(dataset, schema);
      }
    },
    async retire() {
      if (!retired) {
        retired = true;
        controller.abort();
      }

      await Promise.all([...queues.values()].map((queue) => queue.retire()));
    },
  });
}
