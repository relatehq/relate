import { z } from 'zod';
import {
  computed,
  defineObject,
  native,
  nativeMembership,
  objectId,
} from 'relate';
import type { ComputedPropertyNames, NativeValues, ObjectData } from 'relate';
import type { QueryOptions } from 'relate/consumer';

const Customer = defineObject({
  id: 'customer',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'customer.id' }),
    name: native(z.string(), { id: 'customer.name' }),
    loginCount: computed({
      id: 'customer.login-count',
      sql: 'SELECT COUNT(*) FROM self.events',
    }),
  },
});

export const name: ComputedPropertyNames<typeof Customer> = 'loginCount';
// @ts-expect-error ordinary fields are not declared calculations
export const ordinary: ComputedPropertyNames<typeof Customer> = 'name';
export const nativeValues: NativeValues<typeof Customer> = { name: 'Acme' };

export const writable: NativeValues<typeof Customer> = {
  name: 'Acme',
  // @ts-expect-error computed values cannot be written by native actions
  loginCount: '1',
};

export const data: ObjectData<typeof Customer> = {
  name: 'Acme',
  loginCount: '1',
};

export function selected(
  result: ObjectData<typeof Customer, 'loginCount' | 'name'>,
) {
  const ordinary: string | undefined = result.name;
  const computed: string | number | boolean | null | undefined =
    result.loginCount;
  // @ts-expect-error result type is inferred by runtime, not SQL string types
  const guessed: number | undefined = result.loginCount;

  return [ordinary, computed, guessed];
}

export const query: QueryOptions<typeof Customer> = {
  select: ['name', 'loginCount'],
  where: { loginCount: { gte: '1' } },
};

export const parameterized = computed({
  id: 'bad',
  sql: 'SELECT COUNT(*) FROM self.events',
  // @ts-expect-error calculated declarations do not accept unbound parameter values
  params: { min: 1 },
});

export const policyDependency: import('relate').PolicyWhere<
  { Customer: typeof Customer },
  typeof Customer
> = {
  // @ts-expect-error a row policy cannot depend on a calculated property
  loginCount: { eq: { kind: 'actor-field', name: 'id' } },
};
