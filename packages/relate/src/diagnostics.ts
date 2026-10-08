/**
 * Platform-neutral diagnostics shared by authoring helpers, the compiler, the
 * manifest validator and development tools such as the inspector.
 *
 * This module imports nothing: no compiler, Node APIs or inspector code.
 */

/** Stable machine-readable identifiers. Consumers branch on these, never on message text. */
export type ModelIssueCode =
  | 'graph.invalid-shape'
  | 'manifest.invalid-shape'
  | 'definition.invalid-id'
  | 'definition.duplicate-id'
  | 'access.invalid-field-groups'
  | 'access.invalid-roles'
  | 'access.invalid-claims'
  | 'source.invalid-id-field'
  | 'source.invalid-field'
  | 'source.conflicting-definitions'
  | 'schema.unsupported'
  | 'object.invalid-api-name'
  | 'object.unknown-source'
  | 'object.unsupported-membership'
  | 'object.object-id-count'
  | 'object.invalid-object-id'
  | 'property.invalid-name'
  | 'property.invalid-field-group'
  | 'property.unknown-field-group'
  | 'property.invalid-source-field'
  | 'property.native-requires-native-membership'
  | 'reference.invalid-target'
  | 'relationship.invalid-endpoints'
  | 'relationship.invalid-traversal'
  | 'policy.missing'
  | 'policy.unknown-object'
  | 'policy.unknown-role'
  | 'policy.unknown-claim'
  | 'policy.unknown-dependency'
  | 'policy.unknown-actor-field'
  | 'policy.invalid-rule'
  | 'policy.invalid-predicate'
  | 'policy.invalid-path'
  | 'policy.invalid-group'
  | 'policy.incompatible-claim'
  | 'policy.unsupported-gate'
  | 'policy.create-requires-native-membership'
  | 'action.invalid-shape'
  | 'action.invalid-api-name'
  | 'action.invalid-field'
  | 'action.invalid-reference'
  | 'action.invalid-capability';

/**
 * Where an issue lives. Authored graphs, single definitions and serialized
 * manifests have different shapes, so the root is explicit.
 */
export interface IssuePath {
  readonly root: 'graph' | 'definition' | 'manifest';
  readonly segments: readonly (string | number)[];
}

/**
 * A resolved source location. `declaration` identifies the definition call,
 * such as `defineGraph(...)`; only `expression` claims the exact offending
 * expression.
 */
export interface SourceSite {
  readonly file: string;
  /** One-based. */
  readonly line: number;
  /** One-based. */
  readonly column: number;
  readonly precision: 'declaration' | 'expression';
}

export interface ModelIssue {
  readonly code: ModelIssueCode;
  readonly message: string;
  /** The stable definition ID the issue belongs to, when unambiguous. */
  readonly definitionId?: string;
  readonly path?: IssuePath;
  readonly site?: SourceSite;
}

function compareSegments(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = String(a[index]);
    const right = String(b[index]);

    if (left !== right) return left < right ? -1 : 1;
  }

  return a.length - b.length;
}

function compareIssues(a: ModelIssue, b: ModelIssue): number {
  const roots = [a.path?.root ?? '', b.path?.root ?? ''] as const;

  if (roots[0] !== roots[1]) return roots[0] < roots[1] ? -1 : 1;

  const segments = compareSegments(
    a.path?.segments ?? [],
    b.path?.segments ?? [],
  );

  if (segments !== 0) return segments;

  for (const key of ['code', 'definitionId', 'message'] as const) {
    const left = a[key] ?? '';
    const right = b[key] ?? '';

    if (left !== right) return left < right ? -1 : 1;
  }

  return 0;
}

/** Deduplicate issues and order them deterministically by path, then code. */
export function normalizeIssues(
  issues: readonly ModelIssue[],
): readonly ModelIssue[] {
  const unique = new Map<string, ModelIssue>();

  for (const issue of issues) {
    const key = JSON.stringify([
      issue.code,
      issue.message,
      issue.definitionId ?? null,
      issue.path ?? null,
      issue.site ?? null,
    ]);

    if (!unique.has(key)) unique.set(key, issue);
  }

  return [...unique.values()]
    .sort(compareIssues)
    .map((issue) => Object.freeze({ ...issue }));
}

export function formatIssuePath(path: IssuePath): string {
  return [path.root, ...path.segments.map(String)].join('.');
}

abstract class IssueError extends Error {
  readonly issues: readonly ModelIssue[];

  constructor(name: string, issues: readonly ModelIssue[]) {
    if (issues.length === 0) throw new Error(`${name} needs an issue`);

    const normalized = normalizeIssues(issues);

    super(normalized.map((issue) => issue.message).join('\n'));
    this.name = name;
    this.issues = Object.freeze(normalized);
  }
}

/** Expected authored-definition and compilation validation failures. */
export class CompileError extends IssueError {
  constructor(issues: readonly ModelIssue[]) {
    super('CompileError', issues);
  }
}

/** Invalid serialized manifest input; paths address the supplied JSON. */
export class ManifestValidationError extends IssueError {
  constructor(issues: readonly ModelIssue[]) {
    super('ManifestValidationError', issues);
  }
}

/** Structural check that survives serialization and process boundaries. */
export function isModelIssue(value: unknown): value is ModelIssue {
  if (!value || typeof value !== 'object') return false;

  const issue = value as Record<string, unknown>;

  return typeof issue.code === 'string' && typeof issue.message === 'string';
}
