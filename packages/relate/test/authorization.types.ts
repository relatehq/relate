import { z } from 'zod';
import {
  defineAccess,
  defineObject,
  defineSource,
  defineGraph,
  from,
  native,
  objectId,
  source,
} from 'relate';

const access = defineAccess({
  roles: ['employee', 'finance'],
  fieldGroups: ['ordinary', 'financial'],
  claims: {
    portfolio: z.string(),
    limit: z.number(),
    enabled: z.boolean(),
    nullable: z.string().nullable(),
  },
});
const crm = defineSource({
  id: 'crm',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    portfolio: z.string(),
    balance: z.number(),
  }),
});
const Customer = defineObject({
  id: 'customer',
  name: 'Customer',
  membership: source(crm),
  properties: {
    id: objectId({
      id: 'customer.id',
      access: access.groups.ordinary,
    }),
    portfolio: from(crm.fields.portfolio, {
      id: 'customer.portfolio',
      access: access.groups.ordinary,
    }),
    balance: from(crm.fields.balance, {
      id: 'customer.balance',
      access: access.groups.financial,
    }),
  },
});
const Other = defineObject({
  id: 'other',
  name: 'Other',
  membership: source(crm),
  properties: {
    id: objectId({ id: 'other.id', access: access.groups.ordinary }),
    portfolio: from(crm.fields.portfolio, {
      id: 'other.portfolio',
      access: access.groups.ordinary,
    }),
  },
});

const base = { id: 'test', objects: { Customer }, access };
const gate = access.role('employee');
const evidenceMaxAgeMs = 1000;

defineGraph({
  ...base,
  policies: {
    Customer: {
      read: {
        gate,
        evidenceMaxAgeMs,
        where: {
          portfolio: { eq: access.claims.portfolio },
          balance: { eq: access.claims.limit },
        },
      },
      groups: { financial: access.role('finance') },
    },
  },
});
// @ts-expect-error role names come from the declaration
access.role('employe');
// @ts-expect-error claim names come from the declaration
access.claims.portoflio;
// @ts-expect-error field groups come from the declaration
access.groups.financal;
// @ts-expect-error classifications require a declared reference
from(crm.fields.balance, { id: 'bad', access: 'financial' });
// @ts-expect-error object identity must remain ordinary
objectId({ id: 'bad.id', access: access.groups.financial });

// prettier-ignore
// @ts-expect-error number claim cannot compare to string property
defineGraph({ ...base, policies: { Customer: { read: { gate, evidenceMaxAgeMs, where: { portfolio: { eq: access.claims.limit } } } } } });

// prettier-ignore
// @ts-expect-error string claim cannot compare to number property
defineGraph({ ...base, policies: { Customer: { read: { gate, evidenceMaxAgeMs, where: { balance: { eq: access.claims.portfolio } } } } } });

// prettier-ignore
// @ts-expect-error boolean claim cannot compare to string property
defineGraph({ ...base, policies: { Customer: { read: { gate, evidenceMaxAgeMs, where: { portfolio: { eq: access.claims.enabled } } } } } });

// prettier-ignore
// @ts-expect-error nullable claim cannot compare to required string
defineGraph({ ...base, policies: { Customer: { read: { gate, evidenceMaxAgeMs, where: { portfolio: { eq: access.claims.nullable } } } } } });

// prettier-ignore
// @ts-expect-error raw claim names are not typed references
defineGraph({ ...base, policies: { Customer: { read: { gate, evidenceMaxAgeMs, where: { portfolio: { eq: { claim: 'portfolio' } } } } } } });

// prettier-ignore
// @ts-expect-error unknown roles cannot widen the access vocabulary
defineGraph({ ...base, policies: { Customer: { read: { gate: { kind: 'role', role: 'admin' } } } } });

// prettier-ignore
// @ts-expect-error policy group names come from the declaration
defineGraph({ ...base, policies: { Customer: { read: { gate }, groups: { financal: gate } } } });

// prettier-ignore
// @ts-expect-error ordinary fields are governed by the object rule
defineGraph({ ...base, policies: { Customer: { read: { gate }, groups: { ordinary: gate } } } });

const ordinaryOnly = defineAccess({
  roles: ['employee'],
  fieldGroups: ['ordinary'],
  claims: {},
});

// prettier-ignore
// @ts-expect-error an ordinary-only declaration has no restricted groups
defineGraph({ ...base, access: ordinaryOnly, policies: { Customer: { read: { gate }, groups: { financial: gate } } } });

const extracted = { Customer: { read: { gate } }, Other: { read: { gate } } };

// prettier-ignore
// @ts-expect-error unknown extracted policy keys cannot widen objects
defineGraph({ ...base, policies: extracted });

defineGraph({ ...base, objects: { Customer, Other }, policies: extracted });

// Native authoring also accepts the ordinary default.
native(z.string(), { id: 'note' });
