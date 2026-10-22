import { createMemoryStore } from '@relate/runtime';
import { integerPropertyContract } from '../../../tests/support/integer-property-contract.js';

integerPropertyContract('Memory integers', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
