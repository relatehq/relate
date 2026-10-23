import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  implementAction,
  native,
  nativeMembership,
  objectId,
  reference,
  referenceInput,
} from 'relate';

const access = defineAccess({
  roles: ['member'],
  fieldGroups: ['ordinary'],
  claims: {},
});

export const Request = defineObject({
  id: 'approval.request',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'request.id' }),
    title: native(z.string(), { id: 'request.title' }),
    owner: native(z.string(), { id: 'request.owner' }),
  },
});

const Approval = defineObject({
  id: 'approval.record',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'approval.id' }),
    request: reference(Request, { id: 'approval.request-ref' }),
    owner: native(z.string(), { id: 'approval.owner' }),
  },
});
const Submit = defineAction({
  id: 'approval.submit',
  input: z.object({ title: z.string() }),
  output: z.object({ requestId: referenceInput(Request) }),
  creates: [Request],
  policy: { execute: access.role('member') },
});
const Complete = defineAction({
  id: 'approval.complete',
  input: z.object({ requestId: referenceInput(Request) }),
  output: z.object({ approvalId: referenceInput(Approval) }),
  creates: [Approval],
  policy: { execute: access.role('member') },
});
const owned = {
  gate: access.role('member'),
  where: { owner: { eq: access.actor.id } },
  evidenceMaxAgeMs: 0,
};

export const graph = defineGraph({
  id: 'temporal-approval',
  access,
  objects: { Request, Approval },
  actions: { submit: Submit, complete: Complete },
  policies: {
    Request: { read: owned, create: owned },
    Approval: { read: owned, create: owned },
  },
});

export const implementations = [
  implementAction(graph, Submit, async ({ actor, input, objects }) => {
    const request = await objects.Request.create({
      title: input.title,
      owner: actor.id,
    });

    return { requestId: request.id };
  }),
  implementAction(graph, Complete, async ({ actor, input, objects }) => {
    const request = await objects.Request.get(input.requestId, {
      select: ['id'],
    });

    if (request.status !== 'ok') throw new Error('Request is not readable');

    const approval = await objects.Approval.create({
      request: request.id,
      owner: actor.id,
    });

    return { approvalId: approval.id };
  }),
];
