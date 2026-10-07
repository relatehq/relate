import { createMemoryStore } from '@relate/runtime';
import { providerAccountContract } from '../../../tests/support/provider-account-contract.js';

providerAccountContract('memory provider account isolation', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
