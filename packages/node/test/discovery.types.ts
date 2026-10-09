import { createRuntime } from '@relate/node';
import {
  addAccountReview,
  ana,
  graph,
} from '../../../tests/support/native-action-model.js';

const relate = createRuntime({
  graph,
  connections: [],
  actionImplementations: [addAccountReview],
});
const consumer = relate.as(ana);
const graphDescription = consumer.describe();
const customerDescription = consumer.objects.Customer.describe();
const actionDescription = consumer.actions.addAccountReview.describe();

const graphId: string = graphDescription.definitionId;
const customerName: string | undefined = customerDescription?.apiName;
const actionName: string | undefined = actionDescription?.apiName;

// @ts-expect-error discovery does not add unregistered SDK operations
consumer.objects.Missing.describe();
// @ts-expect-error discovery does not add unregistered actions
consumer.actions.missing.describe();

void [graphId, customerName, actionName];
