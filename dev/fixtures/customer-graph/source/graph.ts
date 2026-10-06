import { AddAccountReview } from './actions/add-account-review.js';
import { EscalateAccount } from './actions/escalate-account.js';
import { defineGraph, equals } from '../validation/target.js';
import { access } from './access.js';
import {
  AccountReview,
  Customer,
  CustomerInvoices,
  CustomerReviews,
  Invoice,
  ReviewTasks,
  Task,
} from './model.js';

// Object policies live here; action policies live on the action definitions.
// Either kind without a policy is denied to everyone.
export const graph = defineGraph({
  id: 'business.graph',
  objects: { Customer, Invoice, AccountReview, Task },
  relationships: { CustomerInvoices, CustomerReviews, ReviewTasks },
  actions: {
    addAccountReview: AddAccountReview,
    escalateAccount: EscalateAccount,
  },
  access,
  policies: [
    access.policy(Customer, {
      read: {
        gate: access.role('employee'),
        where: equals(
          Customer.properties.organization,
          access.claims.organization,
        ),
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    }),
    // Open: limiting invoices to the caller's organization needs a predicate
    // through the relationship, which policies cannot express yet.
    access.policy(Invoice, {
      read: { gate: access.role('employee') },
      groups: { financial: access.role('finance') },
    }),
    access.policy(AccountReview, { read: { gate: access.role('employee') } }),
    access.policy(Task, { read: { gate: access.role('employee') } }),
  ],
});
