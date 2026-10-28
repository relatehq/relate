import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { datafusion } from '@relate/connector-datafusion';
import { sqlCorpusBackendContract } from '../../../tests/support/sql-corpus/backend-contract.js';
import { writeParquet } from './parquet.js';

sqlCorpusBackendContract('DataFusion SQL corpus', async (rows) => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-datafusion-corpus-'));
  const path = join(directory, 'data.parquet');
  const connection = datafusion({
    connectionId: 'corpus',
    onDiagnostic: (d) => console.error(d),
  });
  const close = async () => {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  };

  try {
    await writeParquet(
      path,
      [
        { name: 'customerId', kind: 'string', nullable: false },
        { name: 'value', kind: 'int64', nullable: true },
        ...['label', 'userId', 'eventType'].map((name) => ({
          name,
          kind: 'string',
          nullable: true,
        })),
        { name: 'occurredAt', kind: 'timestamp3', nullable: true },
        ...['enabled', 'visible'].map((name) => ({
          name,
          kind: 'boolean',
          nullable: true,
        })),
        ...['column$identifier', 'small'].map((name) => ({
          name,
          kind: 'int32',
          nullable: true,
        })),
        { name: 'ratio', kind: 'float64', nullable: true },
        { name: 'preciseAt', kind: 'timestamp6', nullable: true },
      ],
      rows,
    );

    return { resource: connection.parquet(path), close };
  } catch (error) {
    await close();
    throw error;
  }
});
