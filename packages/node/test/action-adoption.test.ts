import { createMemoryStore } from '@relate/runtime';
import { adoptionActionContract } from '../../../tests/support/adoption-action-contract.js';

adoptionActionContract('Memory action adoption', async () => ({
  store: createMemoryStore(),
  kind: 'memory',
  close: async () => {},
}));
