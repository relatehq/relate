/**
 * Optional declaration provenance for development tooling.
 *
 * Capture is off by default so ordinary authoring pays no stack-capture cost.
 * A host (such as `relate dev`) enables it before evaluating user modules. The
 * raw capture stays outside the definitions, the Manifest and its hash.
 */

const captured = new WeakMap<object, string>();

let capture: (() => string | undefined) | undefined;

/** Enable capture; the default records `new Error().stack` for each definition. */
export function enableDefinitionProvenance(options?: {
  readonly capture?: () => string | undefined;
}): void {
  capture = options?.capture ?? (() => new Error().stack);
}

export function disableDefinitionProvenance(): void {
  capture = undefined;
}

/** Raw capture metadata for a definition object, when capture was enabled. */
export function definitionProvenance(definition: object): string | undefined {
  return captured.get(definition);
}

export function recordProvenance<T extends object>(definition: T): T {
  if (capture) {
    const stack = capture();

    if (stack) captured.set(definition, stack);
  }

  return definition;
}
