export function testDatabaseUrl(): string {
  const url = process.env.RELATE_TEST_DATABASE_URL;

  if (!url)
    throw new Error(
      'Set RELATE_TEST_DATABASE_URL to a dedicated existing Postgres test database. Integration tests reset its relate schema; DATABASE_URL is never used.',
    );

  return url;
}
