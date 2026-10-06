import { z } from 'zod';
import {
  defineAccess,
  defineObject,
  defineSource,
  equals,
  from,
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

access.policy(Customer, {
  read: {
    gate: access.role('employee'),
    where: equals(Customer.properties.portfolio, access.claims.portfolio),
    evidenceMaxAgeMs: 1000,
  },
  groups: { financial: access.role('finance') },
});
equals(Customer.properties.balance, access.claims.limit);
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
// @ts-expect-error number claim cannot compare to string property
equals(Customer.properties.portfolio, access.claims.limit);
// @ts-expect-error string claim cannot compare to number property
equals(Customer.properties.balance, access.claims.portfolio);
// @ts-expect-error boolean claim cannot compare to string property
equals(Customer.properties.portfolio, access.claims.enabled);
// @ts-expect-error nullable claim cannot compare to required string
equals(Customer.properties.portfolio, access.claims.nullable);
// @ts-expect-error raw claim names are not typed claim references
equals(Customer.properties.portfolio, { claim: 'portfolio' });
access.policy(Customer, {
  read: {
    gate: access.role('employee'),
    evidenceMaxAgeMs: 1000,
    // @ts-expect-error the predicate must refer to a property of this object
    where: equals(Other.properties.portfolio, access.claims.portfolio),
  },
});
access.policy(Customer, {
  read: { gate: access.role('employee'), evidenceMaxAgeMs: 1000 },
  groups: {
    // @ts-expect-error policy group names come from the declaration
    financal: access.role('finance'),
  },
});
access.policy(Customer, {
  read: { gate: access.role('employee'), evidenceMaxAgeMs: 1000 },
  groups: {
    // @ts-expect-error ordinary fields are governed by the object rule
    ordinary: access.role('employee'),
  },
});

const ordinaryOnly = defineAccess({
  roles: ['employee'],
  fieldGroups: ['ordinary'],
  claims: {},
});

ordinaryOnly.policy(Customer, {
  read: { gate: ordinaryOnly.role('employee'), evidenceMaxAgeMs: 1000 },
  groups: {
    // @ts-expect-error an ordinary-only declaration has no restricted groups
    financial: ordinaryOnly.role('employee'),
  },
});
