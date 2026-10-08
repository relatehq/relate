# CRM simulator

Private workspace package for deterministic HTTP provider tests and the Postgres
example. It owns its Hono dependencies and has no Relate imports.

```ts
import { startCrmSimulator } from '@relate/dev-crm-simulator';

const crm = await startCrmSimulator();
try {
  // Use crm.url with the application connector.
} finally {
  await crm.stop();
}
```

The package exports TypeScript source for repository tooling (tsx and Vitest);
it is not published. Its behavior is covered by
`tests/unit/crm-simulator.test.ts`.
