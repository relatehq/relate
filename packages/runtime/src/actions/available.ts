import type { Manifest } from 'relate/model';
import { allowsObject, type Principal } from '../authorization/index.js';

type Action = NonNullable<Manifest['actions']>[number];

/**
 * The role-level gate on an action: an identified actor holding the execute
 * role who may read every object type its input references. Reference values
 * are still checked record by record during execution.
 */
export function actionAllowed(
  manifest: Manifest,
  actor: Principal,
  action: Action,
): boolean {
  return Boolean(
    action.execute &&
    actor.id.trim() &&
    actor.roles.includes(action.execute.role) &&
    Object.values(action.input).every(
      ({ references }) =>
        !references ||
        allowsObject(
          actor,
          Object.hasOwn(manifest.policies, references)
            ? manifest.policies[references]
            : undefined,
        ),
    ),
  );
}
