import { createMemoryStore } from '@relate/runtime';
import {
  activityContract,
  lineageContract,
} from '../../../tests/support/activity-contract.js';

activityContract('memory activity', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));

lineageContract('memory operation lineage', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));
