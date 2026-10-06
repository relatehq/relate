import { defineGraph, referenceInput } from 'relate';
import {
  access,
  Customer,
  Invoice,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';
import { createRuntime } from '@relate/node';
import {
  graph,
  ana,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';

const gate = access.role('employee');
const evidenceMaxAgeMs = 1000;
const portfolio = access.claims.portfolio;
const typo = {
  customer: { portfolio: { eq: portfolio }, portoflio: { eq: portfolio } },
};
const valid = { customer: { portfolio: { eq: portfolio } } };

// Inference comes from objects declared in this same call.
defineGraph({
  id: 'inference',
  objects: { Customer, Invoice },
  access,
  policies: {
    Customer: { read: 'deny' },
    Invoice: { read: { gate, evidenceMaxAgeMs, where: valid } },
  },
});

// prettier-ignore
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: { customer: { portfolio: { eq: portfolio } } } } } } });

// prettier-ignore
// @ts-expect-error unknown nested property
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: { customer: { portoflio: { eq: portfolio } } } } } } });

// prettier-ignore
// @ts-expect-error incompatible claim
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: { totalMinor: { eq: portfolio } } } } } });

// prettier-ignore
// @ts-expect-error extracted surplus fields must not disappear structurally
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, evidenceMaxAgeMs, where: typo } } } });

// prettier-ignore
// @ts-expect-error predicates require a freshness bound
defineGraph({ ...graph, policies: { ...graph.policies, Invoice: { read: { gate, where: valid } } } });

// prettier-ignore
// @ts-expect-error role-only rules have no evidence bound
defineGraph({ ...graph, policies: { ...graph.policies, Customer: { read: { gate, evidenceMaxAgeMs } } } });

// prettier-ignore
// @ts-expect-error unregistered policy object cannot widen the registry
defineGraph({ id: 'invalid', objects: { Customer }, access, policies: { Customer: { read: 'deny' }, Invoice: { read: { gate } } } });

// prettier-ignore
// @ts-expect-error every registered object needs an explicit policy
defineGraph({ id: 'invalid', objects: { Customer, Invoice }, access, policies: { Customer: { read: 'deny' } } });

// prettier-ignore
// @ts-expect-error every object policy needs an explicit read decision
defineGraph({ ...graph, policies: { ...graph.policies, Customer: {} } });

// prettier-ignore
// @ts-expect-error object arrays are not registries
defineGraph({ ...graph, objects: [Customer, Invoice] });

// prettier-ignore
// @ts-expect-error deny does not grant field groups
defineGraph({ ...graph, policies: { ...graph.policies, Customer: { read: 'deny', groups: { financial: gate } } } });

// prettier-ignore
// @ts-expect-error reference targets must come from the same object registry
defineGraph({ id: 'invalid', objects: { Invoice }, access, policies: { Invoice: { read: { gate, evidenceMaxAgeMs, where: valid } } } });

const relate = createRuntime({ graph, connections: [] });

async function read() {
  const invoice = await relate
    .as(ana)
    .objects.Invoice.get(referenceInput(Invoice).parse('id'), {
      select: ['customer', 'totalMinor'],
    });

  if (invoice.status === 'ok') {
    const customer: string | undefined = invoice.data.customer;
    const amount: number | undefined = invoice.data.totalMinor;

    // @ts-expect-error not selected
    invoice.data.status;

    return { customer, amount };
  }
}

void read;
