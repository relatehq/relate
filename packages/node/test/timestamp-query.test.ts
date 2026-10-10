import { createMemoryStore } from '@relate/runtime';
import { timestampQueryContract } from '../../../tests/support/timestamp-query-contract.js';

timestampQueryContract('Memory timestamp queries', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
