import type { Manifest, Policy } from 'relate/model';
import { ActionError, ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  FullReadResult as ReadResult,
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
import {
  allowsField,
  allowsObject,
  createAuthorization,
  operationName,
} from '../authorization/index.js';
import type {
  Principal,
  AuthorizationEvidence,
} from '../authorization/index.js';
import { validateReadRequest, summarize } from '../reads/index.js';

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
          .map((p) => [p.id, record.values[p.id]!]),
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
  install(): Promise<void>;
  resolve(
    object: ObjectType,
    key: string,
    age: number,
    canonical: boolean,
    transaction?: NativeTransaction,
    request?: ReadRequest,
  ): Promise<AuthorizationEvidence | undefined>;
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

        const targetEvidence =
          typeof id === 'string'
            ? await options.resolve(
                target,
                id,
                rule.evidenceMaxAgeMs,
                true,
                transaction,
              )
            : undefined;

        if (!targetEvidence || !(await auth.allows(target, targetEvidence)))
          throw new ActionError('not-found');
      }

      const policy: Policy = { read: rule, groups: {} };

      if (!(await auth.allows(object, evidence, policy)))
        throw new ActionError('denied');
    },
    async read(
      principal: Principal,
      objectDefinitionId: string,
      id: string,
      request: ReadRequest,
      transaction?: NativeTransaction,
      capture?: (check: () => Promise<boolean>) => void,
    ): Promise<ReadResult> {
      validateReadRequest(
        request,
        operationName(manifest, principal, objectDefinitionId, 'get'),
      );
      const object = manifest.objects.find((o) => o.id === objectDefinitionId);
      const policy = Object.hasOwn(manifest.policies, objectDefinitionId)
        ? manifest.policies[objectDefinitionId]
        : undefined;

      if (!object || !allowsObject(principal, policy))
        return { status: 'not-found' };

      await options.install();

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
          evidence: 'full',
          ...summary,
          definitionRevision: scope.definitionRevision,
          fields,
          warnings: [],
        },
      };
    },
  };
}
