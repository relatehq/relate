/** Compile only. Selected policy authoring API; never execute these declarations. */
import { access } from '../source/access.js';
import { Customer } from '../source/model.js';

import { defineGraph } from './target.js';
import { graph } from '../source/graph.js';

const gate = access.role('employee');
const evidenceMaxAgeMs = 30_000;
const portfolio = access.claims.portfolio;

// Nested: fresh, extracted, native, and multi-hop conditions infer without casts.
defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    Invoice: {
      read: {
        gate,
        evidenceMaxAgeMs,
        where: { customer: { portfolio: { eq: portfolio } } },
      },
    },
  },
});
const customerPortfolio = {
  customer: { portfolio: { eq: portfolio } },
};

defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    Invoice: {
      read: { gate, evidenceMaxAgeMs, where: customerPortfolio },
    },
  },
});
defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    AccountReview: {
      read: { gate, evidenceMaxAgeMs, where: customerPortfolio },
    },
  },
});
defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    Task: {
      read: { gate, evidenceMaxAgeMs, where: { review: customerPortfolio } },
    },
  },
});
defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    Task: {
      read: { gate, evidenceMaxAgeMs, where: { invoice: customerPortfolio } },
    },
  },
});
defineGraph({
  ...graph,
  policies: {
    ...graph.policies,
    Task: { read: { gate, evidenceMaxAgeMs, where: customerPortfolio } },
  },
});

// prettier-ignore
// @ts-expect-error Nested: fresh unknown property.
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: { customer: { portoflio: { eq: portfolio } } } } } } });
// prettier-ignore
// @ts-expect-error Nested: a string claim cannot compare with a number.
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: { totalMinor: { eq: portfolio } } } } } });
// prettier-ignore
// @ts-expect-error Nested: author belongs to AccountReview, not Customer.
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: { customer: { author: { eq: portfolio } } } } } } });
// prettier-ignore
// @ts-expect-error Nested: Customer has no customer reference (wrong root).
defineGraph({ ...graph, policies: { ...graph.policies, Customer: { read: { gate, evidenceMaxAgeMs, where: customerPortfolio } } } });
const typoAlongsideValidField = {
  customer: {
    portfolio: { eq: portfolio },
    portoflio: { eq: portfolio },
  },
};

// prettier-ignore
// @ts-expect-error Nested: extracted surplus nested key must not disappear structurally.
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: typoAlongsideValidField } } } });
const wrongExtractedClaim = { customer: { revenue: { eq: portfolio } } };

// prettier-ignore
// @ts-expect-error Nested: extracted claim mismatch.
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: wrongExtractedClaim } } } });
// prettier-ignore
// @ts-expect-error Nested: multiple nested hops retain their target type.
defineGraph({ ...graph, policies: { ...graph.policies, Task: { read: { gate, evidenceMaxAgeMs, where: { review: { customer: { note: { eq: portfolio } } } } } } } });

// Role-only object rules remain expressible without an evidence window.
defineGraph({
  ...graph,
  policies: { ...graph.policies, Customer: { read: { gate } } },
});
// prettier-ignore
// @ts-expect-error a predicate requires its evidence age bound.
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, where: customerPortfolio } } } });
// prettier-ignore
// @ts-expect-error an evidence window without a predicate has no meaning here.
defineGraph({ ...graph, policies: { ...graph.policies, Customer: { read: { gate, evidenceMaxAgeMs } } } });
// prettier-ignore
// @ts-expect-error financial is a field group, not an invented role.
defineGraph({ ...graph, policies: { ...graph.policies, Customer: { read: { gate: { kind: 'role', role: 'financial' } } } } });
// prettier-ignore
// @ts-expect-error unknown field group.
defineGraph({ ...graph, policies: { ...graph.policies, Customer: { read: { gate }, groups: { secret: gate } } } });
// prettier-ignore
// @ts-expect-error ordinary fields use the object rule, not a separate group grant.
defineGraph({ ...graph, policies: { ...graph.policies, Customer: { read: { gate }, groups: { ordinary: gate } } } });

// prettier-ignore
// @ts-expect-error object absent from the bound registry.
defineGraph({ ...graph, objects: { Customer }, policies: { Customer: { read: 'deny' }, Invoice: { read: { gate } } } });
