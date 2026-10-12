import type { OperationContracts } from '@relate/protocol';
import { deepFreeze } from 'relate/model';
import { optionDescriptions, type ReadOperation } from './reads/index.js';

const names = (operation: ReadOperation) =>
  optionDescriptions(operation).map((option) => option.name);

export const operationContracts: OperationContracts = deepFreeze({
  get: {
    signature: '<Object>.get(id: ObjectId, options?)',
    returns: 'Promise<ObjectResult>',
    description:
      "Read one record by its Relate object ID. A record this reader may not see is 'not-found', the same as a missing record.",
    options: names('get'),
  },
  query: {
    signature: '<Object>.query(options?)',
    returns: 'QueryResult<ObjectRecord>',
    collectionScope: 'graph-membership',
    description:
      'Page through records of one object type that are already in this graph, not every record in the source system. Filter with where; page with limit and cursor, or iterate with for await. Results have no caller-defined order.',
    options: names('query'),
  },
  traverse: {
    description:
      "`traverse` is an object of named functions, one for each traversal an object lists; it is not itself callable. Call traverse.<name>(id, options) with the starting record's ID. Use the traversal's cardinality to choose the contract below.",
    many: {
      signature: '<Object>.traverse.<name>(id: ObjectId, options?)',
      returns: 'QueryResult<ObjectRecord>',
      description:
        'Records related to one starting record, paged like query. Traversals do not filter: use select here, or query the target object with where.',
      options: names('traverse-many'),
    },
    one: {
      signature: '<Object>.traverse.<name>(id: ObjectId, options?)',
      returns: 'Promise<ObjectResult>',
      description:
        "The single record related to one starting record, or 'not-found'.",
      options: names('traverse-one'),
    },
  },
  options: optionDescriptions(),
  shapes: {
    ObjectId:
      "An opaque string naming one Relate object: a record's `id`, or the value of a reference property. Source-system IDs are not Relate object IDs.",
    ObjectResult:
      "{ status: 'ok', id: ObjectId, data: { [property]: value }, meta: ReadMeta } | { status: 'not-found' }",
    ObjectRecord:
      '{ id: ObjectId, data: { [property]: value }, meta: ReadMeta }; a page entry, without status.',
    ReadMeta:
      "{ evidence: 'compact' | 'full', completeness: 'complete' | 'partial', degraded: boolean, definitionRevision: string, fields?: { [property]: { status: 'available' | 'absent' | 'forbidden' | 'unavailable', … } }, warnings?: string[] }. A selected property missing from data is explained in meta.fields.",
    Page: '{ data: ObjectRecord[], meta: { exhausted: true } | { exhausted: false, continuationCursor: string } }. exhausted: false can come with an empty data array; keep paging.',
    QueryResult:
      'A lazy handle. `await result` reads one Page. `for await (const record of result)` yields every ObjectRecord across all pages. To resume later, call the same operation with the same options plus cursor: page.meta.continuationCursor.',
  },
  errors:
    "Invalid calls throw ReadError with code 'invalid-request'; error.issues names each invalid option, filter or argument, and the message lists the accepted options. 'unavailable' means a source could not be read; 'incomplete' means required evidence (requireComplete, or a where property) was missing.",
});
