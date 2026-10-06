import { referenceInput } from 'relate';
import {
  access,
  Customer,
  Invoice,
  objects,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';
import { createRuntime } from '@relate/node';
import {
  graph,
  ana,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';

const { policy } = access.forObjects(objects);
const gate = access.role('employee');
const evidenceMaxAgeMs = 1000;
const portfolio = access.claims.portfolio;

policy(Invoice, {
  read: {
    gate,
    evidenceMaxAgeMs,
    where: { customer: { portfolio: { eq: portfolio } } },
  },
});
policy(Customer, { read: { gate } });
policy(Invoice, {
  read: {
    gate,
    evidenceMaxAgeMs,
    // @ts-expect-error unknown nested property
    where: { customer: { portoflio: { eq: portfolio } } },
  },
});
policy(Invoice, {
  // @ts-expect-error incompatible claim
  read: { gate, evidenceMaxAgeMs, where: { totalMinor: { eq: portfolio } } },
});
const typo = {
  customer: { portfolio: { eq: portfolio }, portoflio: { eq: portfolio } },
};

// @ts-expect-error extracted surplus fields must not disappear structurally
policy(Invoice, { read: { gate, evidenceMaxAgeMs, where: typo } });
policy(Invoice, {
  // @ts-expect-error predicates require a freshness bound
  read: { gate, where: { customer: { portfolio: { eq: portfolio } } } },
});
// @ts-expect-error role-only rules have no evidence bound
policy(Customer, { read: { gate, evidenceMaxAgeMs } });
// @ts-expect-error unregistered policy object
access.forObjects({ Customer }).policy(Invoice, { read: { gate } });
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
