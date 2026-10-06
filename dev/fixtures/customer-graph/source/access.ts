import { z } from 'zod';
import { defineAccess } from '../validation/target.js';

export const access = defineAccess({
  roles: ['employee', 'finance', 'account-manager'],
  fieldGroups: ['ordinary', 'financial'],
  claims: { organization: z.string() },
});
