# 02 · Connected sources

Combine existing systems into one graph. A customer workspace explores one
account across an HTTP CRM, SQLite invoices, and Relate-owned account reviews in
the Inspector.

From the repository root:

```sh
pnpm install
pnpm example:connected-sources
```

The command builds dependencies, starts a CRM simulator and temporary SQLite
billing database, seeds the runtime, and opens the Inspector. No credentials or
database server are required. Use `--no-open` to print the link without opening
a browser. Ctrl+C stops the owned Inspector and removes its temporary database.
State resets on restart. A second invocation reuses the existing Inspector; stop
it from its owning terminal.

The launcher loads the root `.env` if present, preserving exported variables.
Set `ANTHROPIC_API_KEY` there to enable the optional Inspector agent. The graph
and Playground work without a key. Restart the Inspector after changing `.env`.

## Explore in the Inspector

The seed adopts Mothlight (`crm_456`) and two invoices: `INV-1042` (overdue, GBP
4,800) and `INV-1043` (paid, GBP 1,250). Reviews start empty.

- Select **Ana**, an account manager: invoice amounts and currency are visible;
  customer revenue is withheld. Ana can create account reviews.
- Select **Fin**, in finance: customer revenue is visible; invoice amounts and
  currency are withheld. Fin cannot create reviews.
- Explore Customer, Invoice and AccountReview and their relationships. Editing
  `src/graph.ts` reloads the model and reruns the seed.

In the Playground as Ana, create a review and retry the same request:

```ts
const page = await graph.objects.Customer.query({ select: ['name'] });
const customer = page.data[0];
const request = {
  input: { customer: customer.id, note: 'Follow up Friday' },
  idempotencyKey: 'review-1',
};
const receipt = await graph.actions.addAccountReview(request);
const replay = await graph.actions.addAccountReview(request);
return {
  receipt,
  replay,
  review: await graph.objects.AccountReview.get(receipt.output.reviewId),
};
```

The retry returns the original receipt without creating another review. Read
reviews by their returned IDs; native-reference traversal is not implemented.
The development principals are local demo identities, not authentication.

## SDK walkthrough

```sh
pnpm example:connected-sources:walkthrough
```

This starts a fresh runtime, prints customer and invoice reads as Ana and Fin,
creates a review, retries it, reads the committed review, and exits. Its data is
disposable and separate from any running Inspector.

## Code map

- `src/graph.ts`: objects, sources, relationships, policies and action
  definition.
- `src/app.ts`: deferred provider setup, bindings, action implementation and
  cleanup.
- `src/seed.ts`: explicit adoption of the customer and invoices.
- `src/crm-connector.ts`: example-local HTTP source adapter.
- `src/index.ts`: scripted SDK walkthrough.
- `relate.config.ts`: app and seed exports for the Inspector.

SQLite owns invoice source data; Relate's memory store owns observations,
reviews and receipts. Billing references the CRM record ID directly. This is not
a source scan, cross-source key-matching or enrichment example.

For provider changes, refresh, denial and restart recovery, continue to the
[persistence walkthrough](../03-persistence/README.md). See the
[ordered examples](../README.md) for the full learning path.
