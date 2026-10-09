import { createMemoryStore } from '@relate/runtime';
import { throughTraversalContract } from '../../../tests/support/through-traversal-contract.js';

throughTraversalContract('Memory through traversal', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
