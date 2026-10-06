/** Server-only binding. Shared model context provides types, not grants. */
import { createActionImplementer } from '../../validation/target.js';
import { access } from '../access.js';
import { objects, relationships } from '../model.js';

export const implementAction = createActionImplementer({
  access,
  objects,
  relationships,
});
