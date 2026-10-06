import { assertFields } from 'relate';
import type { Json, ReadResult } from '@relate/protocol';

type CustomerResult =
  | { readonly status: 'not-found' }
  | {
      readonly status: 'ok';
      readonly id: string;
      readonly data: {
        readonly name?: string;
        readonly status?: 'active' | 'inactive';
        readonly manager?: string | null;
      };
      readonly meta: { readonly completeness: 'complete' | 'partial' };
    };

declare function readCustomer(): CustomerResult;

const customer = readCustomer();

assertFields(customer, ['name', 'manager']);
const name: string = customer.data.name;
const manager: string | null = customer.data.manager;
const id: string = customer.id;
const status: 'ok' = customer.status;
const completeness: 'complete' | 'partial' = customer.meta.completeness;

// @ts-expect-error unchecked fields remain optional
const unchecked: 'active' | 'inactive' = customer.data.status;
// @ts-expect-error a legitimate schema null is preserved
const nonNull: string = customer.data.manager;

// @ts-expect-error required fields must belong to the result's selected fields
assertFields(customer, ['missing']);
// @ts-expect-error the assertion preserves readonly properties
customer.data.name = 'Changed';

const tupleResult = readCustomer();
const required = ['name', 'status'] as const;

assertFields(tupleResult, required);
const active: 'active' | 'inactive' = tupleResult.data.status;
const tupleName: string = tupleResult.data.name;

const empty = readCustomer();

assertFields(empty, []);
const emptyStatus: 'ok' = empty.status;

// @ts-expect-error an empty list does not establish any field's presence
const emptyName: string = empty.data.name;

const dynamicResult = readCustomer();
const dynamic: ('name' | 'status')[] = [];

assertFields(dynamicResult, dynamic);
const dynamicStatus: 'ok' = dynamicResult.status;

// @ts-expect-error a dynamic array might not contain name
const dynamicName: string = dynamicResult.data.name;

declare const key: 'name' | 'status';
const unionResult = readCustomer();

assertFields(unionResult, [key]);
// @ts-expect-error checking one of two fields does not establish both
const unionName: string = unionResult.data.name;
// @ts-expect-error checking one of two fields does not establish both
const unionStatus: 'active' | 'inactive' = unionResult.data.status;

const sequential = readCustomer();

assertFields(sequential, ['name']);
assertFields(sequential, ['status']);
const sequentialName: string = sequential.data.name;
const sequentialStatus: 'active' | 'inactive' = sequential.data.status;

declare function readJson(): ReadResult;

const json = readJson();

assertFields(json, ['name']);
const jsonName: Json = json.data.name;

// @ts-expect-error presence does not infer a schema for protocol JSON values
const jsonString: string = json.data.name;
// @ts-expect-error unrelated protocol fields still include undefined
const otherJson: Json = json.data.other;

declare const broadKey: string;
declare const indexed: {
  status: 'ok';
  data: Record<string, string | undefined>;
};

assertFields(indexed, [broadKey]);
// Checking an arbitrary string must not narrow every entry in an index signature.
indexed.data.unchecked = undefined;

// Keep the positive type probes visible to lint without executing this file.
void [
  name,
  manager,
  id,
  status,
  completeness,
  unchecked,
  nonNull,
  active,
  tupleName,
  emptyStatus,
  emptyName,
  dynamicStatus,
  dynamicName,
  unionName,
  unionStatus,
  sequentialName,
  sequentialStatus,
  jsonName,
  jsonString,
  otherJson,
];
