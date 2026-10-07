import { createMemoryStore } from '@relate/runtime';
import { receiptRecoveryContract } from '../../../tests/support/receipt-recovery-contract.js';

receiptRecoveryContract('Memory receipt recovery', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
