import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            'connectors/*/test/**/*.test.ts',
            'dev/salesforce/test/**/*.test.ts',
            'dev/research/*/test/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
            'examples/*/test/**/*.test.ts',
            'tests/unit/**/*.test.ts',
            'tests/architecture/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['./tests/support/database-setup.ts'],
          // These suites share a schema and install failure-injection triggers.
          fileParallelism: false,
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
