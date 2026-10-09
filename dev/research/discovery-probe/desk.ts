import type { Sdk } from './sdk.js';

/**
 * A small support-desk graph owned by the probe. It is unrelated to AppWorld and
 * to the examples, and exercises every read the probe asks about: paging past
 * one page, equality filters on references, a one-to-many traversal, its
 * to-one reverse, and a many-to-many traversal through assignments.
 */
export const accounts = [
  'Northwind Traders',
  'Contoso',
  'Fabrikam',
  'Adventure Works',
  'Tailspin Toys',
  'Wide World Importers',
  'Litware',
  'Proseware',
].map((name, i) => ({
  id: `acct-${i + 1}`,
  name,
  tier: i % 3 === 0 ? 'enterprise' : 'standard',
}));

export const agents = [
  'Ada Brooks',
  'Ben Carter',
  'Chloe Diaz',
  'Dev Patel',
  'Elif Kaya',
  'Femi Okafor',
].map((name, i) => ({ id: `agent-${i + 1}`, name }));

const issues = [
  'Cannot reset password',
  'Invoice shows wrong tax',
  'Dashboard loads slowly',
  'Export to CSV fails',
  'Login loop on mobile',
  'Missing email notifications',
  'Report totals do not match',
  'API returns 500 on upload',
];

export const tickets = Array.from({ length: 64 }, (_, i) => ({
  id: `tkt-${String(i + 1).padStart(3, '0')}`,
  subject:
    i === 17
      ? 'Printer jams on tray 2'
      : i === 42
        ? 'VPN drops every hour'
        : `${issues[i % issues.length]} (#${i + 1})`,
  status: i % 3 === 0 ? 'closed' : 'open',
  priority: 1 + (i % 4),
  account_id: accounts[(i * 3) % accounts.length]!.id,
}));

export const assignments = tickets.flatMap((ticket, i) => [
  { id: `asg-${i}-a`, ticket_id: ticket.id, agent_id: agents[i % 6]!.id },
  ...(i % 4 === 0 || i === 42
    ? [
        {
          id: `asg-${i}-b`,
          ticket_id: ticket.id,
          agent_id: agents[(i + 2) % 6]!.id,
        },
      ]
    : []),
]);

export function createDeskGraph({ relate, z }: Sdk) {
  const access = relate.defineAccess({
    roles: ['agent'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const accountRows = relate.defineSource({
    id: 'desk.accounts',
    idField: 'id',
    schema: z.object({ id: z.string(), name: z.string(), tier: z.string() }),
  });
  const agentRows = relate.defineSource({
    id: 'desk.agents',
    idField: 'id',
    schema: z.object({ id: z.string(), name: z.string() }),
  });
  const ticketRows = relate.defineSource({
    id: 'desk.tickets',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      subject: z.string(),
      status: z.string(),
      priority: z.number(),
      account_id: z.string(),
    }),
  });
  const assignmentRows = relate.defineSource({
    id: 'desk.assignments',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      ticket_id: z.string(),
      agent_id: z.string(),
    }),
  });

  const Account = relate.defineObject({
    id: 'desk.account',
    description: 'A customer organization that raises support tickets.',
    membership: relate.source(accountRows),
    properties: {
      id: relate.objectId({ id: 'account.id' }),
      name: relate.from(accountRows.fields.name, {
        id: 'account.name',
        description: 'Registered organization name.',
      }),
      tier: relate.from(accountRows.fields.tier, {
        id: 'account.tier',
        description: "Support plan: 'enterprise' or 'standard'.",
      }),
    },
  });
  const Agent = relate.defineObject({
    id: 'desk.agent',
    description: 'A support team member who works on tickets.',
    membership: relate.source(agentRows),
    properties: {
      id: relate.objectId({ id: 'agent.id' }),
      name: relate.from(agentRows.fields.name, {
        id: 'agent.name',
        description: 'Full name.',
      }),
    },
  });
  const Ticket = relate.defineObject({
    id: 'desk.ticket',
    description: 'A support request raised by an account.',
    membership: relate.source(ticketRows),
    properties: {
      id: relate.objectId({ id: 'ticket.id' }),
      subject: relate.from(ticketRows.fields.subject, {
        id: 'ticket.subject',
        description: 'One-line summary written by the customer.',
      }),
      status: relate.from(ticketRows.fields.status, {
        id: 'ticket.status',
        description: "'open' or 'closed'.",
      }),
      priority: relate.from(ticketRows.fields.priority, {
        id: 'ticket.priority',
        description: '1 (urgent) to 4 (low).',
      }),
      account: relate.reference(Account, {
        id: 'ticket.account',
        description: 'Account that raised the ticket.',
        from: ticketRows.fields.account_id,
      }),
    },
  });
  const Assignment = relate.defineObject({
    id: 'desk.assignment',
    description: 'Links an agent to a ticket they work on.',
    membership: relate.source(assignmentRows),
    properties: {
      id: relate.objectId({ id: 'assignment.id' }),
      ticket: relate.reference(Ticket, {
        id: 'assignment.ticket',
        description: 'Assigned ticket.',
        from: assignmentRows.fields.ticket_id,
      }),
      agent: relate.reference(Agent, {
        id: 'assignment.agent',
        description: 'Assigned agent.',
        from: assignmentRows.fields.agent_id,
      }),
    },
  });
  const read = { read: { gate: access.role('agent') } };
  const graph = relate.defineGraph({
    id: 'support-desk',
    description:
      'Customer accounts, their support tickets, and the agents assigned to them.',
    access,
    objects: { Account, Agent, Ticket, Assignment },
    relationships: {
      AccountTickets: relate.defineRelationship({
        id: 'desk.account-tickets',
        forward: {
          name: 'tickets',
          description: 'Tickets raised by this account.',
        },
        reverse: {
          name: 'account',
          description: 'Account that raised this ticket.',
        },
        via: Ticket.properties.account,
      }),
      TicketAgents: relate.defineRelationship({
        id: 'desk.ticket-agents',
        forward: {
          name: 'agents',
          description: 'Agents assigned to this ticket.',
        },
        reverse: {
          name: 'tickets',
          description: 'Tickets assigned to this agent.',
        },
        through: {
          from: Assignment.properties.ticket,
          to: Assignment.properties.agent,
        },
      }),
    },
    policies: { Account: read, Agent: read, Ticket: read, Assignment: read },
  });

  return {
    graph,
    objects: { Account, Agent, Ticket, Assignment },
    sources: { accountRows, agentRows, ticketRows, assignmentRows },
  };
}

/** Start an in-memory desk with every row adopted; returns the reader's consumer. */
export async function startDesk(sdk: Sdk) {
  const desk = createDeskGraph(sdk);
  const rows = (records: readonly { id: string }[]) =>
    new Map(records.map((record) => [record.id, record]));
  const connector = (records: Map<string, object>) => ({
    identify: async () => 'desk',
    fetch: async (id: string) => {
      const record = records.get(id);

      return record
        ? { providerAccountId: 'desk', state: 'present' as const, record }
        : { providerAccountId: 'desk', state: 'deleted' as const };
    },
  });
  const connect = (
    resource: Parameters<typeof sdk.relate.connect>[0],
    records: readonly { id: string }[],
  ) =>
    sdk.relate.connect(resource, {
      connectionId: resource.id,
      providerAccountId: 'desk',
      connector: connector(rows(records)) as never,
    });
  const runtime = sdk.node.createRuntime({
    graph: desk.graph,
    cursorKey: new Uint8Array(32).fill(5),
    connections: [
      connect(desk.sources.accountRows, accounts),
      connect(desk.sources.agentRows, agents),
      connect(desk.sources.ticketRows, tickets),
      connect(desk.sources.assignmentRows, assignments),
    ],
  });
  const { Account, Agent, Ticket, Assignment } = desk.objects;

  // Adopt in source order so every run sees the same membership order.
  for (const [object, records] of [
    [Account, accounts],
    [Agent, agents],
    [Ticket, tickets],
    [Assignment, assignments],
  ] as const)
    for (const record of records)
      await runtime.host.adopt(object as never, record.id);

  return {
    consumer: runtime.as({ id: 'probe-reader', roles: ['agent'], claims: {} }),
    close: () => runtime.close(),
  };
}
