import { ReviewInvoice } from './actions/review-invoice.js';
import { AddAccountReview } from './actions/add-account-review.js';
import { EscalateAccount } from './actions/escalate-account.js';
import { defineGraph } from '../validation/target.js';
import { access } from './access.js';
import { objects, relationships } from './model.js';

// Object policies live here; action policies live on the action definitions.
// Every object requires an explicit read decision; missing action policies deny access.
export const graph = defineGraph({
  id: 'business.graph',
  objects,
  relationships,
  actions: {
    addAccountReview: AddAccountReview,
    escalateAccount: EscalateAccount,
    reviewInvoice: ReviewInvoice,
  },
  access,
  policies: {
    Customer: {
      read: {
        gate: access.role('employee'),
        where: { portfolio: { eq: access.claims.portfolio } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    },
    Invoice: {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
        },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    },
    AccountReview: {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
        },
        evidenceMaxAgeMs: 30_000,
      },
      create: {
        gate: access.role('account-manager'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
          author: { eq: access.actor.id },
        },
        evidenceMaxAgeMs: 30_000,
      },
    },
    // Permission follows Task's customer; integrity separately requires all
    // three references to identify that same customer.
    Task: {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
        },
        evidenceMaxAgeMs: 30_000,
      },
      create: {
        gate: access.role('account-manager'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      integrity: ({ fields, same }) => [
        same(fields.customer, fields.invoice.customer),
        same(fields.customer, fields.review.customer),
      ],
    },
  },
});
