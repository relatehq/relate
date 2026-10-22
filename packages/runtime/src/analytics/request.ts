import type { AnalyticalExpression } from 'relate/analytics';
import { AnalyticalPreparationError } from './expression-types.js';

/** Trusted read-owner normalization: declarations retain their stable identity. */
export interface DeclaredCalculationRequest {
  readonly name: string;
  readonly definitionId: string;
  readonly sql: string;
  readonly readable: boolean;
  readonly project: boolean;
  readonly required: boolean;
}

export interface ComputeRequest {
  /** Untrusted request input; validated before parsing or dependency reads. */
  readonly compute?: unknown;
  readonly declarations: readonly DeclaredCalculationRequest[];
  /** Caller aliases used by a normalized computed filter or order. */
  readonly requiredAliases?: readonly string[];
}

export interface PreparationLimits {
  readonly maxExpressions?: number;
  readonly maxSqlBytes?: number;
  readonly maxParameters?: number;
  readonly maxParameterBytes?: number;
}

export function expressionEntries(
  request: ComputeRequest,
  propertyNames: readonly string[],
  limits: PreparationLimits,
): readonly [string, AnalyticalExpression][] {
  const max = limits.maxExpressions ?? 8;

  for (const value of [
    max,
    limits.maxSqlBytes ?? 4096,
    limits.maxParameters ?? 16,
    limits.maxParameterBytes ?? 1024,
  ])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Invalid analytical preparation limits');

  const fail = (message: string, path: readonly string[]): never => {
    throw new AnalyticalPreparationError([
      { problem: 'invalid-value', message, path },
    ]);
  };
  const compute = request.compute;

  if (
    compute !== undefined &&
    (!compute ||
      typeof compute !== 'object' ||
      Array.isArray(compute) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(compute)))
  )
    fail('compute must be an object of named expressions.', ['compute']);

  if (
    compute &&
    Reflect.ownKeys(compute).some((key) => typeof key !== 'string')
  )
    fail('Computed aliases must be string keys.', ['compute']);

  const entries = Object.entries(compute ?? {});
  const names = new Set(entries.map(([name]) => name));

  if (request.requiredAliases?.some((name) => !names.has(name)))
    throw new Error('Invalid normalized required alias');

  if (entries.length + request.declarations.length > max)
    fail('The request exceeds the analytical expression limit.', ['compute']);

  const properties = new Set(propertyNames);
  const declared = new Set<string>();

  for (const declaration of request.declarations) {
    if (!properties.has(declaration.name) || declared.has(declaration.name))
      throw new Error('Invalid normalized calculation declarations');

    declared.add(declaration.name);
  }

  for (const [name] of entries)
    if (
      !name.length ||
      name.includes('\0') ||
      ['__proto__', 'constructor', 'prototype'].includes(name) ||
      properties.has(name)
    )
      fail('The computed alias is unsafe or collides with a property.', [
        'compute',
        name,
      ]);

  return entries as [string, AnalyticalExpression][];
}
