import type { Manifest, Policy } from 'relate/model';
import { ActionError, ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  ReadResult,
  Json,
  FieldEvidence,
} from '@relate/protocol';
import type {
  NativeRecord,
  NativeTransaction,
  ObservationStore,
  NativeScope,
  StoredObject,
} from '../storage.js';
import { allowsField, createAuthorization } from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import { validateReadRequest } from '../resolution/request.js';
import { summarize } from '../resolution/evidence.js';

type ObjectType = Manifest['objects'][number];

export function nativeEvidence(object: ObjectType, record: NativeRecord) {
  const candidate: StoredObject = {
    objectId: record.objectId,
    sourceRecordId: record.objectId,
    observation: {
      state: 'present',
      raw: {},
      values: Object.fromEntries(
        object.properties
          .filter((p) => Object.hasOwn(record.values, p.id))
          .map((p) => [p.name, record.values[p.id]!]),
      ),
      observedAt: record.createdAt,
      token: '0',
    },
  };

  return { candidate, permissionCandidate: candidate };
}

export function createNativeOperations(options: {
  manifest: Manifest;
  scope: NativeScope;
  store: ObservationStore;
  clock(): number;
  resolve(
    object: ObjectType,
    key: string,
    age: number,
    canonical: boolean,
    transaction?: NativeTransaction,
    request?: ReadRequest,
  ): Promise<
    { candidate: StoredObject; permissionCandidate: StoredObject } | undefined
  >;
}) {
  const { manifest, scope, store, clock } = options;
  const authorization = (
    principal: Principal,
    transaction?: NativeTransaction,
    request?: ReadRequest,
  ) =>
    createAuthorization({
      manifest,
      principal,
      clock,
      resolve: (object, key, age, canonical = false) =>
        options.resolve(object, key, age, canonical, transaction, request),
    });

  return {
    async validate(
      principal: Principal,
      object: ObjectType,
      record: NativeRecord,
      transaction: NativeTransaction,
    ) {
      const rule = manifest.createPolicies?.[object.id];

      if (!rule || !principal.roles.includes(rule.role))
        throw new ActionError('denied');

      const evidence = nativeEvidence(object, record);
      const auth = authorization(principal, transaction);

      for (const property of object.properties) {
        if (
          property.access !== 'ordinary' &&
          !principal.roles.includes(
            manifest.policies[object.id]?.groups[property.access]?.role ?? '',
          )
        )
          throw new ActionError('denied');

        if (property.origin.kind !== 'native-reference') continue;

        const targetId = property.origin.targetObjectDefinitionId;
        const target = manifest.objects.find((o) => o.id === targetId)!;
        const id = record.values[property.id];

        if (
          typeof id !== 'string' ||
          !(await options.resolve(
            target,
            id,
            rule.evidenceMaxAgeMs,
            true,
            transaction,
          ))
        )
          throw new ActionError('denied');
      }

      const policy: Policy = { read: rule, groups: {} };

      if (!(await auth.allows(object, evidence, policy)))
        throw new ActionError('denied');
    },
    async read(
      principal: Principal,
      object: ObjectType,
      id: string,
      request: ReadRequest,
      transaction?: NativeTransaction,
      capture?: (check: () => Promise<boolean>) => void,
    ): Promise<ReadResult> {
      validateReadRequest(request);
      const policy = manifest.policies[object.id];

      if (!policy || !principal.roles.includes(policy.read.role))
        return { status: 'not-found' };

      if (!store.native) throw new ReadError('unavailable');

      let record: NativeRecord | undefined;

      try {
        record = transaction
          ? await transaction.load(object.id, id)
          : await store.native.load(scope, object.id, id);
      } catch {
        throw new ReadError('unavailable');
      }

      if (!record) return { status: 'not-found' };

      const evidence = nativeEvidence(object, record);
      const auth = authorization(principal, transaction, request);

      if (!(await auth.allows(object, evidence)))
        return { status: 'not-found' };

      const data: Record<string, Json> = {};
      const fields: Record<string, FieldEvidence> = {};
      const selected =
        request.select ??
        object.properties
          .filter((p) => allowsField(principal, policy, p.access))
          .map((p) => p.name);

      for (const name of selected) {
        const property = object.properties.find((p) => p.name === name);

        if (!property) {
          fields[name] = { status: 'unavailable' };
          continue;
        }

        if (!allowsField(principal, policy, property.access)) {
          fields[name] = { status: 'forbidden' };
          continue;
        }

        let value =
          property.origin.kind === 'object-id'
            ? record.objectId
            : record.values[property.id];

        if (property.origin.kind === 'native-reference') {
          value = await auth.reference(object, evidence, property);

          if (value === undefined) {
            fields[name] = { status: 'unavailable' };
            continue;
          }
        }

        if (value !== undefined) data[name] = value;

        fields[name] = {
          status: value === undefined ? 'absent' : 'available',
          freshness: 'fresh',
          observedAt: new Date(record.createdAt).toISOString(),
          source: 'native',
          retention: 'confirmed',
          retentionDurability: store.durability,
          ordering: 'confirmed',
          refresh: 'not-needed',
        };
      }

      const allowed = async () => {
        if (!(await auth.allows(object, evidence))) return false;

        for (const property of object.properties)
          if (
            property.origin.kind === 'native-reference' &&
            Object.hasOwn(data, property.name) &&
            (await auth.reference(object, evidence, property)) !==
              data[property.name]
          )
            return false;

        return true;
      };

      if (!(await allowed())) return { status: 'not-found' };

      capture?.(allowed);
      const summary = summarize(fields);

      if (summary.completeness === 'partial' && request.requireComplete)
        throw new ReadError('incomplete');

      return {
        status: 'ok',
        data,
        meta: {
          ...summary,
          definitionRevision: scope.definitionRevision,
          fields,
          warnings: [],
        },
      };
    },
  };
}
