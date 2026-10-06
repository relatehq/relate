import { createQuery } from '@relate/runtime';
import type { QueryResult } from '@relate/runtime';
import type { Page, PageMeta } from '@relate/protocol';

const final: PageMeta = { exhausted: true };
const continuing: PageMeta = { exhausted: false, continuationCursor: 'next' };
// @ts-expect-error non-final pages must provide continuation
const missing: PageMeta = { exhausted: false };
// @ts-expect-error final pages omit continuation
const contradictory: PageMeta = { exhausted: true, continuationCursor: 'next' };
// @ts-expect-error nullable cursors no longer represent exhaustion
const nullable: PageMeta = { exhausted: false, continuationCursor: null };
const extra = { exhausted: true, continuationCursor: 'next' } as const;
// @ts-expect-error contradictory non-literal values are also rejected
const indirect: PageMeta = extra;

type Invoice = {
  readonly id: string;
  readonly data: { readonly status?: string };
  readonly meta: { readonly completeness: 'complete' | 'partial' };
};

declare const read: (cursor: string | undefined) => Promise<Page<Invoice>>;
const query: QueryResult<Invoice> = createQuery(read);
const page: Page<Invoice> = await query;

if (!page.meta.exhausted) {
  const cursor: string = page.meta.continuationCursor;

  void cursor;
}

for await (const invoice of query) {
  const id: string = invoice.id;
  const status: string | undefined = invoice.data.status;
  const evidence: 'complete' | 'partial' = invoice.meta.completeness;

  // @ts-expect-error selection is preserved
  invoice.data.amount;
  // @ts-expect-error iteration does not imply required-field presence
  const required: string = invoice.data.status;

  void [id, status, evidence, required];
}

void [final, continuing, missing, contradictory, nullable, indirect];
