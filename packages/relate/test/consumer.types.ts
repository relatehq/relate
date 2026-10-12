import type { ConsumerDescription } from 'relate/consumer';
import { createConsumer } from 'relate/consumer';
import { compile } from 'relate/compiler';
import type { ConsumerOperations } from '@relate/protocol';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';
import type { graph as actionGraph } from '../../../tests/support/native-action-model.js';
import type { ObjectId } from 'relate';

function descriptions(operations: ConsumerOperations) {
  const { graph } = createInvoiceGraph();
  const description = compile(graph).consumer;
  const typed: ConsumerDescription<typeof graph> = description;

  const missing: ConsumerDescription<typeof graph> = {
    ...description,
    // @ts-expect-error the actual object registry must match the graph
    objects: {},
  };

  // @ts-expect-error definition IDs are tied to their registered objects
  typed.objects.Customer.definitionId satisfies 'wrong-id';
  const wrong: typeof description.objects.Customer = {
    ...description.objects.Customer,
    // @ts-expect-error a generated artifact cannot swap object definition IDs
    definitionId: 'business.invoice',
  };
  const edges: typeof description.objects.Customer = {
    ...description.objects.Customer,
    // @ts-expect-error required traversal cannot be omitted
    traversals: {},
  };
  const edge: typeof description.objects.Customer.traversals.invoices = {
    // @ts-expect-error cardinality comes from the authored relationship
    cardinality: 'one',
    target: 'Invoice',
  };
  const target: typeof description.objects.Customer.traversals.invoices = {
    cardinality: 'many',
    // @ts-expect-error target must name the related registry entry
    target: 'Customer',
  };

  // @ts-expect-error object names cannot be invented
  createConsumer(description, operations).objects.Missing.query();

  void [missing, wrong, edges, edge, target];
}

// A generated client has declarations and a JSON artifact, without runtime authoring imports.
function remoteReceipts(
  description: ConsumerDescription<typeof actionGraph>,
  operations: ConsumerOperations,
) {
  const consumer = createConsumer(description, operations);
  const receipt = consumer.receipts.get('addAccountReview', 'inv-1');

  receipt.then((saved) => {
    const id: ObjectId<'business.account-review'> = saved.output.reviewId;

    return id;
  });
  // @ts-expect-error receipt lookup accepts only registered names
  consumer.receipts.get('missing', 'inv-1');
  // @ts-expect-error the generated artifact must include its actions
  const absent: ConsumerDescription<typeof actionGraph>['actions'] = {};

  void absent;
}

void descriptions;
void remoteReceipts;
