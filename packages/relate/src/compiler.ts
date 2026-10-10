import { createHash } from 'node:crypto';
import type { ConsumerDescription } from './consumer.js';
import type { ConsumerRoutingDescription } from './consumer-description.js';
import type { z } from 'zod';
import type {
  GraphDefinition,
  ObjectDefinition,
  ObjectRegistry,
  Property,
} from './index.js';
import { referenceSchemas } from './schema.js';
import { actionKeys } from './actions.js';
import { portable } from './portable-schema.js';
import type { Claim, ActorField, ObjectRule } from './authorization.js';
import { canonicalJson, deepFreeze, validateManifest } from './model.js';
import type { CompiledModel, ScalarSchema } from './model.js';
import { CompileError, ManifestValidationError } from './diagnostics.js';
import type { ModelIssue, ModelIssueCode } from './diagnostics.js';

export { CompileError } from './diagnostics.js';

export type {
  IssuePath,
  ModelIssue,
  ModelIssueCode,
  SourceSite,
} from './diagnostics.js';

type Segment = string | number;

/** Thrown inside one validation unit to skip the checks that depend on it. */
class Skip extends Error {}

class Collector {
  readonly issues: ModelIssue[] = [];

  report(
    code: ModelIssueCode,
    message: string,
    segments: readonly Segment[],
    definitionId?: string,
  ): void {
    this.issues.push({
      code,
      message,
      ...(definitionId !== undefined ? { definitionId } : {}),
      path: { root: 'graph', segments: [...segments] },
    });
  }

  fail(
    code: ModelIssueCode,
    message: string,
    segments: readonly Segment[],
    definitionId?: string,
  ): never {
    this.report(code, message, segments, definitionId);
    throw new Skip();
  }

  /** Run one independent unit; a `Skip` ends that unit only. */
  unit<T>(work: () => T): T | undefined {
    try {
      return work();
    } catch (error) {
      if (error instanceof Skip) return undefined;

      throw error;
    }
  }
}

function schemaIssue(schema: z.ZodType): string | undefined {
  try {
    portable(schema);

    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Omits absent descriptions so manifests keep exact optional properties. */
function described(description: string | undefined) {
  return description !== undefined ? { description } : {};
}

// Presentation only: this value never determines API addressing or identity.
function humanize(apiName: string): string {
  const words = apiName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function registryKey(
  objects: ObjectRegistry,
  object: ObjectDefinition,
): string | undefined {
  return Object.entries(objects).find(([, o]) => o === object)?.[0];
}

/** Compile once; the consumer artifact is projected only from the validated manifest. */
export function compile<G extends GraphDefinition>(
  graph: G,
): CompiledModel & {
  readonly consumer: ConsumerDescription<G>;
} {
  // Explicitly typed so `fail()` narrows as a `never`-returning assertion.
  const issues: Collector = new Collector();

  if (
    !graph ||
    typeof graph !== 'object' ||
    Array.isArray(graph.objects) ||
    Array.isArray(graph.policies) ||
    !graph.objects ||
    typeof graph.objects !== 'object' ||
    !graph.policies ||
    typeof graph.policies !== 'object'
  )
    throw new CompileError([
      {
        code: 'graph.invalid-shape',
        message: 'Objects and policies must be keyed registries',
        path: { root: 'graph', segments: [] },
      },
    ]);

  if (
    !graph.access ||
    typeof graph.access !== 'object' ||
    !Array.isArray(graph.access.roles) ||
    !Array.isArray(graph.access.fieldGroups) ||
    !graph.access.claims ||
    typeof graph.access.claims !== 'object'
  )
    throw new CompileError([
      {
        code: 'graph.invalid-shape',
        message: 'Graph access must declare roles, field groups and claims',
        path: { root: 'graph', segments: ['access'] },
      },
    ]);

  // Registry names are consumer API names; stable definition IDs own persistence.
  const entries = Object.entries(graph.objects).filter(([name, object]) => {
    if (
      !object ||
      typeof object !== 'object' ||
      !object.properties ||
      !object.membership
    ) {
      issues.report(
        'graph.invalid-shape',
        `Object ${name} is not an object definition`,
        ['objects', name],
      );

      return false;
    }

    return true;
  });
  const validNames = new Set(entries.map(([name]) => name));
  const objects = entries.map(([, object]) => object);
  const resources = new Map<
    string,
    {
      id: string;
      idField: string;
      fields: Record<string, ScalarSchema>;
    }
  >();
  const claims: Record<string, ScalarSchema> = {};

  for (const [name, claim] of Object.entries(graph.access.claims)) {
    const problem = schemaIssue(claim.schema);

    if (problem)
      issues.report('schema.unsupported', `${problem} Claim ${name}.`, [
        'access',
        'claims',
        name,
      ]);
    else claims[name] = portable(claim.schema);
  }

  const roles = new Set(graph.access.roles);
  const policyPath = (name: string, ...rest: Segment[]) => [
    'policies',
    name,
    ...rest,
  ];

  for (const [name, object] of entries) {
    issues.unit(() => {
      const at = (...segments: Segment[]) => ['objects', name, ...segments];

      if (!object || typeof object !== 'object' || !object.properties)
        issues.fail(
          'graph.invalid-shape',
          `Object ${name} is not an object definition`,
          at(),
        );

      for (const [propertyName, property] of Object.entries(
        object.properties,
      )) {
        if (
          property.access !== undefined &&
          property.access?.kind !== 'field-group'
        )
          issues.report(
            'property.invalid-field-group',
            `Invalid field group reference on property ${name}.${propertyName}`,
            at('properties', propertyName, 'access'),
            object.id,
          );

        const problem = schemaIssue(property.schema);

        if (problem)
          issues.report(
            'schema.unsupported',
            `${problem} Property ${name}.${propertyName}.`,
            at('properties', propertyName, 'schema'),
            object.id,
          );

        if (
          property.origin.kind === 'reference' ||
          property.origin.kind === 'native-reference'
        ) {
          const targetId = property.origin.targetObjectDefinitionId;

          // Registry membership is by ID here; relationships check identity.
          if (!objects.some((o) => o.id === targetId))
            issues.report(
              'reference.invalid-target',
              `Property ${name}.${propertyName} references unregistered object '${targetId}'`,
              at('properties', propertyName),
              object.id,
            );
        }
      }

      const identities = Object.values(object.properties).filter(
        (p) => p.origin.kind === 'object-id',
      ).length;

      if (identities !== 1)
        issues.report(
          'object.object-id-count',
          `Object '${object.id}' requires exactly one objectId() property; found ${identities}`,
          at('properties'),
          object.id,
        );

      if (!('resource' in object.membership)) {
        if (object.membership.kind !== 'native')
          issues.fail(
            'object.unsupported-membership',
            `Unsupported membership on object ${name}`,
            at('membership'),
            object.id,
          );

        return;
      }

      const resource = object.membership.resource;

      // Object-level refinements would otherwise be lost during field extraction.
      if (resource.schema.def.checks?.length || resource.schema.def.catchall)
        issues.fail(
          'schema.unsupported',
          `Unsupported source record refinement on source '${resource.id}' used by ${name}`,
          at('membership', 'resource', 'schema'),
          object.id,
        );

      const fields: Record<string, ScalarSchema> = {};

      for (const [field, schema] of Object.entries(resource.schema.shape)) {
        const problem = schemaIssue(schema);

        if (problem)
          issues.fail(
            'schema.unsupported',
            `${problem} Source '${resource.id}' field '${field}'.`,
            at('membership', 'resource', 'schema', field),
            object.id,
          );

        fields[field] = portable(schema);
      }

      const compiled = { id: resource.id, idField: resource.idField, fields };
      const prior = resources.get(resource.id);

      if (prior && canonicalJson(prior) !== canonicalJson(compiled))
        issues.fail(
          'source.conflicting-definitions',
          `Conflicting source definitions for '${resource.id}' between objects`,
          at('membership', 'resource'),
          object.id,
        );

      resources.set(resource.id, compiled);
    });
  }

  const objectIds = new Map<string, string>();
  let ambiguous = false;

  for (const [name, object] of entries) {
    const prior = objectIds.get(object.id);

    if (prior !== undefined) {
      ambiguous = true;
      issues.report(
        'definition.duplicate-id',
        `Duplicate object definition '${object.id}' registered as ${prior} and ${name}`,
        ['objects', name],
        object.id,
      );
    } else objectIds.set(object.id, name);

    if (!Object.hasOwn(graph.policies, name))
      issues.report(
        'policy.missing',
        `Missing policy: ${name}`,
        policyPath(name),
        object.id,
      );
  }

  // Policies are keyed by object ID; duplicates would make their ownership a guess.
  if (ambiguous) throw new CompileError(issues.issues);

  const paths = (
    object: ObjectDefinition,
    input: unknown,
    label: string,
    segments: readonly Segment[],
    path: readonly Property[] = [],
  ): readonly {
    readonly path: readonly Property[];
    readonly claim: Claim | ActorField;
  }[] => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !Object.keys(input).length ||
      path.length >= 16
    )
      issues.fail(
        'policy.invalid-predicate',
        `Invalid policy predicate in policy ${label}`,
        segments,
      );

    return Object.entries(input).flatMap(([name, value]) => {
      const property = Object.hasOwn(object.properties, name)
        ? object.properties[name]
        : undefined;
      const owner = registryKey(graph.objects, object) ?? object.id;

      if (!property)
        issues.fail(
          'policy.unknown-dependency',
          `Unknown policy dependency '${name}' on ${owner} in policy ${label}`,
          [...segments, name],
        );

      const next = [...path, property];

      if (
        property.origin.kind === 'reference' ||
        property.origin.kind === 'native-reference'
      ) {
        const targetId = property.origin.targetObjectDefinitionId;
        const target = objects.find((o) => o.id === targetId);

        if (!target)
          issues.fail(
            'reference.invalid-target',
            `Unknown reference target in policy registry: ${owner}.${name} references '${targetId}' in policy ${label}`,
            [...segments, name],
          );

        return paths(target, value, label, [...segments, name], next);
      }

      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).length !== 1 ||
        !('eq' in value) ||
        !value.eq ||
        typeof value.eq !== 'object' ||
        !('kind' in value.eq) ||
        !['claim', 'actor-field'].includes(String(value.eq.kind))
      )
        issues.fail(
          'policy.invalid-predicate',
          `Invalid policy predicate on ${owner}.${name} in policy ${label}`,
          [...segments, name],
        );

      return [{ path: next, claim: value.eq as Claim | ActorField }];
    });
  };
  const compileRule = (
    name: string,
    object: ObjectDefinition,
    rule: ObjectRule<string, unknown>,
    segments: readonly Segment[],
    label: string,
  ) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      Object.keys(rule).some(
        (key) => !['gate', 'where', 'evidenceMaxAgeMs'].includes(key),
      )
    )
      issues.fail(
        'policy.invalid-rule',
        `Invalid policy read rule for ${label}`,
        segments,
        object.id,
      );

    if (rule.gate?.kind !== 'role')
      issues.fail(
        'policy.unsupported-gate',
        `Unsupported policy gate in policy ${label}`,
        [...segments, 'gate'],
        object.id,
      );

    if (!roles.has(rule.gate.role))
      issues.report(
        'policy.unknown-role',
        `Unknown policy role '${rule.gate.role}' in policy ${label}`,
        [...segments, 'gate'],
        object.id,
      );

    const hasWhere = Object.hasOwn(rule, 'where');

    if (
      hasWhere
        ? typeof rule.evidenceMaxAgeMs !== 'number'
        : Object.hasOwn(rule, 'evidenceMaxAgeMs')
    )
      issues.fail(
        'policy.invalid-rule',
        `Predicates require an evidence bound; role-only rules omit it: policy ${label}`,
        [...segments, 'evidenceMaxAgeMs'],
        object.id,
      );

    const conditions = hasWhere
      ? paths(object, rule.where, label, [...segments, 'where'])
      : undefined;

    for (const { claim } of conditions ?? []) {
      if (claim.kind === 'actor-field') {
        if ((claim.name as string) !== 'id')
          issues.fail(
            'policy.unknown-actor-field',
            `Unknown actor field '${String(claim.name)}' in policy ${label}`,
            [...segments, 'where'],
            object.id,
          );

        continue;
      }

      const declared = Object.hasOwn(graph.access.claims, claim.name)
        ? graph.access.claims[claim.name]
        : undefined;

      if (!declared)
        issues.fail(
          'policy.unknown-claim',
          `Unknown policy claim '${claim.name}' in policy ${label}`,
          [...segments, 'where'],
          object.id,
        );

      if (!Object.hasOwn(claims, claim.name)) continue;

      const problem = schemaIssue(claim.schema);

      if (problem)
        issues.fail(
          'schema.unsupported',
          `${problem} Policy claim ${claim.name}.`,
          [...segments, 'where'],
          object.id,
        );

      if (
        canonicalJson(claims[claim.name]) !==
        canonicalJson(portable(claim.schema))
      )
        issues.fail(
          'policy.incompatible-claim',
          `Conflicting policy reference: claim '${claim.name}' in policy ${label} does not match the graph's declared claim`,
          [...segments, 'where'],
          object.id,
        );
    }

    return {
      role: rule.gate.role,
      ...(conditions
        ? {
            where: {
              all: conditions.map(({ path, claim }) => ({
                path: path.map((p) => p.id),
                ...(claim.kind === 'actor-field'
                  ? { actor: 'id' }
                  : { claim: claim.name }),
              })),
            },
          }
        : {}),
      evidenceMaxAgeMs: rule.evidenceMaxAgeMs ?? 0,
    };
  };
  const createPolicies: Record<string, unknown> = {};
  const policies: Record<string, unknown> = {};

  for (const [name, policy] of Object.entries(graph.policies)) {
    issues.unit(() => {
      if (!Object.hasOwn(graph.objects, name))
        issues.fail(
          'policy.unknown-object',
          `Unknown policy object '${name}'`,
          policyPath(name),
        );

      if (!validNames.has(name)) return;

      const object = graph.objects[name]!;

      if (
        !policy ||
        typeof policy !== 'object' ||
        Object.keys(policy).some(
          (key) => !['read', 'create', 'groups'].includes(key),
        )
      )
        issues.fail(
          'policy.invalid-rule',
          `Unsupported policy for ${name}`,
          policyPath(name),
          object.id,
        );

      if (policy.create !== undefined) {
        if ('resource' in object.membership)
          issues.fail(
            'policy.create-requires-native-membership',
            `Create policy requires native membership: ${name} is owned by source '${object.membership.resource.id}'`,
            policyPath(name, 'create'),
            object.id,
          );

        if (policy.create !== 'deny')
          createPolicies[object.id] = compileRule(
            name,
            object,
            policy.create,
            policyPath(name, 'create'),
            `${name}.create`,
          );
      }

      if (policy.read === 'deny') {
        if (Object.hasOwn(policy, 'groups'))
          issues.fail(
            'policy.invalid-group',
            `Denied reads cannot grant field groups: policy ${name}`,
            policyPath(name, 'groups'),
            object.id,
          );

        return;
      }

      for (const [group, gate] of Object.entries(policy.groups ?? {})) {
        if (gate?.kind !== 'role')
          issues.fail(
            'policy.unsupported-gate',
            `Unsupported policy gate in policy ${name}.groups.${group}`,
            policyPath(name, 'groups', group),
            object.id,
          );

        if (!roles.has(gate.role))
          issues.report(
            'policy.unknown-role',
            `Unknown policy role '${gate.role}' in policy ${name}.groups.${group}`,
            policyPath(name, 'groups', group),
            object.id,
          );
      }

      policies[object.id] = {
        read: compileRule(
          name,
          object,
          policy.read,
          policyPath(name, 'read'),
          `${name}.read`,
        ),
        groups: Object.fromEntries(
          Object.entries(policy.groups ?? {}).map(([group, gate]) => [
            group,
            { role: gate!.role },
          ]),
        ),
      };
    });
  }

  const actionShape = (
    schema: z.ZodType,
    segments: readonly Segment[],
    label: string,
    actionId: string,
  ) => {
    if (
      schema.def.type !== 'object' ||
      ('checks' in schema.def && schema.def.checks?.length) ||
      (schema as z.ZodObject).def.catchall
    )
      issues.fail(
        'schema.unsupported',
        `Actions require unrefined object schemas with scalar fields in this slice: ${label}`,
        segments,
        actionId,
      );

    return Object.fromEntries(
      Object.entries((schema as z.ZodObject).shape).map(([name, field]) => {
        const references = referenceSchemas.get(field.def);
        const description = field.description;

        if (references)
          return [
            name,
            {
              type: 'string',
              nullable: false,
              optional: false,
              references,
              ...described(description),
            },
          ];

        const problem = schemaIssue(field);

        if (problem)
          issues.fail(
            'schema.unsupported',
            `${problem} Action field ${label}.${name}.`,
            segments,
            actionId,
          );

        return [
          name,
          {
            ...portable(field),
            ...described(description),
          },
        ];
      }),
    );
  };
  const actions = Object.entries(graph.actions ?? {}).flatMap(
    ([apiName, action]) => {
      const compiled = issues.unit(() => {
        const at = (...segments: Segment[]) => [
          'actions',
          apiName,
          ...segments,
        ];

        if (Object.keys(action).some((key) => !actionKeys.includes(key)))
          issues.fail(
            'action.invalid-shape',
            `Unsupported action option on action ${apiName}`,
            at(),
            action.id,
          );

        if (
          action.policy &&
          (Object.keys(action.policy).some((key) => key !== 'execute') ||
            action.policy.execute?.kind !== 'role')
        )
          issues.fail(
            'policy.unsupported-gate',
            `Unsupported action policy on action ${apiName}`,
            at('policy'),
            action.id,
          );

        if (action.policy && !roles.has(action.policy.execute.role))
          issues.report(
            'policy.unknown-role',
            `Unknown action role '${action.policy.execute.role}' on action ${apiName}`,
            at('policy', 'execute'),
            action.id,
          );

        if (action.creates.some((object) => !objects.includes(object)))
          issues.fail(
            'action.invalid-capability',
            `Unregistered action capability on action ${apiName}`,
            at('creates'),
            action.id,
          );

        return {
          id: action.id,
          apiName,
          ...described(action.description),
          input: actionShape(
            action.input,
            at('input'),
            `${apiName}.input`,
            action.id,
          ),
          output: actionShape(
            action.output,
            at('output'),
            `${apiName}.output`,
            action.id,
          ),
          ...(Object.keys(action.errors ?? {}).length
            ? {
                errors: Object.fromEntries(
                  Object.entries(action.errors ?? {}).map(([code, schema]) => [
                    code,
                    actionShape(
                      schema,
                      at('errors', code),
                      `${apiName}.errors.${code}`,
                      action.id,
                    ),
                  ]),
                ),
              }
            : {}),
          creates: action.creates.map((o) => o.id).sort(),
          ...(action.policy
            ? { execute: { role: action.policy.execute.role } }
            : {}),
        };
      });

      return compiled ? [compiled] : [];
    },
  );

  actions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const relationshipEntries = Object.entries(graph.relationships ?? {});

  for (const [name, relationship] of relationshipEntries) {
    // Erased JavaScript callers can pass partial relationship objects.
    const from = relationship?.from as ObjectDefinition | undefined;
    const to = relationship?.to as ObjectDefinition | undefined;
    const via = relationship?.via;
    const through = relationship?.through;
    const registeredReference = (
      property: typeof via,
      owner: ObjectDefinition | undefined,
      target: ObjectDefinition | undefined,
    ) =>
      Boolean(
        property &&
        owner &&
        target &&
        objects.includes(owner) &&
        property.owner === owner &&
        property.target === target &&
        Object.values(owner.properties).includes(property) &&
        (property.origin.kind === 'reference' ||
          property.origin.kind === 'native-reference'),
      );
    const valid = through
      ? !via &&
        through.from !== through.to &&
        through.from?.owner === through.to?.owner &&
        registeredReference(through.from, through.from?.owner, from) &&
        registeredReference(through.to, through.from?.owner, to)
      : registeredReference(via, to, from);

    if (
      !from ||
      !to ||
      !objects.includes(from) ||
      !objects.includes(to) ||
      !valid
    )
      issues.report(
        'relationship.invalid-endpoints',
        `Unregistered relationship endpoint or reference: relationship ${name} ('${relationship?.id}') connects '${from?.id}' to '${to?.id}' ${through ? `through '${through.from?.owner?.id}' references '${through.from?.id}' and '${through.to?.id}'` : `via '${via?.id}'`}`,
        ['relationships', name],
        typeof relationship?.id === 'string' ? relationship.id : undefined,
      );
  }

  if (issues.issues.length) throw new CompileError(issues.issues);

  const relationships = relationshipEntries.map(([, r]) => r);
  const manifestInput = {
    formatVersion: 6,
    graphDefinitionId: graph.id,
    ...described(graph.description),
    fieldGroups: [...graph.access.fieldGroups].sort(),
    roles: [...graph.access.roles].sort(),
    claims,
    sources: [...resources.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    objects: entries
      .map(([apiName, o]) => ({
        id: o.id,
        apiName,
        label: o.label ?? humanize(apiName),
        pluralLabel: o.pluralLabel ?? o.label ?? humanize(apiName),
        ...described(o.description),
        ...('resource' in o.membership
          ? { sourceDefinitionId: o.membership.resource.id }
          : {}),
        properties: Object.entries(o.properties)
          .map(([name, p]) => ({
            id: p.id,
            name,
            ...described(p.description),
            access: p.access === undefined ? 'ordinary' : p.access.name,
            schema: portable(p.schema),
            origin: p.origin,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ...(relationships.length
      ? {
          relationships: relationshipEntries
            .map(([, r]) => ({
              id: r.id,
              fromObjectDefinitionId: r.from.id,
              toObjectDefinitionId: r.to.id,
              ...(r.through
                ? {
                    through: {
                      objectDefinitionId: r.through.from.owner.id,
                      fromReferencePropertyDefinitionId: r.through.from.id,
                      toReferencePropertyDefinitionId: r.through.to.id,
                    },
                  }
                : { referencePropertyDefinitionId: r.via.id }),
              forward: r.forward,
              reverse: r.reverse,
            }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        }
      : {}),
    policies,
    ...(Object.keys(createPolicies).length ? { createPolicies } : {}),
    ...(actions.length ? { actions } : {}),
  };

  let manifest;

  try {
    manifest = validateManifest(manifestInput);
  } catch (error) {
    if (error instanceof ManifestValidationError)
      throw new CompileError(
        error.issues.map((issue) =>
          translate(issue, graph, manifestInput, relationshipEntries),
        ),
      );

    throw error;
  }

  const definitionRevision = `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
  // Validation above guarantees unique names, registered endpoints and safe keys.
  const consumerObjects = Object.fromEntries(
    manifest.objects.map((object) => [
      object.apiName,
      {
        definitionId: object.id,
        traversals: {} as Record<
          string,
          { cardinality: 'one' | 'many'; target: string }
        >,
      },
    ]),
  );
  const names = new Map(
    manifest.objects.map((object) => [object.id, object.apiName]),
  );

  for (const relationship of manifest.relationships ?? []) {
    const from = names.get(relationship.fromObjectDefinitionId)!;
    const to = names.get(relationship.toObjectDefinitionId)!;

    consumerObjects[from]!.traversals[relationship.forward.name] = {
      cardinality: relationship.forward.cardinality,
      target: to,
    };
    consumerObjects[to]!.traversals[relationship.reverse.name] = {
      cardinality: relationship.reverse.cardinality,
      target: from,
    };
  }

  const consumer: ConsumerRoutingDescription = {
    formatVersion: 1,
    graphDefinitionId: manifest.graphDefinitionId,
    definitionRevision,
    objects: consumerObjects,
    actions: Object.fromEntries(
      (manifest.actions ?? []).map((action) => [
        action.apiName,
        { definitionId: action.id },
      ]),
    ),
  };

  return deepFreeze({
    manifest,
    definitionRevision,
    consumer: consumer as ConsumerDescription<G>,
  });
}

/**
 * Map a Manifest-rooted issue back to the authored graph. Untranslatable paths
 * keep their explicit Manifest root; nothing is guessed.
 */
function translate(
  issue: ModelIssue,
  graph: GraphDefinition,
  manifest: {
    objects: readonly {
      id: string;
      apiName: string;
      properties: readonly { id: string; name: string }[];
    }[];
    relationships?: readonly { id: string }[];
    actions?: readonly { id: string; apiName: string }[];
  },
  relationshipEntries: readonly (readonly [string, { id: string }])[],
): ModelIssue {
  if (!issue.path || issue.path.root !== 'manifest') return issue;

  const [head, second, third, fourth, fifth, ...rest] = issue.path.segments;
  const authored = (segments: readonly Segment[]): ModelIssue => ({
    ...issue,
    path: { root: 'graph', segments: [...segments] },
  });
  const apiNameOf = (objectId: unknown) => {
    const matches = manifest.objects.filter((o) => o.id === objectId);

    return matches.length === 1 ? matches[0]!.apiName : undefined;
  };

  switch (head) {
    case 'graphDefinitionId':
      return authored(['id']);
    case 'fieldGroups':
    case 'roles':
    case 'claims':
      return authored(['access', head, ...issue.path.segments.slice(1)]);
    case 'objects': {
      const object =
        typeof second === 'number' ? manifest.objects[second] : undefined;

      if (!object || !Object.hasOwn(graph.objects, object.apiName))
        return issue;

      if (third === 'apiName') return authored(['objects', object.apiName]);

      if (third === 'properties' && typeof fourth === 'number') {
        const property = object.properties[fourth];

        if (!property) return issue;

        return authored([
          'objects',
          object.apiName,
          'properties',
          property.name,
          ...(fifth !== undefined ? [fifth] : []),
          ...rest,
        ]);
      }

      return authored([
        'objects',
        object.apiName,
        ...issue.path.segments.slice(2),
      ]);
    }
    case 'relationships': {
      const relationship =
        typeof second === 'number'
          ? manifest.relationships?.[second]
          : undefined;
      const keys = relationshipEntries.filter(
        ([, r]) => r.id === relationship?.id,
      );

      if (!relationship || keys.length !== 1) return issue;

      return authored([
        'relationships',
        keys[0]![0],
        ...issue.path.segments.slice(2),
      ]);
    }
    case 'policies':
    case 'createPolicies': {
      const apiName = apiNameOf(second);

      if (apiName === undefined || !Object.hasOwn(graph.policies, apiName))
        return issue;

      const base = ['policies', apiName];
      const ruleSegments =
        head === 'policies'
          ? third === 'read'
            ? ['read', fourth, fifth, ...rest]
            : third === 'groups'
              ? ['groups', fourth]
              : [third]
          : ['create', third, fourth, fifth, ...rest];
      const [rule, field] = ruleSegments;

      const present = ruleSegments.filter(
        (segment): segment is Segment => segment !== undefined,
      );

      if (rule === 'groups') return authored([...base, ...present]);

      if (field === 'role') return authored([...base, rule!, 'gate']);

      if (field === 'where') return authored([...base, rule!, 'where']);

      return authored([...base, ...present]);
    }
    case 'actions': {
      const action =
        typeof second === 'number' ? manifest.actions?.[second] : undefined;

      if (!action || !Object.hasOwn(graph.actions ?? {}, action.apiName))
        return issue;

      if (third === 'input' || third === 'output')
        return authored(['actions', action.apiName, third]);

      if (third === 'execute')
        return authored(['actions', action.apiName, 'policy', 'execute']);

      return authored([
        'actions',
        action.apiName,
        ...issue.path.segments.slice(2),
      ]);
    }
    default:
      return issue;
  }
}
