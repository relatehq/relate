/** Server-only, application-scoped binder; not global state or authorization. */
import { createActionImplementer } from '../../validation/target.js';
import { access } from '../access.js';

// Feature implementation modules share the application's role/claim vocabulary.
export const implementAction = createActionImplementer(access);
