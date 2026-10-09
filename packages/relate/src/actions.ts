import type { z } from 'zod';
import type {
  EvidenceMode,
  SucceededReceipt,
  FailedReceipt,
} from '@relate/protocol';
import type {
  GraphDefinition,
  ObjectDefinition,
  ObjectId,
  PropertyNames,
  PropertyValue,
  NativeMembership,
} from './index.js';
import type { RoleGate } from './authorization.js';
import type {
  ObjectResult,
  ReadOptions,
  QueryOptions,
  QueryResult,
  ObjectRecord,
} from './operations.js';
import { CompileError } from './diagnostics.js';
import { recordProvenance } from './provenance.js';

export const actionKeys: readonly string[] = Object.freeze([
  'id',
  'description',
  'input',
  'output',
  'creates',
  'policy',
  'errors',
]);

type NativeObject = ObjectDefinition & {
  readonly membership: NativeMembership;
};

export interface ActionDefinition<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
  Creates extends readonly NativeObject[] = readonly NativeObject[],
  Errors extends Readonly<Record<string, z.ZodType>> = Readonly<
    Record<string, z.ZodType>
  >,
> {
  readonly id: string;
  /** Explanatory text for people, documentation, and agents. */
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly creates: Creates;
  readonly errors: Errors;
  readonly policy?: { readonly execute: RoleGate };
}

/** Synchronous native action with optional declared business failures. */
export function defineAction<
  const Id extends string,
  Input extends z.ZodType,
  Output extends z.ZodType,
  const Creates extends readonly NativeObject[],
  const Errors extends Readonly<Record<string, z.ZodType>> = {},
>(definition: {
  id: Id;
  description?: string;
  input: Input;
  output: Output;
  creates: Creates;
  errors?: Errors;
  policy?: { readonly execute: RoleGate };
}): ActionDefinition<Input, Output, Creates, Errors> & { readonly id: Id } {
  const unsupported = Object.keys(definition).filter(
    (key) => !actionKeys.includes(key),
  );

  if (unsupported.length)
    throw new CompileError([
      {
        code: 'action.invalid-shape',
        message: `Unsupported action option ${unsupported.map((key) => `'${key}'`).join(', ')} on action '${definition.id}'`,
        definitionId: definition.id,
        path: { root: 'definition', segments: [unsupported[0]!] },
      },
    ]);

  return recordProvenance(
    Object.freeze({
      ...definition,
      errors: Object.freeze({ ...definition.errors }),
      creates: Object.freeze([...definition.creates]),
    }),
  ) as ActionDefinition<Input, Output, Creates, Errors> & { readonly id: Id };
}

export type NativeValues<O extends ObjectDefinition> = {
  [
    K in keyof O['properties'] as O['properties'][K]['origin']['kind'] extends
      'native' | 'native-reference'
      ? K
      : never
  ]: O['properties'][K] extends { references: string }
    ? PropertyValue<O, K>
    : z.input<O['properties'][K]['schema']>;
};

export interface ActionContext<
  G extends GraphDefinition,
  A extends ActionDefinition,
> {
  readonly actor: {
    readonly id: string;
    readonly roles: readonly string[];
    readonly claims: Readonly<Record<string, string | number | boolean | null>>;
  };
  readonly input: z.output<A['input']>;
  /** Aborts this invocation and rolls back native writes, even if caught by the handler. */
  readonly fail: (
    ...args: {
      [Code in keyof A['errors'] & string]: [
        code: Code,
        details: Record<string, unknown> & z.input<A['errors'][Code]>,
      ];
    }[keyof A['errors'] & string]
  ) => never;
  readonly objects: {
    readonly [K in keyof G['objects']]: {
      query<
        N extends PropertyNames<G['objects'][K]> = PropertyNames<
          G['objects'][K]
        >,
      >(
        options: QueryOptions<G['objects'][K], N, 'full'> & {
          readonly evidence: 'full';
        },
      ): QueryResult<ObjectRecord<G['objects'][K], N, 'full'>>;
      query<
        N extends PropertyNames<G['objects'][K]> = PropertyNames<
          G['objects'][K]
        >,
        E extends EvidenceMode = 'compact',
      >(
        options?: QueryOptions<G['objects'][K], N, E>,
      ): QueryResult<ObjectRecord<G['objects'][K], N, E | 'compact'>>;
      get<
        N extends PropertyNames<G['objects'][K]> = PropertyNames<
          G['objects'][K]
        >,
      >(
        id: ObjectId<G['objects'][K]['id']>,
        options: ReadOptions<N, 'full'> & { readonly evidence: 'full' },
      ): Promise<ObjectResult<G['objects'][K], N, 'full'>>;
      get<
        N extends PropertyNames<G['objects'][K]> = PropertyNames<
          G['objects'][K]
        >,
        E extends EvidenceMode = 'compact',
      >(
        id: ObjectId<G['objects'][K]['id']>,
        options?: ReadOptions<N, E>,
      ): Promise<ObjectResult<G['objects'][K], N, E | 'compact'>>;
    } & (G['objects'][K] extends A['creates'][number]
      ? {
          create(
            values: NativeValues<G['objects'][K]>,
          ): Promise<{ readonly id: ObjectId<G['objects'][K]['id']> }>;
        }
      : {});
  };
}

export interface ActionImplementation<
  G extends GraphDefinition = GraphDefinition,
  A extends ActionDefinition = ActionDefinition,
> {
  readonly graph: G;
  readonly action: A;
  readonly implementation: (
    context: ActionContext<G, A>,
  ) => Promise<z.input<A['output']>>;
}

export function implementAction<
  G extends GraphDefinition & {
    readonly actions: Readonly<Record<string, ActionDefinition>>;
  },
  A extends G['actions'][keyof G['actions']],
>(
  graph: G,
  action: A,
  execute: (
    context: ActionContext<NoInfer<G>, NoInfer<A>>,
  ) => Promise<z.input<A['output']>>,
): ActionImplementation<G, A> {
  if (!Object.values(graph.actions).includes(action))
    throw new Error('Unregistered action implementation');

  return Object.freeze({ graph, action, implementation: execute });
}

/** Actions without declared errors retain a success-only result type. */
export type Receipt<A extends ActionDefinition> =
  | SucceededReceipt<z.output<A['output']>>
  | {
      [Code in keyof A['errors'] & string]: FailedReceipt<
        Code,
        z.output<A['errors'][Code]>
      >;
    }[keyof A['errors'] & string];

export type ActionRequest<A extends ActionDefinition> = {
  readonly input: z.input<A['input']>;
  readonly idempotencyKey: string;
};
