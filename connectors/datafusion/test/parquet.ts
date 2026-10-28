import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Writes real required/optional Arrow fields, preserving timestamp precision. */
export async function writeParquet(
  path: string,
  fields: readonly { name: string; kind: string; nullable: boolean }[],
  rows: readonly (readonly (string | number | bigint | boolean | null)[])[],
): Promise<void> {
  const executable = fileURLToPath(
    new URL('../engine/target/debug/examples/write-parquet', import.meta.url),
  );

  await new Promise<void>((resolve, reject) => {
    const child = execFile(executable, [path], (error) =>
      error ? reject(error) : resolve(),
    );

    child.stdin!.end(
      JSON.stringify({ fields, rows }, (_, value: unknown) =>
        typeof value === 'bigint'
          ? String(value)
          : typeof value === 'number' && !Number.isFinite(value)
            ? String(value)
            : value,
      ),
    );
  });
}
