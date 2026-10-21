import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createSqlParser } from '@relate/sql-parser';
import { sqlCorpus } from '../../../tests/support/sql-corpus/index.js';
import { createSqlCorpusGraph } from '../../../tests/support/sql-corpus/model.js';
import { actorAssociations } from '../src/authorization/index.js';
import {
  prepareExpression,
  AnalyticalPreparationError,
} from '../src/analytics/index.js';

it.each(sqlCorpus)(
  'resolves the shared identifier/type contract: $name',
  async (entry) => {
    const { manifest } = compile(createSqlCorpusGraph(entry).graph);
    const scope = actorAssociations(
      manifest,
      { id: 'reader', roles: ['reader'], claims: {} },
      manifest.objects[0]!,
    );
    const parser = await createSqlParser();
    const prepare = () =>
      prepareExpression({
        parser,
        scope,
        expression: {
          sql: entry.sql,
          ...(entry.parameters ? { parameters: entry.parameters } : {}),
        },
      });

    if (entry.expect.phase === 'execute') {
      const prepared = prepare();

      expect(prepared.aggregate.result).toEqual(entry.expect.resultType);
      expect(prepared.association.id).toBe('customer.events');
      expect(prepared.forbidden).toBe(false);
      expect(prepared.correlationForbidden).toBe(false);
    } else {
      try {
        prepare();
        expect.fail('Expected rejected expression');
      } catch (error) {
        expect(error).toBeInstanceOf(AnalyticalPreparationError);
        expect((error as AnalyticalPreparationError).issues).toEqual([
          expect.objectContaining({ problem: entry.expect.problem }),
        ]);
      }
    }
  },
);
