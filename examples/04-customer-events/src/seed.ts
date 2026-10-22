import type { Relate } from '@relate/node';
import type { ObjectId } from 'relate';
import { Customer, graph, declaredGraph } from './graph.js';
import { customers } from './data.js';

async function adoptCustomers(
  adopt: (key: string) => Promise<ObjectId<typeof Customer.id>>,
) {
  const ids: Record<string, ObjectId<typeof Customer.id>> = {};

  for (const [key] of customers) ids[key] = await adopt(key);

  return ids;
}

// Only customers are adopted. Event rows remain in the analytical dataset.
export const seed = (runtime: Relate<typeof graph>) =>
  adoptCustomers((key) => runtime.host.adopt(Customer, key));

export const seedDeclared = (runtime: Relate<typeof declaredGraph>) =>
  adoptCustomers((key) =>
    runtime.host.adopt(declaredGraph.objects.Customer, key),
  );
