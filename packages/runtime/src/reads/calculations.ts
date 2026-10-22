import type { RequestIssue } from '@relate/protocol';

/** Restricted read surfaces must reject declarations before source or analytical I/O. */
export function calculatedReadIssues(
  input: unknown,
  calculations: readonly {
    readonly name: string;
    readonly defaultSelected: boolean;
  }[],
): RequestIssue[] {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !calculations.length
  )
    return [];

  const request = input as Record<string, unknown>;
  const issues: RequestIssue[] = [];
  const unsupported = (path: readonly string[]) =>
    issues.push({
      path,
      problem: 'not-supported',
      message:
        'Declared calculations are not supported on this read surface. Select ordinary properties explicitly.',
    });
  const names = new Set(calculations.map((calculation) => calculation.name));

  if (
    request.select === undefined
      ? calculations.some((calculation) => calculation.defaultSelected)
      : Array.isArray(request.select) &&
        request.select.some(
          (name) => typeof name === 'string' && names.has(name),
        )
  )
    unsupported(['select']);

  if (
    request.where &&
    typeof request.where === 'object' &&
    !Array.isArray(request.where)
  )
    for (const name of Object.keys(request.where))
      if (names.has(name)) unsupported(['where', name]);

  if (Array.isArray(request.orderBy))
    request.orderBy.forEach((order, index) => {
      if (
        order &&
        typeof order === 'object' &&
        typeof order.field === 'string' &&
        names.has(order.field)
      )
        unsupported(['orderBy', String(index), 'field']);
    });

  return issues;
}
