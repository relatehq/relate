import type { Json } from './index.js';

/**
 * A portable scalar value constraint. `relate/model` validates manifests against
 * this shape; discovery reports it for every property and action field.
 */
export interface ScalarSchema {
  readonly type: 'string' | 'number' | 'boolean';
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly format?: 'timestamp' | undefined;
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

/** How to call one read operation, independent of graph and actor. */
export interface OperationContract {
  readonly signature: string;
  readonly returns: string;
  readonly description: string;
  /** Accepted option names; each is described once in `OperationContracts.options`. */
  readonly options: readonly string[];
}

/**
 * The SDK-owned read contract. It is the same for every graph and actor; each
 * object's description supplies the concrete names, types and calls.
 */
export interface OperationContracts {
  readonly get: OperationContract;
  readonly query: OperationContract & {
    readonly collectionScope: 'graph-membership';
  };
  readonly traverse: {
    readonly description: string;
    readonly many: OperationContract;
    readonly one: OperationContract;
  };
  /** Every read option, described once. */
  readonly options: readonly OptionDescription[];
  /** Result and value shapes named by `returns` and option types. */
  readonly shapes: {
    readonly ObjectId: string;
    readonly ObjectResult: string;
    readonly ObjectRecord: string;
    readonly ReadMeta: string;
    readonly Page: string;
    readonly QueryResult: string;
  };
  readonly errors: string;
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

export interface GraphDescription {
  readonly definitionId: string;
  readonly description?: string;
  readonly objects: readonly ObjectSummary[];
  readonly actions: readonly ActionSummary[];
  /** How to call get, query and traversals; the same for every graph. */
  readonly operations: OperationContracts;
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
  readonly properties: readonly PropertyDescription[];
  readonly traversals: readonly TraversalDescription[];
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
