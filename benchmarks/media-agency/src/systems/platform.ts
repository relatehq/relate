/** Benchmark-owned integration clients. Baseline arms do not receive these helpers. */
import type { Platform } from '../world/model.js';
import type { Http, Row, System } from './simulators.js';

export function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');

  return value as Row;
}

export async function checked(
  http: Http,
  system: System,
  request: Parameters<Http>[1],
) {
  const response = await http(system, request);
  const body = object(response.body);

  if (response.status >= 400 || (system === 'tiktok' && body.code !== 0))
    throw new Error(`Provider error: ${JSON.stringify(body)}`);

  return body;
}

export async function listPlatform(
  http: Http,
  platform: Platform,
  entity: 'campaign' | 'adgroup' | 'ad' | 'account' | 'budget',
): Promise<Row[]> {
  if (platform === 'meta') {
    const pages = async (path: string) => {
      const rows: Row[] = [];
      let after = '';

      do {
        const body = await checked(http, platform, {
          path,
          query: { fields: '*', limit: '100', ...(after ? { after } : {}) },
        });

        rows.push(...(body.data as Row[]));
        after = String(
          (body.paging as { cursors: { after: string } } | undefined)?.cursors
            .after ?? '',
        );
      } while (after);

      return rows;
    };
    const accounts = await pages('/v21.0/me/adaccounts');

    if (entity === 'account') return accounts;

    const rows: Row[] = [];

    for (const account of accounts)
      rows.push(
        ...(await pages(
          `/v21.0/${account.id}/${entity === 'adgroup' ? 'adsets' : entity + 's'}`,
        )),
      );

    return rows;
  }

  if (platform === 'tiktok') {
    const rows: Row[] = [];
    let page = 1,
      total = 1;

    do {
      const body = await checked(http, platform, {
        path: `/open_api/v1.3/${entity === 'account' ? 'advertiser/info' : entity + '/get'}/`,
        query: { page: String(page), page_size: '1000' },
      });
      const data = object(body.data);

      rows.push(...(data.list as Row[]));
      total = Number(object(data.page_info).total_page);
      page++;
    } while (page <= total);

    return rows;
  }

  if (platform === 'ttd') {
    const rows: Row[] = [];
    let offset = 0,
      total = 1;

    do {
      const body = await checked(http, platform, {
        method: 'POST',
        path: `/v3/${entity === 'account' ? 'advertiser/query/partner' : entity + '/query/' + (entity === 'campaign' ? 'advertiser' : entity === 'adgroup' ? 'campaign' : 'adgroup')}`,
        body: { PageStartIndex: offset, PageSize: 1000 },
      });

      rows.push(...(body.Result as Row[]));
      total = Number(body.TotalCount);
      offset += 1000;
    } while (offset < total);

    return rows;
  }

  const body = await checked(http, platform, {
    path: '/v18/customers:listAccessibleCustomers',
  });
  const accounts = (body.resourceNames as string[]).map((name) => ({
    id: name.slice('customers/'.length),
  }));

  if (entity === 'account') return accounts;

  const rows: Row[] = [],
    resource = {
      campaign: 'campaign',
      budget: 'campaign_budget',
      adgroup: 'ad_group',
      ad: 'ad_group_ad',
    }[entity];

  for (const account of accounts) {
    let pageToken = '';

    do {
      const page = await checked(http, platform, {
        method: 'POST',
        path: `/v18/customers/${account.id}/googleAds:search`,
        body: { query: `SELECT * FROM ${resource}`, pageToken },
      });

      rows.push(...(page.results as Row[]).map((r) => object(r[resource])));
      pageToken = String(page.nextPageToken ?? '');
    } while (pageToken);
  }

  return rows;
}

export function externalId(platform: Platform, entity: string, row: Row) {
  return String(
    platform === 'ttd'
      ? row.Id
      : platform === 'tiktok'
        ? row[`${entity}_id`]
        : row.id,
  );
}

export function normalized(platform: Platform, entity: string, row: Row): Row {
  return {
    id: externalId(platform, entity, row),
    account_id: String(
      row.account_id ?? row.advertiser_id ?? row.AdvertiserId ?? row.customerId,
    ),
    campaign_id: String(
      row.campaign_id ?? row.CampaignId ?? row.campaignId ?? row.id,
    ),
    name: String(row.name ?? row[`${entity}_name`] ?? row.Name),
    status: String(row.status ?? row.operation_status ?? row.Status),
    budget_minor:
      platform === 'meta'
        ? Number(row.daily_budget)
        : platform === 'tiktok'
          ? Math.round(Number(row.budget) * 100)
          : platform === 'ttd'
            ? Math.round(Number(object(row.Budget).Amount) * 100)
            : Number(row.amountMicros) / 10000,
    currency: String(row.currency ?? row.CurrencyCode ?? row.currencyCode),
    timezone: String(
      row.timezone_name ?? row.timezone ?? row.Timezone ?? row.timeZone,
    ),
    budget_id: String(row.campaignBudget ?? externalId(platform, entity, row)),
  };
}

export async function readPlatform(
  http: Http,
  platform: Platform,
  entity: string,
  id: string,
  account?: string,
) {
  if (platform === 'meta')
    return checked(http, platform, {
      path: `/v21.0/${id}`,
      query: { fields: '*' },
    });

  if (platform === 'ttd')
    return checked(http, platform, { path: `/v3/${entity}/${id}` });

  if (platform === 'tiktok') {
    const body = await checked(http, platform, {
      path: `/open_api/v1.3/${entity}/get/`,
      query: { filtering: JSON.stringify({ [`${entity}_id`]: id }) },
    });
    const row = (object(body.data).list as Row[])[0];

    if (!row) throw new Error('not found');

    return row;
  }

  const resource =
    entity === 'campaign'
      ? 'campaign'
      : entity === 'ad'
        ? 'ad_group_ad'
        : entity === 'budget'
          ? 'campaign_budget'
          : 'ad_group';
  const body = await checked(http, platform, {
    method: 'POST',
    path: `/v18/customers/${account}/googleAds:search`,
    body: {
      query: `SELECT * FROM ${resource} WHERE ${resource}.id = '${id.replaceAll("'", "''")}'`,
    },
  });
  const row = (body.results as Row[])[0];

  if (!row) throw new Error('not found');

  return object(row[resource]);
}

export async function writePlatform(
  http: Http,
  platform: Platform,
  entity: string,
  row: Row,
  change: { status?: string | undefined; budgetMinor?: number | undefined },
) {
  const id = externalId(platform, entity, row);

  if (platform === 'meta')
    return checked(http, platform, {
      method: 'POST',
      path: `/v21.0/${id}`,
      body: {
        ...(change.status ? { status: change.status } : {}),
        ...(change.budgetMinor === undefined
          ? {}
          : { daily_budget: String(change.budgetMinor) }),
      },
    });

  if (platform === 'tiktok')
    return checked(http, platform, {
      method: 'POST',
      path: `/open_api/v1.3/${entity}/${change.status ? 'status/update' : 'update'}/`,
      body: {
        [`${entity}_id`]: id,
        ...(change.status ? { operation_status: change.status } : {}),
        ...(change.budgetMinor === undefined
          ? {}
          : { budget: change.budgetMinor / 100 }),
      },
    });

  if (platform === 'ttd')
    return checked(http, platform, {
      method: 'PUT',
      path: `/v3/${entity}`,
      body: {
        ...row,
        ...(change.status ? { Status: change.status } : {}),
        ...(change.budgetMinor === undefined
          ? {}
          : {
              Budget: {
                ...object(row.Budget),
                Amount: change.budgetMinor / 100,
              },
            }),
      },
    });

  return checked(http, platform, {
    method: 'POST',
    path: `/v18/customers/${row.customerId}/${change.budgetMinor === undefined ? (entity === 'ad' ? 'adGroupAds' : 'campaigns') : 'campaignBudgets'}:mutate`,
    body: {
      operations: [
        {
          update: {
            id: change.budgetMinor === undefined ? id : row.campaignBudget,
            ...(change.status
              ? { status: change.status }
              : { amountMicros: String(change.budgetMinor! * 10000) }),
          },
        },
      ],
    },
  });
}
