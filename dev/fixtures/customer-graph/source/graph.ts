import { ReviewInvoice } from './actions/review-invoice.js';
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
  objects,
} from './model.js';

// Object policies live here; action policies live on the action definitions.
// Either kind without a policy is denied to everyone.
export const graph = defineGraph({
  id: 'business.graph',
  objects,
  relationships: { CustomerInvoices, CustomerReviews, ReviewTasks },
  actions: {
    addAccountReview: AddAccountReview,
    escalateAccount: EscalateAccount,
    reviewInvoice: ReviewInvoice,
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
    // The same organization-isolation gap also applies to reviews and tasks.
    // See authorization-cases.md; these role-only rules do not satisfy it yet.
    access.policy(AccountReview, { read: { gate: access.role('employee') } }),
    access.policy(Task, { read: { gate: access.role('employee') } }),
  ],
});
