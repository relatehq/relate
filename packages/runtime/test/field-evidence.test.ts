import { createMemoryStore } from '@relate/runtime';
import { fieldEvidenceContract } from '../../../tests/support/field-evidence-contract.js';

fieldEvidenceContract('Memory field evidence', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
