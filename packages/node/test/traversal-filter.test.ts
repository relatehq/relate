import { createMemoryStore } from '@relate/runtime';
import { traversalFilterContract } from '../../../tests/support/traversal-filter-contract.js';

traversalFilterContract('Memory traversal filters', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
