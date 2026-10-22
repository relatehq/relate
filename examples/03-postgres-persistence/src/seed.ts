import type { Relate } from '@relate/node';
import { Customer, customerGraph } from './model.js';

export async function seed(relate: Relate<typeof customerGraph>) {
  await relate.host.adopt(Customer, 'crm_456');
}
