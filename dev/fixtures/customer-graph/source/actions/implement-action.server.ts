/** Server-only binding. Object names and access provide types, not grants. */
import { createActionImplementer } from '../../validation/target.js';
import { access } from '../access.js';
import { objects } from '../model.js';

export const implementAction = createActionImplementer({ access, objects });
