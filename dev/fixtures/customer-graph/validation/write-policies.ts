/** Compile-only checks for the selected create and declarative integrity API. */
import { access } from '../source/access.js';
import { objects, Task } from '../source/model.js';
import type { IntegrityRule } from './target.js';

import { defineGraph } from './target.js';
import { graph } from '../source/graph.js';

const read = { gate: access.role('employee') };
const create = {
  gate: access.role('account-manager'),
  where: {
    customer: { portfolio: { eq: access.claims.portfolio } },
    author: { eq: access.actor.id },
  },
  evidenceMaxAgeMs: 30_000,
};
const taskIntegrity: IntegrityRule<typeof objects, typeof Task> = ({
  fields,
  same,
}) => [
  same(fields.customer, fields.invoice.customer),
  same(fields.customer, fields.review.customer),
];

defineGraph({
  ...graph,
  policies: { ...graph.policies, AccountReview: { read, create } },
});
defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    Task: {
      read,
      create: { ...create, where: { customer: create.where.customer } },
      integrity: taskIntegrity,
    },
  },
});
defineGraph({
  ...graph,
  policies: { ...graph.policies, Task: { read, integrity: taskIntegrity } },
}); // An invariant does not grant create permission.
defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    AccountReview: {
      read,
      create: { gate: access.role('account-manager') },
    },
  },
});
// prettier-ignore
// @ts-expect-error source-owned objects cannot install native creation rules.
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read, create: { gate: access.role('account-manager') } } } });
// prettier-ignore
// @ts-expect-error source-write integrity enforcement is outside this native contract.
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read, integrity: () => [] } } });
// prettier-ignore
// @ts-expect-error actor ID cannot be compared with a numeric property.
defineGraph({ ...graph, policies: { ...graph.policies, AccountReview: { read, create: { ...create, where: { customer: { revenue: { eq: access.actor.id } } } } } } });
// prettier-ignore
// @ts-expect-error unknown actor property.
access.actor.portfolio;
// prettier-ignore
// @ts-expect-error unknown claim.
access.claims.unknown;
const typo = {
  ...create,
  where: {
    ...create.where,
    customer: {
      ...create.where.customer,
      portoflio: { eq: access.claims.portfolio },
    },
  },
};

// prettier-ignore
// @ts-expect-error surplus extracted predicate field must be rejected.
defineGraph({ ...graph, policies: { ...graph.policies, AccountReview: { read, create: typo } } });
// prettier-ignore
// @ts-expect-error reference constraints retain their root when extracted.
defineGraph({ ...graph, policies: { ...graph.policies, AccountReview: { read, create, integrity: taskIntegrity } } });
// prettier-ignore
// @ts-expect-error predicates require an evidence bound.
defineGraph({ ...graph, policies: { ...graph.policies, AccountReview: { read, create: { gate: create.gate, where: create.where } } } });
// prettier-ignore
// @ts-expect-error an evidence bound without a predicate has no meaning.
defineGraph({ ...graph, policies: { ...graph.policies, AccountReview: { read, create: { gate: create.gate, evidenceMaxAgeMs: 30_000 } } } });
// prettier-ignore
// @ts-expect-error unknown role cannot grant creation.
defineGraph({ ...graph, policies: { ...graph.policies, AccountReview: { read, create: { gate: { kind: 'role', role: 'administrator' } } } } });
// prettier-ignore
// @ts-expect-error imperative validation is not part of the selected API.
defineGraph({ ...graph, policies: { ...graph.policies, Task: { read, validate: async () => true } } });
// prettier-ignore
// @ts-expect-error integrity returns constraints, not a runtime boolean.
defineGraph({ ...graph, policies: { ...graph.policies, Task: { read, integrity: () => true } } });
// prettier-ignore
// @ts-expect-error integrity builds synchronously; it is not an async evidence reader.
defineGraph({ ...graph, policies: { ...graph.policies, Task: { read, integrity: async () => [] } } });

defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    Task: {
      read,
      integrity: ({ fields, same }) => {
        // @ts-expect-error Customer and Invoice identities cannot be compared.
        same(fields.customer, fields.invoice);
        // @ts-expect-error invalid nested property.
        same(fields.customer, fields.invoice.customerTypo);
        // @ts-expect-error scalars are not reference paths.
        same(fields.customer, fields.assignee);
        // @ts-expect-error field paths are immutable.
        fields.customer = fields.invoice.customer;

        return [same(fields.customer, fields.review.customer)];
      },
    },
  },
});
