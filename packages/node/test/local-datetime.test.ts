import { createMemoryStore } from '@relate/runtime';
import { localDateTimeContract } from '../../../tests/support/local-datetime-contract.js';

localDateTimeContract('Memory local datetime', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
