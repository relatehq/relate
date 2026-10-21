import { expect, it } from 'vitest';
import { createSqlParser } from '@relate/sql-parser';
import { compile } from 'relate/compiler';
import { actorAssociations } from '../src/authorization/index.js';
import { prepareExpression } from '../src/analytics/index.js';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';

async function setup(roles: string[]) {
  const { graph } = createAnalyticalGraph();
  const { manifest } = compile(graph);

  return {
    parser: await createSqlParser(),
    scope: actorAssociations(
      manifest,
      { id: 'actor', roles, claims: {} },
      manifest.objects[0]!,
    ),
  };
}

it('omits associations when their gate or object gate denies the actor', async () => {
  for (const roles of [[], ['reader'], ['analyst']]) {
    const input = await setup(roles);

    expect(input.scope.associations).toEqual([]);
    const issues = (name: string) => {
      try {
        prepareExpression({
          ...input,
          expression: { sql: `SELECT COUNT(*) FROM self.${name}` },
        });
        expect.fail('Expected hidden association rejection');
      } catch (error) {
        return (error as { issues: unknown }).issues;
      }
    };

    expect(issues('events')).toEqual(issues('absent'));
  }
});

it('retains denied column metadata so use is forbidden without opening the association', async () => {
  const input = await setup(['reader', 'analyst']);

  expect(input.scope.associations).toHaveLength(1);
  expect(
    input.scope.associations[0]!.columns.find(
      (column) => column.name === 'secret',
    )!.readable,
  ).toBe(false);
  const count = prepareExpression({
    ...input,
    expression: { sql: 'SELECT COUNT(*) FROM self.events' },
  });
  const secret = prepareExpression({
    ...input,
    expression: { sql: 'SELECT COUNT(DISTINCT secret) FROM self.events' },
  });

  expect(count.forbidden).toBe(false);
  expect(count.correlationForbidden).toBe(true);
  expect(secret.forbidden).toBe(true);
});

it('distinguishes unreadable correlation properties from other denied self dependencies', async () => {
  const input = await setup(['reader', 'analyst']);
  const correlation = prepareExpression({
    ...input,
    expression: {
      sql: 'SELECT COUNT(*) FROM self.events WHERE customerId = self.externalId',
    },
  });
  const dependency = prepareExpression({
    ...input,
    expression: {
      sql: 'SELECT COUNT(*) FROM self.events WHERE customerId = self.label',
    },
  });

  expect(correlation).toMatchObject({
    forbidden: false,
    correlationForbidden: true,
  });
  expect(dependency).toMatchObject({
    forbidden: true,
    correlationForbidden: true,
  });
});

it('allows all columns and keys only with the corresponding groups', async () => {
  const input = await setup(['reader', 'analyst', 'private']);
  const result = prepareExpression({
    ...input,
    expression: {
      sql: 'SELECT COUNT(DISTINCT secret) FROM self.events WHERE customerId = self.label',
    },
  });

  expect(result).toMatchObject({
    forbidden: false,
    correlationForbidden: false,
  });
});

it('treats a denied correlation column as forbidden even for COUNT(*)', async () => {
  const input = await setup(['reader', 'analyst', 'private']);
  const view = {
    ...input.scope,
    associations: input.scope.associations.map((association) => ({
      ...association,
      columns: association.columns.map((column) => ({
        ...column,
        readable: column.name !== 'customerId',
      })),
    })),
  };
  const result = prepareExpression({
    ...input,
    scope: view,
    expression: { sql: 'SELECT COUNT(*) FROM self.events' },
  });

  expect(result).toMatchObject({
    forbidden: true,
    correlationForbidden: false,
  });
});
