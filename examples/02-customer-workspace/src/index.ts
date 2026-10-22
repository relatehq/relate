import { startApp } from '@relate/node';
import { app, actors } from './app.js';
import { seed } from './seed.js';

const relate = await startApp(app);

try {
  const { customerId } = await seed(relate);

  for (const actor of [actors.ana, actors.fin]) {
    const { objects } = relate.as(actor);

    console.log(
      JSON.stringify(
        {
          actor: actor.id,
          customer: await objects.Customer.get(customerId),
          invoices: await objects.Customer.traverse.invoices(customerId),
        },
        null,
        2,
      ),
    );
  }

  const ana = relate.as(actors.ana);
  const request = {
    input: { customer: customerId, note: 'Follow up Friday' },
    idempotencyKey: 'review-1',
  };
  const receipt = await ana.actions.addAccountReview(request);
  const replay = await ana.actions.addAccountReview(request);

  console.log('Review receipt:', receipt);
  console.log('Retried receipt:', replay);
  console.log(
    'Created review:',
    await ana.objects.AccountReview.get(receipt.output.reviewId),
  );
} finally {
  await relate.close();
}
