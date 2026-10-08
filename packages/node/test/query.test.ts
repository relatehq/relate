import { createMemoryStore } from '@relate/runtime';
import { queryContract } from '../../../tests/support/query-contract.js';

queryContract('Memory graph query', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
