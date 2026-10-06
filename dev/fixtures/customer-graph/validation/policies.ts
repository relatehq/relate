/** Compile only. Selected policy authoring API; never execute these declarations. */
import { access } from '../source/access.js';
import {
  AccountReview,
  Customer,
  Invoice,
  Task,
  objects,
} from '../source/model.js';

const { policy } = access.forObjects(objects);
const gate = access.role('employee');
const evidenceMaxAgeMs = 30_000;
const organization = access.claims.organization;

// Nested: fresh, extracted, native, and multi-hop conditions infer without casts.
policy(Invoice, {
  read: {
    gate,
    evidenceMaxAgeMs,
    where: { customer: { organization: { eq: organization } } },
  },
});
const customerOrganization = {
  customer: { organization: { eq: organization } },
};

policy(Invoice, {
  read: { gate, evidenceMaxAgeMs, where: customerOrganization },
});
policy(AccountReview, {
  read: { gate, evidenceMaxAgeMs, where: customerOrganization },
});
policy(Task, {
  read: { gate, evidenceMaxAgeMs, where: { review: customerOrganization } },
});
policy(Task, {
  read: { gate, evidenceMaxAgeMs, where: { invoice: customerOrganization } },
});
policy(Task, { read: { gate, evidenceMaxAgeMs, where: customerOrganization } });

// prettier-ignore
// @ts-expect-error Nested: fresh unknown property.
policy(Invoice, { read: { gate, evidenceMaxAgeMs, where: { customer: { organizaton: { eq: organization } } } } });
// prettier-ignore
// @ts-expect-error Nested: a string claim cannot compare with a number.
policy(Invoice, { read: { gate, evidenceMaxAgeMs, where: { totalMinor: { eq: organization } } } });
// prettier-ignore
// @ts-expect-error Nested: author belongs to AccountReview, not Customer.
policy(Invoice, { read: { gate, evidenceMaxAgeMs, where: { customer: { author: { eq: organization } } } } });
// prettier-ignore
// @ts-expect-error Nested: Customer has no customer reference (wrong root).
policy(Customer, { read: { gate, evidenceMaxAgeMs, where: customerOrganization } });
const typoAlongsideValidField = {
  customer: {
    organization: { eq: organization },
    organizaton: { eq: organization },
  },
};

// prettier-ignore
// @ts-expect-error Nested: extracted surplus nested key must not disappear structurally.
policy(Invoice, { read: { gate, evidenceMaxAgeMs, where: typoAlongsideValidField } });
const wrongExtractedClaim = { customer: { revenue: { eq: organization } } };

// prettier-ignore
// @ts-expect-error Nested: extracted claim mismatch.
policy(Invoice, { read: { gate, evidenceMaxAgeMs, where: wrongExtractedClaim } });
// prettier-ignore
// @ts-expect-error Nested: multiple nested hops retain their target type.
policy(Task, { read: { gate, evidenceMaxAgeMs, where: { review: { customer: { note: { eq: organization } } } } } });

// Role-only object rules remain expressible without an evidence window.
policy(Customer, { read: { gate } });
// prettier-ignore
// @ts-expect-error a predicate requires its evidence age bound.
policy(Invoice, { read: { gate, where: customerOrganization } });
// prettier-ignore
// @ts-expect-error an evidence window without a predicate has no meaning here.
policy(Customer, { read: { gate, evidenceMaxAgeMs } });
// prettier-ignore
// @ts-expect-error financial is a field group, not an invented role.
policy(Customer, { read: { gate: { kind: 'role', role: 'financial' } } });
// prettier-ignore
// @ts-expect-error unknown field group.
policy(Customer, { read: { gate }, groups: { secret: gate } });
// prettier-ignore
// @ts-expect-error ordinary fields use the object rule, not a separate group grant.
policy(Customer, { read: { gate }, groups: { ordinary: gate } });
const onlyCustomers = access.forObjects({ Customer });

// prettier-ignore
// @ts-expect-error object absent from the bound registry.
onlyCustomers.policy(Invoice, { read: { gate } });
