import type {
  LogicalType,
  ComputedResultType,
  SourceSpan,
} from 'relate/analytics';
import type { ResolvedAggregate, TypedValue } from 'relate/connectors';

export interface AnalyticalProperty {
  readonly id: string;
  readonly name: string;
  readonly schema?: ComputedResultType;
  readonly calculated: boolean;
  readonly readable: boolean;
}

export interface AnalyticalColumn {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly schema: ComputedResultType;
  readonly readable: boolean;
}

export interface AnalyticalAssociation {
  readonly id: string;
  readonly name: string;
  readonly datasetDefinitionId: string;
  readonly description?: string;
  readonly columns: readonly AnalyticalColumn[];
  readonly on: readonly {
    readonly columnDefinitionId: string;
    readonly propertyDefinitionId: string;
  }[];
}

/** Authorization supplies this view: hidden associations are absent, denied columns remain. */
export interface ActorAssociations {
  readonly properties: readonly AnalyticalProperty[];
  readonly associations: readonly AnalyticalAssociation[];
}

/** Key indexes refer to dependencies, including all correlation properties first. */
export interface ResolvedExpression {
  readonly association: AnalyticalAssociation;
  readonly aggregate: ResolvedAggregate;
  readonly dependencies: readonly {
    readonly id: string;
    readonly type: LogicalType;
    readonly correlation: boolean;
  }[];
  readonly columns: readonly string[];
  readonly parameterTypes: Readonly<Record<string, LogicalType>>;
  readonly parameters: Readonly<Record<string, TypedValue>>;
  readonly forbidden: boolean;
  readonly correlationForbidden: boolean;
}

export interface PreparationIssue {
  readonly problem: 'invalid-value' | 'unknown-property' | 'not-supported';
  readonly message: string;
  readonly at?: SourceSpan;
  readonly path?: readonly string[];
}

export class AnalyticalPreparationError extends Error {
  readonly issues: readonly PreparationIssue[];
  constructor(issues: readonly PreparationIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.name = 'AnalyticalPreparationError';
    this.issues = Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          ...issue,
          ...(issue.path ? { path: Object.freeze([...issue.path]) } : {}),
          ...(issue.at ? { at: Object.freeze({ ...issue.at }) } : {}),
        }),
      ),
    );
  }
}
