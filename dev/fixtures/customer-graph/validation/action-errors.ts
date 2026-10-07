/** Broader proposed receipt surface (pending/runtime failures/transformed details).
 * Portable declared domain failures execute in the packages; see tests/support/domain-action-contract.ts. */
import { z } from 'zod';
import { defineAction, implementAction } from './target.js';
import type { Consumer, DomainActionError, Receipt } from './target.js';
import { graph } from '../source/graph.js';
import { EscalateAccount } from '../source/actions/escalate-account.js';
import { AddAccountReview } from '../source/actions/add-account-review.js';

type Expect<T extends true> = T;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type EscalationReceipt = Awaited<
  ReturnType<Consumer<typeof graph>['actions']['escalateAccount']>
>;

export type InferredReceipt = Expect<
  Equal<
    EscalationReceipt,
    Exclude<Receipt<typeof EscalateAccount>, { state: 'pending' }>
  >
>;

export type DeclaredCodes = Expect<
  Equal<
    DomainActionError<typeof EscalateAccount>['code'],
    'inactive' | 'tooManyInvoices'
  >
>;

export type NoDeclaredErrors = Expect<
  Equal<DomainActionError<typeof AddAccountReview>, never>
>;

defineAction({
  ...AddAccountReview,
  errors: {
    // @ts-expect-error each declared error needs a details schema
    inactive: 'Inactive customer',
  },
});

implementAction(graph, EscalateAccount, async ({ fail }) => {
  const abort: Expect<Equal<ReturnType<typeof fail>, never>> = true;

  void abort;

  return fail('tooManyInvoices', { limit: 1_000 });
});

implementAction(graph, EscalateAccount, async ({ fail }) => {
  // @ts-expect-error unknown domain error code
  fail('typo', {});
  // @ts-expect-error runtime errors are not declared domain errors
  fail('internal', {});
  // @ts-expect-error required details cannot be omitted
  fail('tooManyInvoices');
  // @ts-expect-error required limit is missing
  fail('tooManyInvoices', {});
  // @ts-expect-error details follow the selected schema
  fail('tooManyInvoices', { limit: '1000' });
  // @ts-expect-error inactive declares empty details
  fail('inactive', { limit: 1_000 });

  return fail('inactive', {});
});

implementAction(graph, AddAccountReview, async ({ fail }) => {
  // @ts-expect-error omission of errors permits no domain failure codes
  return fail('inactive', {});
});

const ParsedErrors = defineAction({
  ...AddAccountReview,
  errors: {
    count: z.object({ value: z.string().transform(Number) }),
    reason: z.object({ reason: z.string() }),
  },
});

implementAction(graph, ParsedErrors, async ({ fail }) => {
  const code: 'count' | 'reason' = Math.random() > 0.5 ? 'count' : 'reason';

  // @ts-expect-error a union code cannot accept details for only one member
  fail(code, { reason: 'not enough' });
  // @ts-expect-error fail accepts schema input, not transformed output
  fail('count', { value: 5 });

  return fail('count', { value: '5' });
});

export function parsedDetails(receipt: Receipt<typeof ParsedErrors>) {
  if (receipt.state !== 'failed' || receipt.error.kind !== 'domain') return;

  if (receipt.error.code === 'count') {
    const output: Expect<Equal<typeof receipt.error.details.value, number>> =
      true;

    void output;
    // @ts-expect-error narrowing the code excludes the other details
    receipt.error.details.reason;
  }
}

export function handle(receipt: EscalationReceipt) {
  if (receipt.state === 'succeeded') {
    // @ts-expect-error success has output, not an error
    receipt.error;

    return receipt.output.taskIds;
  }

  // @ts-expect-error only success has output
  receipt.output;

  if (receipt.state !== 'failed') {
    // @ts-expect-error pending and uncertain do not claim a confirmed failure
    receipt.error;

    return;
  }

  if (receipt.error.kind === 'runtime') {
    // @ts-expect-error runtime errors expose no arbitrary exception details
    receipt.error.details;

    return receipt.error.code;
  }

  switch (receipt.error.code) {
    case 'inactive': {
      const empty: Expect<
        Equal<typeof receipt.error.details, Record<string, never>>
      > = true;

      void empty;

      return;
    }
    case 'tooManyInvoices': {
      const limit: number = receipt.error.details.limit;

      return limit;
    }
    default: {
      const exhaustive: never = receipt.error;

      return exhaustive;
    }
  }
}

// @ts-expect-error a failed receipt must explain the failure
const missingError: EscalationReceipt = {
  invocationId: 'inv_failed',
  state: 'failed',
};

void missingError;

const invalidDetails: DomainActionError<typeof EscalateAccount> = {
  kind: 'domain',
  code: 'tooManyInvoices',
  // @ts-expect-error receipt details follow the selected code
  details: { limit: '1000' },
};

void invalidDetails;
