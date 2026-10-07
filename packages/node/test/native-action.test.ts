import { constraintActionContract } from '../../../tests/support/constraint-action-contract.js';
import { createMemoryStore } from '@relate/runtime';
import { domainActionContract } from '../../../tests/support/domain-action-contract.js';
import { nativeActionContract } from '../../../tests/support/native-action-contract.js';

for (const contract of [
  nativeActionContract,
  domainActionContract,
  constraintActionContract,
])
  contract('Memory native actions', async () => ({
    store: createMemoryStore(),
    close: async () => {},
  }));
