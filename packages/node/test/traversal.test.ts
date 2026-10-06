import { createMemoryStore } from '@relate/runtime';
import { traversalContract } from '../../../tests/support/traversal-contract.js';

traversalContract('Memory traversal', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
