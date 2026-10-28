import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { datafusion } from '@relate/connector-datafusion';
import { rowArithmeticContract } from '../../../tests/support/row-arithmetic-contract.js';
import { writeParquet } from './parquet.js';

rowArithmeticContract('DataFusion row arithmetic', async (rows) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'relate-datafusion-arithmetic-'),
  );
  const path = join(directory, 'data.parquet');
  const connection = datafusion({
    connectionId: 'arithmetic',
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
        ...['a', 'b'].map((name) => ({ name, kind: 'int64', nullable: true })),
        { name: 'small', kind: 'int32', nullable: true },
        ...['x', 'y'].map((name) => ({
          name,
          kind: 'float64',
          nullable: true,
        })),
      ],
      rows,
    );

    return { resource: connection.parquet(path), close };
  } catch (error) {
    await close();
    throw error;
  }
});
