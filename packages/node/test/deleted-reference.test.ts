import { createMemoryStore } from '@relate/runtime';
import { deletedReferenceContract } from '../../../tests/support/deleted-reference-contract.js';

deletedReferenceContract('Memory deleted references', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
