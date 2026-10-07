import { createMemoryStore } from '@relate/runtime';
import { propertyIdentityContract } from '../../../tests/support/property-identity-contract.js';

propertyIdentityContract('memory property identity', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
