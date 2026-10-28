import { z } from 'zod';
import { join } from 'node:path';
import { bind, defineApp, implementAction } from 'relate';
import type { Binding, ObjectDefinition, SourceAppBinding } from 'relate';
import type { SourceConnector } from 'relate/connectors';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { sqlite } from '@relate/connector-sqlite';
import { duckdb } from '@relate/connector-duckdb';
import type { Principal, Platform } from '../world/model.js';
import { people, platforms } from '../world/model.js';
import type { Databases } from '../systems/databases.js';
import type { Http, Row } from '../systems/simulators.js';
import {
  checked,
  externalId,
  listPlatform,
  normalized,
  object,
  readPlatform,
  writePlatform,
} from '../systems/platform.js';
import {
  accounts,
  Account,
  BrandSafety,
  ChangeMedia,
  Client,
  clients,
  createGraph,
  Delivery,
  google,
  invoices,
  LaunchAdGroup,
  lines,
  Load,
  loads,
  meta,
  PlanLine,
  RecordDispute,
  SiteConversions,
  tiktok,
  ttd,
  VendorInvoice,
} from './graph.js';
import { Journal } from './journal.js';

export const platformNames = {
  meta: 'Meta',
  tiktok: 'TikTok',
  ttd: 'Ttd',
  'google-ads': 'Gads',
} as const;

export async function createAgencyApp(input: {
  principal: Principal;
  http: Http;
  db: Databases;
  directory: string;
}) {
  const start = performance.now();
  const { http, db, principal } = input;
  const graph = createGraph(principal);
  const actor = {
    id: principal,
    roles: [
      'reader',
      ...(principal === 'fiona' ? ['finance'] : ['media']),
      ...(principal === 'marco' ? ['activation-lead'] : []),
    ],
    claims: { team: people[principal].team },
  };
  const journal = new Journal(join(input.directory, 'journal.sqlite'));
  const routes = new Map<string, string>();
  const dayStart = new Map<string, number>(),
    used = new Map<string, number>();
  const accounted = new Set<string>();
  const objects = { meta, tiktok, ttd, 'google-ads': google };
  const adoption: { definition: ObjectDefinition; ids: string[] }[] = [];

  // Enumeration uses only the same HTTP/SQL surfaces the baseline receives.
  for (const platform of platforms)
    for (const entity of ['campaign', 'adgroup', 'ad'] as const) {
      const rows = await listPlatform(http, platform, entity);

      for (const row of rows) {
        const n = normalized(platform, entity, row);

        routes.set(String(n.id), String(n.account_id));

        if (entity === 'campaign')
          dayStart.set(String(n.id), Number(n.budget_minor));
      }

      adoption.push({
        definition:
          entity === 'campaign'
            ? objects[platform].Campaign
            : entity === 'adgroup'
              ? objects[platform].AdGroup
              : objects[platform].Ad,
        ids: rows.map((row) => externalId(platform, entity, row)),
      });
    }

  const clientIds: string[] = [];
  let next =
    '/services/data/v62.0/query?q=SELECT%20Id%20FROM%20Account%20WHERE%20IsDeleted%20%3D%20false';

  do {
    const page = await checked(http, 'crm', { path: next });

    clientIds.push(...(page.records as Row[]).map((r) => String(r.Id)));
    next = String(page.nextRecordsUrl ?? '');
  } while (next);

  adoption.unshift(
    { definition: Client, ids: clientIds },
    {
      definition: Account,
      ids: (await db.sql('plans', 'SELECT id FROM account_links')).map((r) =>
        String(r.id),
      ),
    },
    {
      definition: PlanLine,
      ids: (await db.sql('plans', 'SELECT id FROM plan_lines')).map((r) =>
        String(r.id),
      ),
    },
    {
      definition: VendorInvoice,
      ids: (await db.sql('finance', 'SELECT id FROM vendor_invoices')).map(
        (r) => String(r.id),
      ),
    },
    { definition: Load, ids: platforms },
  );
  const sourceBinding = (
    definition: typeof clients | typeof loads,
    fetch: (id: string) => Promise<Row>,
  ) =>
    bind(definition, {
      connectionId: definition.id,
      resourceId: definition.id,
      providerAccountId: 'northlight',
      connector: {
        identify: async () => 'northlight',
        fetch: async (id) => ({
          providerAccountId: 'northlight',
          state: 'present',
          record: z.record(z.string(), z.json()).parse(await fetch(id)),
        }),
      } satisfies SourceConnector,
    });
  const handlers = [
    implementAction(
      graph,
      ChangeMedia,
      async ({
        input: rawChange,
        actor,
        objects: context,
        idempotencyId,
        fail,
      }) => {
        const platform = z
          .enum(['meta', 'tiktok', 'ttd', 'google-ads'])
          .safeParse(rawChange.platform);

        if (!platform.success)
          return fail('rejected', {
            reason:
              'platform must be one of: meta, tiktok, ttd, google-ads (case sensitive); no write dispatched',
          });

        const entity = z.enum(['campaign', 'ad']).safeParse(rawChange.entity);

        if (!entity.success)
          return fail('rejected', {
            reason: 'entity must be campaign or ad; no write dispatched',
          });

        if (
          (rawChange.status === undefined) ===
          (rawChange.budgetMinor === undefined)
        )
          return fail('rejected', {
            reason:
              'Specify exactly one of status or budgetMinor; no write dispatched',
          });

        const change = {
          ...rawChange,
          platform: platform.data,
          entity: entity.data,
        };

        if (
          change.status !== undefined &&
          !['ACTIVE', 'PAUSED'].includes(change.status)
        )
          return fail('rejected', {
            reason: 'status must be ACTIVE or PAUSED; no write dispatched',
          });

        if (
          change.budgetMinor !== undefined &&
          (!Number.isSafeInteger(change.budgetMinor) || change.budgetMinor < 0)
        )
          return fail('rejected', {
            reason:
              'budgetMinor must be a nonnegative safe integer in account-currency minor units; no write dispatched',
          });

        const apiName = `${platformNames[change.platform]}${change.entity === 'ad' ? 'Ad' : 'Campaign'}`;
        const collection = context[
          apiName as keyof typeof context
        ] as unknown as {
          query(options: object): AsyncIterable<{ data: Row }>;
        };
        let allowed = false;

        for await (const record of collection.query({
          where: { externalId: { eq: change.externalId } },
          select: ['externalId'],
        }))
          allowed = record.data.externalId === change.externalId;

        if (!allowed) return fail('rejected', { reason: 'notFound' });

        const row = await readPlatform(
          http,
          change.platform,
          change.entity,
          change.externalId,
          routes.get(change.externalId),
        );
        const n = normalized(change.platform, change.entity, row);
        const campaignId =
          change.entity === 'campaign'
            ? change.externalId
            : String(n.campaign_id);
        const plan = (
          await db.sql(
            'plans',
            'SELECT * FROM plan_lines WHERE platform_campaign_id = ?',
            [campaignId],
          )
        )[0];

        if (!plan || String(plan.flight_end) < '2026-10-15')
          return fail('rejected', { reason: 'lineEndedOrUnlinked' });

        if (change.budgetMinor !== undefined) {
          if (change.entity !== 'campaign')
            return fail('rejected', { reason: 'Campaign budget only' });

          if (change.platform === 'google-ads') {
            const siblings = (
              await listPlatform(http, 'google-ads', 'campaign')
            ).filter((r) => r.campaignBudget === row.campaignBudget);

            if (siblings.length !== 1)
              return fail('rejected', { reason: 'sharedBudget' });
          }

          if (
            !actor.roles.includes('activation-lead') &&
            (used.get(change.externalId) ?? 0) +
              Math.abs(change.budgetMinor - Number(n.budget_minor)) >
              0.2 * dayStart.get(change.externalId)!
          )
            return fail('rejected', { reason: 'exceedsDailyChangeLimit' });
        }

        const result = await journal.once(
          idempotencyId,
          async () => {
            await writePlatform(
              http,
              change.platform,
              change.entity,
              row,
              change,
            );

            return { applied: true };
          },
          async () => {
            const current = normalized(
              change.platform,
              change.entity,
              await readPlatform(
                http,
                change.platform,
                change.entity,
                change.externalId,
                routes.get(change.externalId),
              ),
            );

            return (
              change.status !== undefined
                ? current.status === change.status
                : current.budget_minor === change.budgetMinor
            )
              ? { applied: true }
              : undefined;
          },
        );

        if (!result)
          return fail('unresolved', {
            reason:
              'Provider outcome unresolved; inspect current state before another operation',
          });

        if (change.budgetMinor !== undefined && !accounted.has(idempotencyId)) {
          used.set(
            change.externalId,
            (used.get(change.externalId) ?? 0) +
              Math.abs(change.budgetMinor - Number(n.budget_minor)),
          );
          accounted.add(idempotencyId);
        }

        await context.MediaChange.create({
          actorId: actor.id,
          kind: 'change',
          externalId: change.externalId,
          detail: JSON.stringify(change),
        });

        return result;
      },
    ),
    implementAction(
      graph,
      LaunchAdGroup,
      async ({ actor, input: launch, objects, idempotencyId, fail }) => {
        if (
          !Number.isSafeInteger(launch.budgetMinor) ||
          launch.budgetMinor <= 0
        )
          return fail('rejected', {
            reason:
              'budgetMinor must be a positive safe integer in account-currency minor units; no write dispatched',
          });

        const campaign = await objects.TikTokCampaign.get(launch.campaign, {
          select: ['externalId'],
        });

        if (campaign.status !== 'ok')
          return fail('rejected', { reason: 'notFound' });

        const id = String(campaign.data.externalId);
        const plan = (
          await db.sql(
            'plans',
            'SELECT flight_end FROM plan_lines WHERE platform_campaign_id = ?',
            [id],
          )
        )[0];

        if (!plan || String(plan.flight_end) < '2026-10-15')
          return fail('rejected', { reason: 'lineEndedOrUnlinked' });

        const name = `${launch.name} [${idempotencyId.slice(-12)}]`;
        const created = await journal.once(
          idempotencyId,
          async () =>
            object(
              (
                await checked(http, 'tiktok', {
                  method: 'POST',
                  path: '/open_api/v1.3/adgroup/create/',
                  body: {
                    campaign_id: id,
                    adgroup_name: name,
                    budget: launch.budgetMinor / 100,
                  },
                })
              ).data,
            ),
          async () => {
            const body = await checked(http, 'tiktok', {
              path: '/open_api/v1.3/adgroup/get/',
              query: {
                filtering: JSON.stringify({
                  campaign_id: id,
                  adgroup_name: name,
                }),
              },
            });
            const matches = object(body.data).list as Row[];

            return matches.length === 1 ? matches[0] : undefined;
          },
        );

        if (!created)
          return fail('unresolved', {
            reason: 'Create outcome unresolved; do not repeat creation',
          });

        const external = String(created.adgroup_id);
        const { id: adGroupId } = await objects.TikTokAdGroup.adopt(external);

        await objects.MediaChange.create({
          actorId: actor.id,
          kind: 'launch',
          externalId: external,
          detail: name,
        });

        return { adGroupId };
      },
    ),
    implementAction(
      graph,
      RecordDispute,
      async ({ actor, input, objects, idempotencyId }) => {
        if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
          throw new Error('Invalid dispute amount');

        const invoice = await objects.VendorInvoice.get(input.invoice, {
          select: ['externalId'],
        });

        if (invoice.status !== 'ok') throw new Error('Invoice unavailable');

        const recorded = await journal.once(
          idempotencyId,
          async () => {
            await db.sql(
              'finance',
              'INSERT INTO disputes(id, invoice_id, reason, amount_minor) VALUES (?,?,?,?)',
              [
                idempotencyId,
                invoice.data.externalId,
                input.reason,
                input.amountMinor,
              ],
            );

            return { recorded: true };
          },
          async () =>
            (
              await db.sql('finance', 'SELECT id FROM disputes WHERE id = ?', [
                idempotencyId,
              ])
            ).length === 1
              ? { recorded: true }
              : undefined,
        );

        if (!recorded) throw new Error('Dispute outcome unresolved');

        await objects.MediaChange.create({
          actorId: actor.id,
          kind: 'dispute',
          externalId: String(invoice.data.externalId),
          detail: input.reason,
        });

        return { recorded: true };
      },
    ),
  ];
  const runtime = await startApp(
    defineApp({
      graph,
      setup({ onDispose }) {
        onDispose(() => journal.close());
        const plans = sqlite({ connectionId: 'plans', path: db.paths.plans }),
          finance = sqlite({ connectionId: 'finance', path: db.paths.finance }),
          warehouse = duckdb({
            connectionId: 'warehouse',
            path: db.paths.warehouse,
          });

        onDispose(() => plans.close());
        onDispose(() => finance.close());
        onDispose(() => warehouse.close());
        const bindings: Binding[] = [
          bind(accounts, plans.table('account_links')),
          bind(lines, plans.table('plan_lines')),
          bind(invoices, finance.table('vendor_invoices')),
          sourceBinding(clients, (id) =>
            checked(http, 'crm', {
              path: `/services/data/v62.0/sobjects/Account/${id}`,
            }),
          ),
          sourceBinding(loads, async (id) => {
            const rows = await db.sql(
              'warehouse',
              'SELECT platform, CAST(loaded_through AS VARCHAR) loaded_through FROM etl_runs WHERE platform = ?',
              [id],
            );

            if (!rows[0]) throw new Error('Missing load');

            return rows[0];
          }),
          bind(Delivery, warehouse.table('delivery_daily_campaign'), {
            columns: {
              campaignId: 'platform_campaign_id',
              spendMicros: 'spend_micros',
              conversions: 'platform_conversions',
            },
          }),
          bind(BrandSafety, warehouse.table('brand_safety_events'), {
            columns: { adId: 'ad_id', observedAt: 'observed_at' },
          }),
          bind(SiteConversions, warehouse.table('site_conversions'), {
            columns: {
              campaignId: 'platform_campaign_id',
              revenueMinor: 'revenue_minor',
            },
          }),
        ];

        for (const platform of platforms)
          for (const entity of ['campaign', 'adgroup', 'ad'] as const) {
            const definition =
              entity === 'campaign'
                ? objects[platform].campaigns
                : entity === 'adgroup'
                  ? objects[platform].adgroups
                  : objects[platform].ads;

            bindings.push(
              bind(definition, {
                connectionId: `${platform}-${entity}`,
                resourceId: entity,
                providerAccountId: 'northlight',
                connector: {
                  identify: async () => 'northlight',
                  async fetch(id) {
                    const row = await readPlatform(
                      http,
                      platform,
                      entity,
                      id,
                      routes.get(id),
                    );
                    let today = 0;

                    if (entity === 'campaign') {
                      if (platform === 'meta') {
                        const b = await checked(http, platform, {
                          path: `/v21.0/${id}/insights`,
                          query: { date_preset: 'today' },
                        });

                        today = Number((b.data as Row[])[0]!.spend) * 100;
                      }

                      if (platform === 'tiktok') {
                        const b = await checked(http, platform, {
                          path: '/open_api/v1.3/report/integrated/get/',
                          query: { campaign_id: id },
                        });

                        today =
                          Number(
                            object((object(b.data).list as Row[])[0]!.metrics)
                              .spend,
                          ) * 100;
                      }

                      if (platform === 'ttd') {
                        const b = await checked(http, platform, {
                          method: 'POST',
                          path: '/v3/delivery/query',
                          body: { CampaignId: id },
                        });

                        today =
                          Number(object((b.Result as Row[])[0]!.Spend).Amount) *
                          100;
                      }

                      if (platform === 'google-ads') {
                        const b = await checked(http, platform, {
                          method: 'POST',
                          path: `/v18/customers/${routes.get(id)}/googleAds:search`,
                          body: {
                            query: `SELECT * FROM campaign WHERE campaign.id = '${id}'`,
                          },
                        });

                        today =
                          Number(
                            object((b.results as Row[])[0]!.metrics).costMicros,
                          ) / 10000;
                      }
                    }

                    return {
                      providerAccountId: 'northlight',
                      state: 'present',
                      record: {
                        ...normalized(platform, entity, row),
                        spend_today_minor: today,
                      },
                    };
                  },
                },
              }),
            );
          }

        const tracedWarehouse = {
          ...warehouse,
          analytics: {
            ...warehouse.analytics,
            execute: (
              ...args: Parameters<typeof warehouse.analytics.execute>
            ) => {
              db.calls.push({
                db: 'warehouse',
                sql: 'analytical statement dispatch',
                kind: 'analytical-dispatch',
              });

              return warehouse.analytics.execute(...args);
            },
          },
        };
        const instrumented: Binding[] = bindings.map((binding) => {
          if ('dataset' in binding)
            return { ...binding, connection: tracedWarehouse };

          if (binding.connection?.system !== 'sqlite') return binding;

          const connector = binding.connector;

          return {
            ...binding,
            connector: {
              ...connector,
              fetch: async (...args: Parameters<typeof connector.fetch>) => {
                db.calls.push({
                  db: binding.connectionId,
                  sql: `source fetch ${binding.resourceId}: ${args[0]}`,
                  kind: 'source-fetch',
                });

                return connector.fetch(args[0], args[1]);
              },
            },
          } as SourceAppBinding;
        });

        return {
          bindings: instrumented,
          actionImplementations: handlers,
          clock: () => Date.parse('2026-10-15T13:00:00.000Z'),
        };
      },
    }),
  );

  try {
    for (const entry of adoption)
      for (const id of entry.ids)
        await runtime.host.adopt(entry.definition as typeof Client, id);
  } catch (error) {
    await runtime.close();
    throw error;
  }

  return {
    runtime,
    graph,
    actor,
    binding: {
      description: compile(graph).consumer,
      operations: runtime.operations(actor),
    },
    setupMs: performance.now() - start,
    close: () => runtime.close(),
  };
}

export type AgencyApp = Awaited<ReturnType<typeof createAgencyApp>>;
