import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  nativeMembership,
  native,
  objectId,
} from 'relate';

const access = defineAccess({
  roles: ['reader', 'finance'],
  fieldGroups: ['ordinary'],
  claims: { region: z.string().nullable() },
});
const Note = defineObject({
  id: 'notes.note',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'note.id' }),
    body: native(z.string(), { id: 'note.body' }),
  },
});
const base = {
  id: 'notes',
  objects: { Note },
  access,
  policies: { Note: { read: { gate: access.role('reader') } } },
} as const;

defineGraph({
  ...base,
  principals: {
    alice: { roles: ['reader'], claims: { region: 'eu' } },
    auditor: { roles: ['reader', 'finance'], claims: { region: null } },
  },
});

defineGraph({
  ...base,
  // @ts-expect-error roles come from the access declaration
  principals: {
    alice: { roles: ['admin'] },
  },
});

defineGraph({
  ...base,
  // @ts-expect-error claim values follow the claim schema
  principals: {
    alice: { roles: ['reader'], claims: { region: 1 } },
  },
});
