import type { RequestIssue } from '@relate/protocol';

export const MAX_SELECTED_PROPERTIES = 100;

export function selectedProperties<P extends { readonly name: string }>(
  properties: readonly P[],
  selected: readonly string[] | undefined,
  readable: (property: P) => boolean,
): string[] {
  return [
    ...new Set(
      selected ?? properties.filter(readable).map((property) => property.name),
    ),
  ];
}

export function selectionIssues(
  selected: readonly string[] | undefined,
  needed: readonly string[],
  expanded = false,
): RequestIssue[] {
  return selected && !expanded && new Set(needed).size > MAX_SELECTED_PROPERTIES
    ? [
        {
          path: ['select'],
          problem: 'invalid-value',
          message: 'select and where together name more than 100 properties.',
        },
      ]
    : [];
}
