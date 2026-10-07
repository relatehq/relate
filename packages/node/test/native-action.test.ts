import { createMemoryStore } from '@relate/runtime';
import { nativeActionContract } from '../../../tests/support/native-action-contract.js';

nativeActionContract('Memory native actions', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
