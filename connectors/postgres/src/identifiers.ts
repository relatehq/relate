export function identifier(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error('Invalid PostgreSQL identifier');

  return `"${value.replaceAll('"', '""')}"`;
}
