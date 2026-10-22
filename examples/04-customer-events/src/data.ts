/** The example's source records, also used by its explicit adoption seed. */
export const customers = [
  ['crm_acme', 'Acme', 'portfolio_north', '2026-09-30T00:00:00.000Z'],
  ['crm_globex', 'Globex', 'portfolio_north', '2026-10-01T00:00:00.000Z'],
  ['crm_initech', 'Initech', 'portfolio_north', '2026-01-15T00:00:00.000Z'],
  ['crm_umbrella', 'Umbrella', 'portfolio_south', '2026-05-01T00:00:00.000Z'],
] as const;

export const events = [
  ['crm_acme', 'login', '2026-09-28T08:00:00.000Z', 'u_1'],
  ['crm_acme', 'login', '2026-10-02T09:00:00.000Z', 'u_1'],
  ['crm_acme', 'login', '2026-10-09T10:30:00.000Z', 'u_2'],
  ['crm_acme', 'page_view', '2026-10-09T10:31:00.000Z', 'u_2'],
  ['crm_globex', 'login', '2026-10-03T14:00:00.000Z', 'u_7'],
  ['crm_umbrella', 'login', '2026-10-04T11:00:00.000Z', 'u_9'],
] as const;
