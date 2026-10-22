import { analyticalSchemaType } from 'relate/model';
import type { Manifest } from 'relate/model';
import { allowsObject, allowsField } from './policy.js';
import type { Principal } from './policy.js';

type ObjectType = Manifest['objects'][number];

/** Trusted declaration view for startup validation, including denied/unused definitions. */
export function analyticalDeclarations(manifest: Manifest, object: ObjectType) {
  return {
    properties: [
      ...object.properties.map((property) => {
        const schema = ['reference', 'native-reference'].includes(
          property.origin.kind,
        )
          ? undefined
          : analyticalSchemaType(property.schema);

        return {
          id: property.id,
          name: property.name,
          calculated: false,
          readable: true,
          ...(schema ? { schema } : {}),
        };
      }),
      ...(object.calculations ?? []).map((property) => ({
        id: property.id,
        name: property.name,
        calculated: true,
        readable: true,
      })),
    ],
    associations: (object.datasets ?? []).map((association) => {
      const dataset = manifest.datasets!.find(
        (dataset) => dataset.id === association.datasetDefinitionId,
      )!;

      return {
        id: association.id,
        name: association.name,
        datasetDefinitionId: dataset.id,
        on: association.on,
        ...(dataset.description === undefined
          ? {}
          : { description: dataset.description }),
        columns: dataset.columns.map((column) => ({
          id: column.id,
          name: column.name,
          schema: column.schema,
          readable: true,
          ...(column.description === undefined
            ? {}
            : { description: column.description }),
        })),
      };
    }),
  };
}

/** Discovery and preparation share association gates and column access decisions. */
export function actorAssociations(
  manifest: Manifest,
  principal: Principal,
  object: ObjectType,
) {
  const policy = manifest.policies[object.id];

  if (!allowsObject(principal, policy))
    return { properties: [], associations: [] };

  const declarations = analyticalDeclarations(manifest, object);
  const fields = [...object.properties, ...(object.calculations ?? [])];

  return {
    properties: declarations.properties.map((property) => ({
      ...property,
      readable: allowsField(
        principal,
        policy,
        fields.find((field) => field.id === property.id)!.access,
      ),
    })),
    associations: declarations.associations
      .filter((association) => {
        const definition = object.datasets!.find(
          (entry) => entry.id === association.id,
        )!;

        return principal.roles.includes(definition.gate.role);
      })
      .map((association) => {
        const dataset = manifest.datasets!.find(
          (dataset) => dataset.id === association.datasetDefinitionId,
        )!;

        return {
          ...association,
          columns: association.columns.map((column) => ({
            ...column,
            readable: allowsField(
              principal,
              dataset,
              dataset.columns.find((entry) => entry.id === column.id)!.access,
            ),
          })),
        };
      }),
  };
}
