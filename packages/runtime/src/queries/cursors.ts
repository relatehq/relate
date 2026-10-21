import { createHash } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import type { Manifest } from 'relate/model';
import type { Principal } from '../authorization/index.js';
import { cursorCodec } from '../reads/index.js';
import type { NativeScope, StorageScope } from '../storage.js';

/** One cursor codec and scope contract for ordinary and analytical object queries. */
export function createQueryCursors(options: {
  readonly manifest: Manifest;
  readonly scope: NativeScope;
  readonly cursorKey?: Uint8Array;
  clock(): number;
  scopeFor(type: string, source: string): StorageScope;
}) {
  const codec = cursorCodec(options.cursorKey);

  return (
    type: string,
    principal: Principal,
    query: unknown,
    analytical?: unknown,
    transaction?: string,
  ) => {
    const scope = createHash('sha256')
      .update(
        canonicalJson({
          ...options.scope,
          type,
          principal,
          transaction: transaction ?? null,
          query,
          ...(analytical === undefined ? {} : { analytical }),
          bindings: options.manifest.objects
            .filter((object) => object.sourceDefinitionId)
            .map((object) =>
              options.scopeFor(object.id, object.sourceDefinitionId!),
            ),
        }),
      )
      .digest('hex');

    return {
      decode: (token: string, operation: string) =>
        codec.decode(token, scope, options.clock(), operation),
      encode: (after: string, operation = 'query') =>
        codec.encode(scope, after, options.clock() + 900_000, operation),
    };
  };
}

export type QueryCursors = ReturnType<typeof createQueryCursors>;
