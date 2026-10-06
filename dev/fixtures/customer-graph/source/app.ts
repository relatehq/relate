import { reviewInvoice } from './actions/review-invoice.server.js';
import { createRuntime } from '../validation/target.js';
import type { Connection } from '../validation/target.js';
import { graph } from './graph.js';
import { addAccountReview } from './actions/add-account-review.server.js';
import { escalateAccount } from './actions/escalate-account.server.js';

export const createApp = (connections: readonly Connection[]) =>
  createRuntime({
    graph,
    actionImplementations: [addAccountReview, escalateAccount, reviewInvoice],
    connections,
  });
