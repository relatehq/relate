import { z } from 'zod';
import { implementAction, defineAction, referenceInput } from 'relate';
import type { ObjectId } from 'relate';
import {
  graph,
  AddAccountReview,
  AccountReview,
  Customer,
  Invoice,
  access,
} from '../../../tests/support/native-action-model.js';

implementAction(graph, AddAccountReview, async ({ input, actor, objects }) => {
  const customer: ObjectId<typeof Customer.id> = input.customer;

  // @ts-expect-error sourced objects cannot be created
  objects.Customer.create({});
  // @ts-expect-error native create requires its complete values
  objects.AccountReview.create({ customer });
  objects.AccountReview.create({
    // @ts-expect-error callers cannot supply the generated ID
    id: 'chosen',
    customer,
    author: actor.id,
    note: input.note,
  });
  objects.AccountReview.create({
    // @ts-expect-error reference writes preserve target identity
    customer: referenceInput(Invoice).parse('invoice'),
    author: actor.id,
    note: input.note,
  });
  const created = await objects.AccountReview.create({
    customer,
    author: actor.id,
    note: input.note,
  });
  const id: ObjectId<typeof AccountReview.id> = created.id;
  const read = await objects.AccountReview.get(id);

  if (read.status === 'ok') {
    const note: string | undefined = read.data.note;

    void note;
  }

  return { reviewId: id };
});

// @ts-expect-error output cannot return a customer ID as a review ID
implementAction(graph, AddAccountReview, async ({ input }) => ({
  reviewId: input.customer,
}));

defineAction({
  ...AddAccountReview,
  // @ts-expect-error source membership is not a native creation capability
  creates: [Customer],
});

const ReadOnly = defineAction({
  ...AddAccountReview,
  id: 'readonly',
  creates: [],
});
const readOnlyGraph = { ...graph, actions: { readOnly: ReadOnly } };

implementAction(readOnlyGraph, ReadOnly, async ({ objects }) => {
  // @ts-expect-error native objects need an explicit action capability
  await objects.AccountReview.create({
    customer: referenceInput(Customer).parse('c'),
    author: 'ana',
    note: 'n',
  });

  return { reviewId: referenceInput(AccountReview).parse('r') };
});
void access;

defineAction({
  ...AddAccountReview,
  id: 'adopt-native',
  // @ts-expect-error native objects are created, never adopted
  adopts: [AccountReview],
});

// `creates` and `adopts` are both optional.
const Adopting = defineAction({
  id: 'adopting',
  input: z.object({ externalId: z.string() }),
  output: z.object({ customer: referenceInput(Customer) }),
  adopts: [Customer],
});
const adoptingGraph = { ...graph, actions: { adopting: Adopting } };

implementAction(adoptingGraph, Adopting, async ({ input, objects }) => {
  const { id } = await objects.Customer.adopt(input.externalId);
  const customer: ObjectId<typeof Customer.id> = id;

  // @ts-expect-error adopted IDs are branded with their object type
  const wrong: ObjectId<typeof AccountReview.id> = id;

  // @ts-expect-error undeclared source objects have no adopt capability
  await objects.Invoice.adopt('in_1');
  // @ts-expect-error omitted creates grants no create capability
  await objects.AccountReview.create({ customer, author: 'a', note: 'n' });
  void wrong;

  return { customer };
});
