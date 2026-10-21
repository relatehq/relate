import type { Json } from './index.js';
import type { ComputedResultType } from './analytics.js';

/**
 * A portable scalar value constraint. `relate/model` validates manifests against
 * this shape; discovery reports it for every property and action field.
 */
export interface ScalarSchema {
  readonly type: 'string' | 'number' | 'boolean';
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly format?:
    'timestamp' | 'local-datetime' | 'int32' | 'int64' | undefined;
  readonly precision?: 'second' | 'millisecond' | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly exclusiveMinimum?: number | undefined;
  readonly exclusiveMaximum?: number | undefined;
}

/** A caller option as discovery presents it. */
export interface OptionDescription {
  readonly name: string;
  readonly type: string;
  readonly default?: Json;
  readonly description: string;
}

export interface ObjectSummary {
  readonly definitionId: string;
  readonly apiName: string;
  readonly label: string;
  readonly pluralLabel: string;
  readonly description?: string;
}

export interface ActionSummary {
  readonly definitionId: string;
  readonly apiName: string;
  readonly description?: string;
}

/** One authorized direction of a relationship in the compact graph overview. */
export interface TraversalOverview {
  /** API name of another entry in `GraphDescription.objects`. */
  readonly target: string;
  readonly cardinality: 'one' | 'many';
  readonly description?: string;
}

/** Object purpose and named, executable edges; schemas remain in object detail. */
export interface ObjectOverview {
  readonly description?: string;
  readonly traversals: Readonly<Record<string, TraversalOverview>>;
}

/** Action purpose and the readable object types it declares it creates. */
export interface ActionOverview {
  readonly description?: string;
  readonly creates: readonly string[];
}

/** Read kinds used by option validation and discovery. */
export type ReadOperation = 'get' | 'query' | 'traverse-many' | 'traverse-one';

/** Concise option guidance and the reads that accept it. */
export interface SdkOptionDescription {
  readonly description: string;
  readonly operations: readonly ReadOperation[];
}

/** Compact SDK guidance shared by every graph and actor. */
export interface SdkDescription {
  readonly discovery: { readonly object: string; readonly action: string };
  readonly reads: {
    readonly get: string;
    readonly query: string;
    readonly traverse: string;
  };
  readonly actions: { readonly invoke: string; readonly receipt: string };
  /** Read option names and concise guidance, including defaults. */
  readonly options: Readonly<Record<string, SdkOptionDescription>>;
  readonly results: {
    readonly getOrToOne: string;
    readonly queryOrToMany: string;
    readonly pagination: string;
    readonly evidence: string;
  };
  /** ReadError codes and how to inspect an invalid request. */
  readonly errors: string;
  readonly semantics: readonly string[];
}

export interface GraphDescription {
  readonly definitionId: string;
  /**
   * The compiled model this snapshot describes, as reads report it in
   * `meta.definitionRevision` on successful records. Empty pages, not-found and
   * action receipts do not carry this revision; remote operations must enforce
   * their bound model independently of returned records.
   */
  readonly definitionRevision: string;
  readonly description?: string;
  /** All visible objects, keyed by their SDK/API names. */
  readonly objects: Readonly<Record<string, ObjectOverview>>;
  /** All visible actions, keyed by their SDK/API names. */
  readonly actions: Readonly<Record<string, ActionOverview>>;
  readonly sdk: SdkDescription;
}

export interface PropertyDescription {
  readonly definitionId: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: 'object-id' | 'value' | 'reference';
  readonly schema: ScalarSchema;
  readonly references?: ObjectSummary;
  /** Operand type for this property's `query({ where })` filters, such as `Person object ID`. */
  readonly filter: string;
  /** Operators accepted in this property's where object. */
  readonly filterOperators: readonly string[];
}

/** A declared calculation, with logical result metadata but no authored SQL. */
export interface ComputedPropertyDescription {
  readonly definitionId: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: 'computed';
  readonly schema: ComputedResultType;
  /** Static access to the calculation and all its analytical dependencies. */
  readonly readable: boolean;
  readonly filter: string;
  readonly filterOperators: readonly string[];
}

export type DatasetColumnDescription = ComputedResultType & {
  readonly definitionId: string;
  readonly description?: string;
  readonly readable: boolean;
};

/** An actor-visible association, keyed by its declared SQL name. */
export interface DatasetDescription {
  readonly definitionId: string;
  readonly datasetDefinitionId: string;
  readonly description?: string;
  readonly columns: Readonly<Record<string, DatasetColumnDescription>>;
  /** Omitted when it would disclose an unreadable object property. */
  readonly correlation?: string;
}

export interface ComputeDescription {
  readonly syntax: string;
  readonly aggregates: readonly string[];
  readonly encoding: string;
  readonly identifiers: string;
  readonly filters: string;
  readonly freshness: string;
  readonly example?: string;
}

export interface TraversalDescription {
  readonly relationshipDefinitionId: string;
  readonly name: string;
  readonly description?: string;
  readonly cardinality: 'one' | 'many';
  readonly target: ObjectSummary;
  /** `QueryResult<Target>` for many, `Promise<ObjectResult<Target>>` for one. */
  readonly returns: string;
}

export interface ObjectDescription extends ObjectSummary {
  readonly operations: {
    readonly get: { readonly returns: string };
    readonly query: {
      readonly returns: string;
      readonly collectionScope: 'graph-membership';
    };
  };
  readonly properties: readonly (
    PropertyDescription | ComputedPropertyDescription
  )[];
  readonly traversals: readonly TraversalDescription[];
  readonly datasets?: Readonly<Record<string, DatasetDescription>>;
  readonly compute?: ComputeDescription;
}

export interface ActionFieldDescription {
  readonly name: string;
  readonly description?: string;
  readonly schema: ScalarSchema;
  readonly references?: ObjectSummary;
}

export interface ActionDescription extends ActionSummary {
  readonly input: readonly ActionFieldDescription[];
  readonly output: readonly ActionFieldDescription[];
  readonly errors: Readonly<Record<string, readonly ActionFieldDescription[]>>;
  readonly creates: readonly ObjectSummary[];
}

/**
 * Actor-bound, metadata-only discovery. It is a pure function of one actor
 * snapshot, so a remote consumer can fetch it once and bind it synchronously.
 */
export interface Discovery {
  describe(): GraphDescription;
  describeObject(objectDefinitionId: string): ObjectDescription | undefined;
  describeAction(actionDefinitionId: string): ActionDescription | undefined;
}
