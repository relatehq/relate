import type { Relate } from '@relate/node';
import { graph, Customer, Invoice } from './graph.js';

/** Adopt the known demo records from the providers started by app.setup. */
export async function seed(relate: Relate<typeof graph>) {
  // This is a fixture, not a general source scan or sync API.
  const customerId = await relate.host.adopt(Customer, 'crm_456');

  await relate.host.adopt(Invoice, 'INV-1042');
  await relate.host.adopt(Invoice, 'INV-1043');

  return { customerId };
}
