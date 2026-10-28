import { traced } from '../harness/telemetry.js';
import type { Trace } from '../harness/telemetry.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type {
  Fault,
  Mutation,
  Platform,
  RequestRecord,
  World,
} from '../world/model.js';
import { json, platforms } from '../world/model.js';
import { todaySpend } from '../world/generator.js';

export type Row = Record<string, unknown>;
export type System = Platform | 'crm';

export interface HttpRequest {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type Http = (
  system: System,
  request: HttpRequest,
) => Promise<HttpResponse>;

export const routes = {
  meta: 'GET /v21.0/me/adaccounts; GET /v21.0/{account}/campaigns|adsets|ads; GET /v21.0/{id}; GET /v21.0/{campaign}/insights?date_preset=today; POST /v21.0/{id}',
  tiktok:
    'GET /open_api/v1.3/advertiser/info/; GET /open_api/v1.3/campaign/get/; GET /open_api/v1.3/adgroup/get/; GET /open_api/v1.3/ad/get/; GET /open_api/v1.3/report/integrated/get/; POST /open_api/v1.3/campaign/status/update/; POST /open_api/v1.3/campaign/update/; POST /open_api/v1.3/adgroup/update/; POST /open_api/v1.3/adgroup/create/; POST /open_api/v1.3/ad/status/update/',
  ttd: 'POST /v3/advertiser/query/partner; POST /v3/campaign/query/advertiser; POST /v3/adgroup/query/campaign; POST /v3/ad/query/adgroup; POST /v3/delivery/query; GET /v3/campaign/{id}; GET /v3/adgroup/{id}; GET /v3/ad/{id}; PUT /v3/campaign; PUT /v3/adgroup; PUT /v3/ad',
  'google-ads':
    'GET /v18/customers:listAccessibleCustomers; POST /v18/customers/{id}/googleAds:search; POST /v18/customers/{id}/campaigns:mutate; POST /v18/customers/{id}/campaignBudgets:mutate; POST /v18/customers/{id}/adGroupAds:mutate',
  crm: 'GET /services/data/v62.0/query?q=SELECT fields FROM Account [WHERE Team__c = value]; GET /services/data/v62.0/query/{offset}; GET /services/data/v62.0/sobjects/Account/{id}',
};

export async function startSimulators(
  world: World,
  mutations: Mutation[],
  faults: Fault[] = [],
  trace?: Trace,
) {
  const records = new Map<
    string,
    { system: System; entity: string; row: Row }
  >();
  const requests: RequestRecord[] = [];
  const add = (system: System, entity: string, id: string, row: Row) =>
    records.set(id, { system, entity, row });
  const campaigns = new Map(world.campaigns.map((c) => [c.id, c]));
  const accounts = new Map(world.accounts.map((a) => [a.id, a]));

  for (const c of world.clients)
    for (const [index, id] of [c.id, ...c.mergedIds].entries())
      add('crm', 'Account', id, {
        Id: id,
        Name: c.name,
        Client_Code__c: c.code,
        Team__c: c.team,
        CurrencyIsoCode: c.currency,
        Fee_Pct__c: c.feePct,
        IsDeleted: index > 0,
        MasterRecordId: index > 0 ? c.id : null,
      });

  for (const a of world.accounts) {
    const fields = {
      name: world.clients.find((c) => c.id === a.clientId)!.code,
      currency: a.currency,
      timezone_name: a.timezone,
    };

    // Meta account objects are addressed as act_<id>; child records carry the bare ID.
    if (a.platform === 'meta')
      add('meta', 'account', `act_${a.id}`, {
        id: `act_${a.id}`,
        account_id: a.id,
        ...fields,
      });
    else add(a.platform, 'account', a.id, { id: a.id, ...fields });
  }

  function project(
    system: Platform,
    entity: string,
    id: string,
    campaignId: string,
    groupId: string | undefined,
    name: string,
    status: string,
    budget: number,
  ): Row {
    const c = campaigns.get(campaignId)!;
    const a = accounts.get(c.accountId)!;

    if (system === 'meta')
      return {
        id,
        account_id: a.id,
        campaign_id: campaignId,
        ...(groupId ? { adset_id: groupId } : {}),
        name,
        status,
        daily_budget: String(budget),
        currency: a.currency,
        timezone_name: a.timezone,
      };

    if (system === 'tiktok')
      return {
        [`${entity === 'adgroup' ? 'adgroup' : entity}_id`]: id,
        campaign_id: campaignId,
        ...(groupId ? { adgroup_id: groupId } : {}),
        advertiser_id: a.id,
        [`${entity}_name`]: name,
        operation_status: status,
        budget: budget / 100,
        currency: a.currency,
        timezone: a.timezone,
      };

    if (system === 'ttd')
      return {
        Id: id,
        AdvertiserId: a.id,
        CampaignId: campaignId,
        ...(groupId ? { AdGroupId: groupId } : {}),
        Name: name,
        Status: status,
        Budget: { Amount: budget / 100, CurrencyCode: a.currency },
        Targeting: { geo: 'GB', inventory: 'approved' },
        CurrencyCode: a.currency,
        Timezone: a.timezone,
      };

    return {
      id,
      customerId: a.id,
      campaignId,
      ...(groupId ? { adGroupId: groupId } : {}),
      name,
      status,
      campaignBudget: c.budgetId,
      amountMicros: String(budget * 10000),
      currencyCode: a.currency,
      timeZone: a.timezone,
    };
  }

  for (const c of world.campaigns) {
    add(
      c.platform,
      'campaign',
      c.id,
      project(
        c.platform,
        'campaign',
        c.id,
        c.id,
        undefined,
        c.name,
        c.status,
        c.budgetMinor,
      ),
    );

    if (c.platform === 'google-ads' && !records.has(c.budgetId))
      add(c.platform, 'budget', c.budgetId, {
        id: c.budgetId,
        customerId: c.accountId,
        amountMicros: String(c.budgetMinor * 10000),
      });
  }

  for (const g of world.groups) {
    const c = campaigns.get(g.campaignId)!;

    add(
      c.platform,
      'adgroup',
      g.id,
      project(
        c.platform,
        'adgroup',
        g.id,
        c.id,
        undefined,
        g.name,
        g.status,
        g.budgetMinor,
      ),
    );
  }

  for (const ad of world.ads) {
    const c = campaigns.get(ad.campaignId)!;

    add(
      c.platform,
      'ad',
      ad.id,
      project(c.platform, 'ad', ad.id, c.id, ad.groupId, ad.id, ad.status, 0),
    );
  }

  const list = (system: System, entity: string) =>
    [...records.values()]
      .filter((r) => r.system === system && r.entity === entity)
      .map((r) => r.row);
  const counter = new Map<string, number>();
  let createCounter = 0;
  const token = 'northlight-synthetic-service-token';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const system = url.pathname.split('/')[1] as System;
    const path = url.pathname.slice(system.length + 1);
    const method = req.method!;
    let body: Row = {};
    let activeRequest: RequestRecord | undefined;
    const send = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        date: new Date(world.now).toUTCString(),
        ...headers,
      });
      res.end(json(value));
    };

    try {
      if (req.headers.authorization !== `Bearer ${token}`)
        return send(401, { error: 'invalid credential' });

      let input = '';

      for await (const chunk of req) {
        input += String(chunk);

        if (input.length > 1048576) throw new Error('Request too large');
      }

      if (input) body = JSON.parse(input) as Row;

      const write =
        system === 'meta'
          ? method === 'POST'
          : system === 'tiktok'
            ? method === 'POST'
            : system === 'ttd'
              ? method === 'PUT'
              : path.endsWith(':mutate');
      const update = ((body.operations as Row[] | undefined)?.[0]?.update ??
        {}) as Row;
      const filterTarget = url.searchParams.has('filtering')
        ? (JSON.parse(url.searchParams.get('filtering')!) as Row)
        : {};
      const target = String(
        filterTarget.adgroup_id ??
          filterTarget.campaign_id ??
          filterTarget.ad_id ??
          body.campaign_id ??
          body.adgroup_id ??
          body.ad_id ??
          body.Id ??
          update.id ??
          path.split('/').at(-1),
      );
      const log: RequestRecord = {
        seq: requests.length + 1,
        system,
        method,
        path,
        target,
        write,
        outcome: 'ok',
        requestId:
          (req.headers['x-request-id'] as string) ??
          `request-${requests.length + 1}`,
      };

      activeRequest = log;
      requests.push(log);
      const key = `${system}:${target}`;

      if (write) counter.set(key, (counter.get(key) ?? 0) + 1);

      const fault = write
        ? faults.find(
            (f) =>
              f.system === system &&
              f.target === target &&
              f.nth === counter.get(key),
          )
        : undefined;

      if (fault && fault.kind !== 'timeout-after-commit') {
        log.outcome = fault.kind;

        if (fault.kind === 'timeout-before-commit') {
          req.socket.destroy();

          return;
        }

        return fault.kind === 'rate-limit-429'
          ? send(
              429,
              system === 'tiktok'
                ? { code: 40100, message: 'Too many requests' }
                : { error: 'rate limited; retry after 1 second' },
              { 'retry-after': '1' },
            )
          : send(
              500,
              system === 'tiktok'
                ? { code: 50000, message: 'Internal error' }
                : { error: 'internal server error' },
            );
      }

      // Providers validate enumerated values; nothing invalid is silently stored.
      const statusValue =
        body.status ?? body.operation_status ?? body.Status ?? update.status;

      if (
        write &&
        statusValue !== undefined &&
        !['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(String(statusValue))
      )
        throw new Error(
          `Invalid status ${JSON.stringify(statusValue)}; use ACTIVE or PAUSED`,
        );

      const mutate = (id: string, after: Row, entity?: string) => {
        const previous = records.get(id);

        if (previous && previous.system !== system)
          throw new Error('Record does not belong to this provider');

        if (!previous && !entity) throw new Error(`Unknown record ${id}`);

        mutations.push({
          seq: mutations.length + 1,
          system,
          entity: entity ?? previous!.entity,
          id,
          op: previous ? 'update' : 'create',
          before: structuredClone(previous?.row ?? {}),
          after: structuredClone(after),
          requestId: log.requestId,
        });
        add(system, entity ?? previous!.entity, id, after);
      };
      let result: unknown;

      if (system === 'crm') {
        if (path.includes('/sobjects/Account/')) {
          const row = records.get(path.split('/').at(-1)!)?.row;

          if (!row) return send(404, { errorCode: 'NOT_FOUND' });

          result = row;
        } else {
          const q = url.searchParams.get('q') ?? 'SELECT * FROM Account';

          if (!/^SELECT .+ FROM Account(?: WHERE .+)?$/i.test(q))
            throw new Error(
              "Supported SOQL: SELECT fields FROM Account [WHERE Field = 'value' AND IsDeleted = false]",
            );

          let rows = list('crm', 'Account');
          const where = /\sWHERE\s+(.+)$/i.exec(q)?.[1] ?? '';

          for (const [, field, value] of where.matchAll(
            /(\w+)\s*=\s*'([^']*)'/g,
          ))
            rows = rows.filter((r) => String(r[field!]) === value);

          for (const [, value] of where.matchAll(
            /IsDeleted\s*=\s*(true|false)/gi,
          ))
            rows = rows.filter(
              (r) => r.IsDeleted === (value!.toLowerCase() === 'true'),
            );

          const offset = Number(
            url.searchParams.get('offset') ??
              path.split('/').at(-1)?.match(/^\d+$/)?.[0] ??
              0,
          );
          const fields = /^SELECT (.+) FROM/i
            .exec(q)![1]!
            .split(',')
            .map((x) => x.trim());
          const page = rows
            .slice(offset, offset + 25)
            .map((row) =>
              fields[0] === '*'
                ? row
                : Object.fromEntries(fields.map((f) => [f, row[f]])),
            );

          result = {
            totalSize: rows.length,
            done: offset + 25 >= rows.length,
            records: page,
            ...(offset + 25 < rows.length
              ? {
                  nextRecordsUrl: `/services/data/v62.0/query?offset=${offset + 25}&q=${encodeURIComponent(q)}`,
                }
              : {}),
          };
        }
      } else if (system === 'meta') {
        if (write) {
          const row = records.get(target)?.row;

          if (!row) return send(404, { error: { message: 'not found' } });

          mutate(target, { ...row, ...body });
          result = { success: true };
        } else if (path.endsWith('/insights')) {
          const id = path.split('/').at(-2)!;

          result = {
            data: [
              {
                campaign_id: id,
                date_start: '2026-10-15',
                spend: (todaySpend(id, world.seed) / 100).toFixed(2),
              },
            ],
          };
        } else {
          if (!url.searchParams.get('fields'))
            throw new Error('fields= is required');

          const id = path.split('/').at(-1)!;
          const entity = (
            {
              adaccounts: 'account',
              campaigns: 'campaign',
              adsets: 'adgroup',
              ads: 'ad',
            } as Record<string, string>
          )[id];

          if (!entity) {
            const row = records.get(id)?.row;

            if (!row) return send(404, { error: 'not found' });

            result = row;
          } else {
            const parent = path.split('/').at(-2)!;

            if (entity !== 'account' && !records.has(parent))
              return send(400, {
                error: {
                  message: `(#803) Some of the aliases you requested do not exist: ${parent}`,
                  code: 803,
                },
              });

            const rows = list(system, entity).filter(
              (r) =>
                entity === 'account' ||
                `act_${String(r.account_id)}` === parent,
            );
            const offset = Number(url.searchParams.get('after') ?? 0),
              limit = Math.min(
                100,
                Number(url.searchParams.get('limit') ?? 25),
              );

            result = {
              data: rows.slice(offset, offset + limit),
              ...(offset + limit < rows.length
                ? { paging: { cursors: { after: String(offset + limit) } } }
                : {}),
            };
          }
        }
      } else if (system === 'tiktok') {
        const entity = path.includes('/adgroup/')
          ? 'adgroup'
          : path.includes('/ad/')
            ? 'ad'
            : 'campaign';

        if (path.endsWith('/adgroup/create/')) {
          const campaignId = String(body.campaign_id),
            c = campaigns.get(campaignId);

          if (!c || c.platform !== 'tiktok')
            throw new Error('Unknown TikTok campaign');

          const id = `tiktok-created-${++createCounter}`;
          const row = project(
            'tiktok',
            'adgroup',
            id,
            campaignId,
            undefined,
            String(body.adgroup_name),
            'ACTIVE',
            Math.round(Number(body.budget) * 100),
          );

          mutate(id, row, 'adgroup');
          result = { code: 0, data: { adgroup_id: id } };
        } else if (write) {
          const id = String(body[`${entity}_id`]);
          const row = records.get(id)?.row;

          if (!row || records.get(id)?.system !== system)
            throw new Error('Unknown TikTok record');

          mutate(id, { ...row, ...body });
          result = { code: 0, data: {} };
        } else if (path.includes('/report/')) {
          const id = url.searchParams.get('campaign_id')!;

          result = {
            code: 0,
            data: {
              list: [
                {
                  dimensions: { campaign_id: id },
                  metrics: { spend: todaySpend(id, world.seed) / 100 },
                },
              ],
            },
          };
        } else {
          const filter = JSON.parse(
            url.searchParams.get('filtering') ?? '{}',
          ) as Row;
          const kind = path.includes('/advertiser/') ? 'account' : entity;
          const rows = list(system, kind).filter(
            (r) =>
              (!url.searchParams.has('advertiser_id') ||
                r.advertiser_id === url.searchParams.get('advertiser_id')) &&
              Object.entries(filter).every(([k, v]) => r[k] === v),
          );
          const page = Number(url.searchParams.get('page') ?? 1),
            size = Math.min(
              1000,
              Number(url.searchParams.get('page_size') ?? 25),
            );

          result = {
            code: 0,
            data: {
              list: rows.slice((page - 1) * size, page * size),
              page_info: {
                page,
                page_size: size,
                total_page: Math.ceil(rows.length / size),
                total_number: rows.length,
              },
            },
          };
        }
      } else if (system === 'ttd') {
        if (write) {
          const id = String(body.Id);

          mutate(id, body);
          result = body;
        } else if (method === 'GET') {
          result = records.get(path.split('/').at(-1)!)?.row;

          if (!result) return send(404, { Message: 'Not found' });
        } else if (path === '/v3/delivery/query')
          result = {
            Result: [
              {
                CampaignId: body.CampaignId,
                Spend: {
                  Amount: todaySpend(String(body.CampaignId), world.seed) / 100,
                  CurrencyCode: records.get(String(body.CampaignId))?.row
                    .CurrencyCode,
                },
              },
            ],
          };
        else {
          const entity =
            path.split('/')[2] === 'advertiser'
              ? 'account'
              : path.split('/')[2]!;
          const rows = list(system, entity).filter(
            (r) =>
              (!body.AdvertiserId || r.AdvertiserId === body.AdvertiserId) &&
              (!body.CampaignId || r.CampaignId === body.CampaignId) &&
              (!body.AdGroupId || r.AdGroupId === body.AdGroupId),
          );
          const offset = Number(body.PageStartIndex ?? 0),
            size = Math.min(1000, Number(body.PageSize ?? 25));

          result = {
            Result: rows.slice(offset, offset + size),
            TotalCount: rows.length,
          };
        }
      } else if (system === 'google-ads') {
        const customer = path.split('/')[3];

        if (
          !path.endsWith('listAccessibleCustomers') &&
          records.get(customer ?? '')?.entity !== 'account'
        )
          throw new Error(
            `INVALID_CUSTOMER_ID: ${customer}; use a 10-digit ID from listAccessibleCustomers`,
          );

        if (path.endsWith('listAccessibleCustomers'))
          result = {
            resourceNames: list(system, 'account').map(
              (r) => `customers/${r.id}`,
            ),
          };
        else if (write) {
          const id = String(update.id),
            previous = records.get(id);

          if (!previous || previous.row.customerId !== customer)
            throw new Error('Unknown Google record');

          mutate(id, { ...previous.row, ...update });

          if (previous.entity === 'budget')
            for (const [cid, r] of records)
              if (
                r.system === system &&
                r.entity === 'campaign' &&
                r.row.campaignBudget === id
              )
                mutate(cid, { ...r.row, amountMicros: update.amountMicros });

          result = { results: [{ resourceName: id }] };
        } else {
          const query = String(body.query),
            resource = /FROM\s+(\w+)/i.exec(query)?.[1];
          const entity = (
            {
              campaign: 'campaign',
              campaign_budget: 'budget',
              ad_group: 'adgroup',
              ad_group_ad: 'ad',
            } as Record<string, string>
          )[resource ?? ''];

          if (!entity)
            throw new Error(
              'GAQL FROM campaign|campaign_budget|ad_group|ad_group_ad required',
            );

          const wantedId = /WHERE\s+\w+\.id\s*=\s*'?([^'\s]+)'?/i.exec(
            query,
          )?.[1];
          const rows = [...records.entries()]
            .filter(
              ([id, r]) =>
                r.system === system &&
                r.entity === entity &&
                r.row.customerId === customer &&
                (!wantedId || wantedId === id),
            )
            .map(([, r]) => ({
              [resource!]: r.row,
              metrics: {
                costMicros: String(
                  todaySpend(String(r.row.id), world.seed) * 10000,
                ),
              },
            }));
          const offset = Number(body.pageToken ?? 0);

          result = {
            results: rows.slice(offset, offset + 25),
            ...(offset + 25 < rows.length
              ? { nextPageToken: String(offset + 25) }
              : {}),
          };
        }
      } else return send(404, { error: 'Unknown system' });

      if (fault?.kind === 'timeout-after-commit') {
        log.outcome = fault.kind;
        req.socket.destroy();

        return;
      }

      send(200, result);
    } catch (error) {
      if (activeRequest) activeRequest.outcome = 'provider-error';

      send(
        system === 'tiktok' ? 200 : 400,
        system === 'tiktok'
          ? { code: 40001, message: String(error) }
          : { error: String(error) },
      );
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let requestId = 0;
  const http: Http = async (system, request) => {
    const id = `http-${++requestId}`;

    return traced(
      trace,
      'http',
      system,
      {
        system,
        requestId: id,
        method: request.method ?? 'GET',
        path: request.path,
        query: request.query,
        requestBody: request.body,
        requestBytes: Buffer.byteLength(json(request)),
      },
      async (step) => {
        try {
          if (![...platforms, 'crm'].includes(system))
            throw new Error('Unknown system');

          if (
            !request.path.startsWith('/') ||
            request.path.includes('..') ||
            request.path.includes('://')
          )
            throw new Error('Only relative simulator paths are allowed');

          const url = new URL(`${base}/${system}${request.path}`);

          for (const [key, value] of Object.entries(request.query ?? {}))
            url.searchParams.set(key, value);

          const response = await fetch(url, {
            method: request.method ?? 'GET',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'x-request-id': id,
            },
            ...(request.body === undefined ? {} : { body: json(request.body) }),
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          });

          step.httpStatus = response.status;
          const body = await response.json();

          step.responseBytes = Buffer.byteLength(json(body));

          if (!response.ok) step.outcome = 'http-error';

          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body,
          };
        } finally {
          const record = requests.find((r) => r.requestId === id);

          step.simulatorOutcome = record?.outcome;

          if (record && record.outcome !== 'ok') step.outcome = record.outcome;

          step.mutationCount = mutations.filter(
            (m) => m.requestId === id,
          ).length;
        }
      },
    );
  };

  return {
    http,
    requests,
    records,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

export type Simulators = Awaited<ReturnType<typeof startSimulators>>;
