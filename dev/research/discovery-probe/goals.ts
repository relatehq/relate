import { accounts, agents, assignments, tickets } from './desk.js';

type Consumer = Awaited<
  ReturnType<typeof import('./desk.js').startDesk>
>['consumer'];

/**
 * A generic read goal. Prompts name business facts, never SDK operations,
 * option names or object API paths; the agent learns those from discovery.
 */
export interface Goal {
  readonly id: string;
  readonly prompt: string;
  /** A failing cell run before the agent's first turn; its output is shown. */
  readonly prelude?: string;
  /** Expected answer, computed by the child from source rows or the SDK itself. */
  truth(consumer: Consumer): Promise<unknown>;
  score(answer: unknown, truth: unknown): boolean;
  /** A correct solution with the current SDK, used only to test the probe. */
  readonly reference: string;
}

const sameNumber = (answer: unknown, truth: unknown) =>
  (typeof answer === 'number' || typeof answer === 'string') &&
  String(answer).trim() !== '' &&
  Number(answer) === truth;
const sameSet = (answer: unknown, truth: unknown) =>
  Array.isArray(answer) &&
  Array.isArray(truth) &&
  answer.length === truth.length &&
  [...answer].map(String).sort().join('\n') === [...truth].sort().join('\n');
const sameList = (answer: unknown, truth: unknown) =>
  Array.isArray(answer) &&
  JSON.stringify(answer.map(String)) === JSON.stringify(truth);
const sameText = (answer: unknown, truth: unknown) =>
  typeof answer === 'string' && answer.trim() === truth;

const accountId = (name: string) => accounts.find((a) => a.name === name)!.id;
const ticket = (subject: string) => tickets.find((t) => t.subject === subject)!;

export const goals: readonly Goal[] = [
  {
    id: 'count-all',
    prompt: 'How many support tickets are there in total? Submit a number.',
    truth: async () => tickets.length,
    score: sameNumber,
    reference: `let count = 0;
for await (const _ of relate.objects.Ticket.query({ select: [] })) count++;
submit(count);`,
  },
  {
    id: 'filter-by-reference',
    prompt:
      'How many open tickets belong to the account named "Northwind Traders"? Submit a number.',
    truth: async () =>
      tickets.filter(
        (t) =>
          t.account_id === accountId('Northwind Traders') &&
          t.status === 'open',
      ).length,
    score: sameNumber,
    reference: `const [account] = (await relate.objects.Account.query({ where: { name: 'Northwind Traders' } })).data;
let open = 0;
for await (const _ of relate.objects.Ticket.query({ where: { account: account.id, status: 'open' }, select: [] })) open++;
submit(open);`,
  },
  {
    id: 'traverse-many',
    prompt:
      'Submit the subjects of every ticket raised by the account named "Contoso", as an array of strings in any order.',
    truth: async () =>
      tickets
        .filter((t) => t.account_id === accountId('Contoso'))
        .map((t) => t.subject),
    score: sameSet,
    reference: `const [account] = (await relate.objects.Account.query({ where: { name: 'Contoso' } })).data;
const subjects = [];
for await (const t of relate.objects.Account.traverse.tickets(account.id, { select: ['subject'] })) subjects.push(t.data.subject);
submit(subjects);`,
  },
  {
    id: 'traverse-one',
    prompt:
      'Which account raised the ticket with the subject "Printer jams on tray 2"? Submit the account name.',
    truth: async () =>
      accounts.find(
        (a) => a.id === ticket('Printer jams on tray 2').account_id,
      )!.name,
    score: sameText,
    reference: `const [t] = (await relate.objects.Ticket.query({ where: { subject: 'Printer jams on tray 2' } })).data;
const account = await relate.objects.Ticket.traverse.account(t.id);
submit(account.data.name);`,
  },
  {
    id: 'traverse-through',
    prompt:
      'Which agents are assigned to the ticket with the subject "VPN drops every hour"? Submit their names as an array of strings in any order.',
    truth: async () =>
      assignments
        .filter((a) => a.ticket_id === ticket('VPN drops every hour').id)
        .map((a) => agents.find((agent) => agent.id === a.agent_id)!.name),
    score: sameSet,
    reference: `const [t] = (await relate.objects.Ticket.query({ where: { subject: 'VPN drops every hour' } })).data;
const names = [];
for await (const agent of relate.objects.Ticket.traverse.agents(t.id)) names.push(agent.data.name);
submit(names);`,
  },
  {
    id: 'continue-page',
    prompt:
      'Read the tickets ten at a time, in the order the client returns them. Submit the IDs from the second batch of ten, as an array of strings in that order.',
    // The second page in the SDK's own order, read the documented way.
    truth: async (consumer) => {
      const first = await consumer.objects.Ticket.query({
        limit: 10,
        select: [],
      });
      const second = await consumer.objects.Ticket.query({
        limit: 10,
        select: [],
        cursor: first.meta.continuationCursor!,
      });

      return second.data.map((record) => record.id);
    },
    score: sameList,
    reference: `const first = await relate.objects.Ticket.query({ limit: 10, select: [] });
const second = await relate.objects.Ticket.query({ limit: 10, select: [], cursor: first.meta.continuationCursor });
submit(second.data.map((r) => r.id));`,
  },
  {
    id: 'recover-from-error',
    prelude:
      'const firstFive = await relate.objects.Ticket.query({ pageSize: 5 });',
    prompt:
      'A colleague started this task with the cell below, and it failed. Submit the subjects of exactly five different tickets, as an array of strings.',
    truth: async () => tickets.map((t) => t.subject),
    score: (answer, truth) =>
      Array.isArray(answer) &&
      answer.length === 5 &&
      new Set(answer).size === 5 &&
      answer.every((subject) => (truth as string[]).includes(subject)),
    reference: `const page = await relate.objects.Ticket.query({ limit: 5, select: ['subject'] });
submit(page.data.map((t) => t.data.subject));`,
  },
];
