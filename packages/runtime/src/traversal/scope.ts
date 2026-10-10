import { createHash } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import type { ReadRequest } from '@relate/protocol';
import type { Principal } from '../authorization/index.js';
import type { Predicate } from '../reads/index.js';
import type { TraversalOptions } from './traversal.js';

/** Cursors bind to everything that shapes a traversal page except presentation. */
export function traversalScope(
  options: TraversalOptions,
  input: {
    principal: Principal;
    typeId: string;
    id: string;
    relationship: string;
    forward: boolean;
    query: ReadRequest & { limit: number; where: readonly Predicate[] };
  },
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        graphId: options.graphId,
        revision: options.revision,
        ...input,
        bindings: options.manifest.objects
          .filter((o) => o.sourceDefinitionId)
          .map((o) => options.scopeFor(o.id, o.sourceDefinitionId!)),
      }),
    )
    .digest('hex');
}
