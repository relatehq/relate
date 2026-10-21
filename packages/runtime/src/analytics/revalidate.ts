import type { ActorAssociations } from './types.js';
import type { AuthorizedCandidate, ComputedField } from './execution-types.js';

/** Recheck the private footprint against freshly authorized, usable ordinary inputs. */
export function revalidateFields(
  fields: Readonly<Record<string, ComputedField>>,
  candidate: AuthorizedCandidate,
  scope: ActorAssociations,
): Readonly<Record<string, ComputedField>> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => {
      if (field.status !== 'available') return [name, field];

      const association = scope.associations.find(
        (entry) => entry.id === field.input.associationId,
      );
      const property = scope.properties.find(
        (entry) => entry.name === name && entry.calculated,
      );

      if (
        !association ||
        property?.readable === false ||
        field.columns.some(
          (id) =>
            !association.columns.find((column) => column.id === id)?.readable,
        )
      )
        return [name, { status: 'forbidden' }];

      let unavailable = false;

      for (const [id, expected] of Object.entries(field.dependencies)) {
        const actual = candidate.dependencies[id];
        const correlation = association.on.some(
          (pair) => pair.propertyDefinitionId === id,
        );
        const readable =
          scope.properties.find((entry) => entry.id === id)?.readable === true;

        if (
          !correlation &&
          (!readable || actual?.evidence.status === 'forbidden')
        )
          return [name, { status: 'forbidden' }];

        if (
          !readable ||
          actual?.evidence.status !== 'available' ||
          !actual.value ||
          actual.value.value === null ||
          actual.value.type !== expected.value?.type ||
          actual.value.value !== expected.value.value ||
          (actual.value.type === 'timestamp' &&
            expected.value.type === 'timestamp' &&
            actual.value.precision !== expected.value.precision)
        )
          unavailable = true;
      }

      return [
        name,
        unavailable
          ? { status: 'unavailable', reason: 'correlation-unavailable' }
          : {
              ...field,
              dependencies: Object.fromEntries(
                Object.keys(field.dependencies).map((id) => [
                  id,
                  structuredClone(candidate.dependencies[id]!),
                ]),
              ),
            },
      ];
    }),
  );
}
