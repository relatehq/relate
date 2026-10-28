import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { join } from 'node:path';
import { DuckDBInstance, DuckDBDateValue } from '@duckdb/node-api';
import type { DuckDBValue } from '@duckdb/node-api';
import type { Mutation, World } from '../world/model.js';
import {
  currencies,
  dates,
  delivery,
  fx,
  loaded,
  safety,
} from '../world/generator.js';

export const ddl = {
  plans: `CREATE TABLE clients_ref(client_code TEXT PRIMARY KEY, sf_account_id TEXT NOT NULL);
CREATE TABLE account_links(id TEXT PRIMARY KEY, sf_account_id TEXT NOT NULL, platform TEXT NOT NULL);
CREATE TABLE media_plans(id TEXT PRIMARY KEY, client_code TEXT NOT NULL, quarter TEXT NOT NULL);
CREATE TABLE plan_lines(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, client_code TEXT NOT NULL, sf_account_id TEXT NOT NULL, channel TEXT NOT NULL, platform TEXT NOT NULL, budget_minor INTEGER NOT NULL, currency TEXT NOT NULL, flight_start TEXT NOT NULL, flight_end TEXT NOT NULL, platform_campaign_id TEXT);
CREATE TABLE insertion_orders(id TEXT PRIMARY KEY, plan_line_id TEXT NOT NULL, amount_minor INTEGER NOT NULL);`,
  finance: `CREATE TABLE vendor_invoices(id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, sf_account_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, month TEXT NOT NULL);
CREATE TABLE vendor_invoice_lines(id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, amount_minor INTEGER NOT NULL);
CREATE TABLE client_billings(id TEXT PRIMARY KEY, sf_account_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL);
CREATE TABLE disputes(id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, reason TEXT NOT NULL, amount_minor INTEGER NOT NULL);`,
  warehouse: `CREATE TABLE delivery_daily_ad(ad_id VARCHAR NOT NULL, platform_campaign_id VARCHAR NOT NULL, platform VARCHAR NOT NULL, date DATE NOT NULL, currency VARCHAR NOT NULL, spend_micros BIGINT NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL, platform_conversions BIGINT NOT NULL);
CREATE TABLE fx_daily(date DATE NOT NULL, from_currency VARCHAR NOT NULL, to_currency VARCHAR NOT NULL, rate DOUBLE NOT NULL, PRIMARY KEY(date, from_currency, to_currency));
CREATE TABLE brand_safety_events(id VARCHAR NOT NULL, ad_id VARCHAR NOT NULL, platform_campaign_id VARCHAR NOT NULL, severity VARCHAR NOT NULL, category VARCHAR NOT NULL, observed_at VARCHAR NOT NULL);
CREATE TABLE etl_runs(platform VARCHAR NOT NULL, loaded_through DATE NOT NULL);`,
};

export async function writeDatabases(world: World, directory: string) {
  const paths = {
    plans: join(directory, 'plans.sqlite'),
    finance: join(directory, 'finance.sqlite'),
    warehouse: join(directory, 'warehouse.duckdb'),
  };
  const plans = new DatabaseSync(paths.plans);
  const finance = new DatabaseSync(paths.finance);

  try {
    plans.exec(ddl.plans);
    finance.exec(ddl.finance);
    plans.exec('BEGIN');
    finance.exec('BEGIN');

    for (const c of world.clients) {
      plans.prepare('INSERT INTO clients_ref VALUES (?,?)').run(c.code, c.id);
      plans
        .prepare('INSERT INTO media_plans VALUES (?,?,?)')
        .run(`PLAN-${c.code}`, c.code, 'Q4');
      finance
        .prepare('INSERT INTO client_billings VALUES (?,?,?,?)')
        .run(
          `BILL-${c.code}`,
          c.id,
          91300000 + Math.round(c.feePct * 10000),
          c.currency,
        );
    }

    for (const a of world.accounts)
      plans
        .prepare('INSERT INTO account_links VALUES (?,?,?)')
        .run(a.id, a.clientId, a.platform);

    for (const line of world.lines) {
      const c = world.clients.find((c) => c.id === line.clientId)!;

      plans
        .prepare('INSERT INTO plan_lines VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          line.id,
          `PLAN-${c.code}`,
          c.code,
          c.id,
          line.channel,
          line.platform,
          line.budgetMinor,
          line.currency,
          line.flightStart,
          line.flightEnd,
          line.linkedId,
        );
      plans
        .prepare('INSERT INTO insertion_orders VALUES (?,?,?)')
        .run(`IO-${line.id}`, line.id, line.budgetMinor);
    }

    for (const i of world.invoices) {
      finance
        .prepare('INSERT INTO vendor_invoices VALUES (?,?,?,?,?,?)')
        .run(
          i.id,
          i.campaignId,
          i.clientId,
          i.amountMinor,
          i.currency,
          i.month,
        );
      finance
        .prepare('INSERT INTO vendor_invoice_lines VALUES (?,?,?)')
        .run(`${i.id}-1`, i.id, i.amountMinor);
    }

    plans.exec('COMMIT');
    finance.exec('COMMIT');
  } finally {
    plans.close();
    finance.close();
  }

  const instance = await DuckDBInstance.create(paths.warehouse);
  const db = await instance.connect();

  try {
    await db.run(ddl.warehouse);
    const appender = await db.createAppender('delivery_daily_ad');

    for (const row of delivery(world)) {
      if (!loaded(row)) continue;

      appender.appendVarchar(row.adId);
      appender.appendVarchar(row.campaignId);
      appender.appendVarchar(row.platform);
      appender.appendDate(
        new DuckDBDateValue(Math.floor(Date.parse(row.date) / 86400000)),
      );
      appender.appendVarchar(row.currency);

      for (const n of [
        row.spendMicros,
        row.impressions,
        row.clicks,
        row.conversions,
      ])
        appender.appendBigInt(BigInt(n));

      appender.endRow();
    }

    appender.closeSync();
    await db.run(`CREATE TABLE delivery_daily_campaign AS SELECT platform_campaign_id, platform, date, currency, CAST(SUM(spend_micros) AS BIGINT) spend_micros, CAST(SUM(impressions) AS BIGINT) impressions, CAST(SUM(clicks) AS BIGINT) clicks, CAST(SUM(platform_conversions) AS BIGINT) platform_conversions FROM delivery_daily_ad GROUP BY ALL;
CREATE TABLE site_conversions AS SELECT platform_campaign_id, date, CAST(SUM(platform_conversions) * 0.7 AS BIGINT) conversions, CAST(SUM(platform_conversions) * 3500 AS BIGINT) revenue_minor FROM delivery_daily_ad GROUP BY ALL;`);

    for (const [table, columns] of [
      [
        'delivery_daily_campaign',
        [
          'platform_campaign_id',
          'platform',
          'date',
          'currency',
          'spend_micros',
          'impressions',
          'clicks',
          'platform_conversions',
        ],
      ],
      [
        'site_conversions',
        ['platform_campaign_id', 'date', 'conversions', 'revenue_minor'],
      ],
    ] as const)
      for (const column of columns)
        await db.run(
          `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`,
        );

    const rates = await db.createAppender('fx_daily');

    for (const date of [...dates, '2026-10-15'])
      for (const from of currencies)
        for (const to of currencies) {
          rates.appendDate(
            new DuckDBDateValue(Math.floor(Date.parse(date) / 86400000)),
          );
          rates.appendVarchar(from);
          rates.appendVarchar(to);
          rates.appendDouble(fx(date, from, to));
          rates.endRow();
        }

    rates.closeSync();
    const events = await db.createAppender('brand_safety_events');

    for (const event of safety(world)) {
      for (const value of [
        event.id,
        event.adId,
        event.campaignId,
        event.severity,
        event.category,
        event.observedAt,
      ])
        events.appendVarchar(value);

      events.endRow();
    }

    events.closeSync();
    await db.run(
      "INSERT INTO etl_runs VALUES ('meta', '2026-10-14'), ('tiktok', '2026-10-12'), ('ttd', '2026-10-14'), ('google-ads', '2026-10-14')",
    );
  } finally {
    db.closeSync();
    instance.closeSync();
  }

  return paths;
}

export type DatabaseName = keyof typeof ddl;

export async function openDatabases(
  paths: Record<DatabaseName, string>,
  mutations: Mutation[],
) {
  const plans = new DatabaseSync(paths.plans, { readOnly: true });
  const finance = new DatabaseSync(paths.finance, { readOnly: true });
  const writer = new DatabaseSync(paths.finance);
  const instance = await DuckDBInstance.create(paths.warehouse, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
  });
  const warehouse = await instance.connect();
  const calls: {
    db: string;
    sql: string;
    kind?: 'source-fetch' | 'analytical-dispatch';
  }[] = [];

  return {
    paths,
    calls,
    async sql(
      db: DatabaseName,
      text: string,
      params: unknown[] = [],
      maxRows?: number,
    ): Promise<Record<string, unknown>[]> {
      calls.push({ db, sql: text });

      if (db === 'warehouse') {
        const result =
          maxRows === undefined
            ? await warehouse.runAndReadAll(text, params as DuckDBValue[])
            : await warehouse.streamAndReadUntil(
                text,
                maxRows,
                params as DuckDBValue[],
              );

        return result.getRowObjectsJson().slice(0, maxRows);
      }

      if (db !== 'plans' && db !== 'finance')
        throw new Error('Unknown database');

      if (db === 'finance' && /^\s*INSERT\s+INTO\s+disputes\s*\(/i.test(text)) {
        const before = new Set(
          writer
            .prepare('SELECT id FROM disputes')
            .all()
            .map((r) => r.id),
        );

        writer.prepare(text).run(...(params as SQLInputValue[]));

        for (const row of writer.prepare('SELECT * FROM disputes').all())
          if (!before.has(row.id))
            mutations.push({
              seq: mutations.length + 1,
              system: 'finance',
              entity: 'dispute',
              id: String(row.id),
              op: 'create',
              before: {},
              after: row,
              requestId: `sql-${calls.length}`,
            });

        return [];
      }

      const statement = (db === 'plans' ? plans : finance).prepare(text);

      if (maxRows === undefined)
        return statement.all(...(params as SQLInputValue[]));

      const rows: Record<string, unknown>[] = [];

      for (const row of statement.iterate(...(params as SQLInputValue[]))) {
        rows.push(row);

        if (rows.length >= maxRows) break;
      }

      return rows;
    },
    close() {
      plans.close();
      finance.close();
      writer.close();
      warehouse.closeSync();
      instance.closeSync();
    },
  };
}

export type Databases = Awaited<ReturnType<typeof openDatabases>>;
