export function identifier(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error('Invalid DuckDB identifier');

  return `"${value.replaceAll('"', '""')}"`;
}
