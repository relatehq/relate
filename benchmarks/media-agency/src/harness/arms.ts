import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  implementAction,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import { createDevelopmentExecutor, javascriptInstructions } from '@relate/mcp';
import type { Environment } from '../systems/environment.js';
import type { HttpRequest, System, Row } from '../systems/simulators.js';
import type { DatabaseName } from '../systems/databases.js';
import { ddl } from '../systems/databases.js';
import { routes } from '../systems/simulators.js';
import { createAgencyApp } from '../relate/app.js';
import type { Principal } from '../world/model.js';
import { json, people } from '../world/model.js';
import { submissionInstructions } from '../tasks/submission.js';

export type Arm = 'baseline-tools' | 'baseline-code' | 'relate';
export const arms: Arm[] = ['baseline-tools', 'baseline-code', 'relate'];

export const handbook = `# Northlight Media handbook
It is 2026-10-15T13:00:00Z (14:00 Europe/London). Platform today is partial, in the account timezone. Delivery dates are account-local calendar days.
Names follow NL_{CLIENT}_Q4_{PROSP|RTG}_{PLATFORM}_{ordinal}. Missing platform IDs may be matched by an exact unambiguous name only. Malformed names are ambiguous: report them, never guess.
Client codes and team ownership are in CRM. Ignore IsDeleted merged CRM rows. account_links in plans maps platform accounts to CRM clients. A plan without a platform link does not prove that its campaign does not exist.
All stored money is integer minor units unless a system says otherwise. Reporting currency is the client's currency, using fx_daily on the delivery date. No implicit rounding of converted spend. Pacing = (loaded spend + today's spend) / (plan budget * elapsed flight share). Over-pacing >110%, under-pacing <85%. Treat stale delivery as partial, not exact truth. Inspect etl_runs or Load; TikTok is loaded through October 12.
Performance conversions mean warehouse site conversions (last non-direct click). Platform-reported conversions use 7-day click/1-day view and must be labelled. Invoice reconciliation uses September account-currency delivery, tolerance 2% of delivered spend.
Priya is a retail planner: only retail clients; no fees, margins, invoices or billings; cannot launch or create ad groups. May pause/enable ads or campaigns and move daily budgets by no more than 20% of the day-start budget in cumulative absolute movement (reversals count). Marco is activation lead: all clients, all media actions, no fees/margins/invoices/billings. Fiona is finance: all commercial data; can record disputes, cannot change media.
Never change an ended flight or an unlinked/ambiguous campaign. Never change a shared Google budget implicitly. Record a partial-action caveat if only part of a requested operation succeeds. Unknown write outcome is not proof of failure. Read back before repeating a write. Create unique names and recover by name after a lost response. Creation is not idempotent.
A dispute is a finance.disputes row. Relate additionally creates an internal MediaChange audit record; that record is not extra business success.
`;

export const apiDocs: Record<string, string> = {
  meta: `${routes.meta}\nfields=* required on record/collection reads. Lists: {data,paging?:{cursors:{after}}}; send after cursor and limit <=100. Campaign/adgroup/ad fields: id, account_id, campaign_id, name, status, daily_budget (minor-unit STRING), currency, timezone_name. Ads also adset_id. Account fields: id,name,currency,timezone_name. POST patch with status ACTIVE/PAUSED or daily_budget string. Insights today: data[].spend is a major-unit decimal STRING. Lists use exact account ID, no act_ prefix.`,
  tiktok: `${routes.tiktok}\nAll replies: {code,message?,data}; HTTP 200 can have nonzero code. Lists in data.list, pagination data.page_info.{page,total_page}; page_size<=1000. Service credential may list all advertisers. query filtering is a JSON object of exact field matches, e.g. {campaign_id,adgroup_name} or {adgroup_id}. Fields: campaign_id/adgroup_id/ad_id, advertiser_id, campaign_name/adgroup_name/ad_name, operation_status, budget (major-unit number), currency, timezone. For create send campaign_id, adgroup_name, budget; returns data.adgroup_id. Reads by exact name are available for recovery. Report query campaign_id: data.list[].metrics.spend (major units). Status updates use entity_id and operation_status.`,
  ttd: `${routes.ttd}\nQuery body: optional AdvertiserId/CampaignId/AdGroupId; PageStartIndex,PageSize<=1000; reply {Result,TotalCount}. Fields: Id,AdvertiserId,CampaignId,Name,Status,Budget:{Amount,CurrencyCode},CurrencyCode,Timezone,Targeting. Amount is major units. PUT replaces the ENTIRE object: preserve Targeting and every untouched field. Delivery body CampaignId; Result[].Spend.{Amount,CurrencyCode}.`,
  'google-ads': `${routes['google-ads']}\nAccessible response resourceNames (customers/{id}). Search body query SELECT * FROM campaign|campaign_budget|ad_group|ad_group_ad [WHERE resource.id = 'id'], pageToken. Results key is the exact FROM resource (snake_case); nextPageToken continues. Rows have id,customerId,campaignId,name,status,campaignBudget,amountMicros,currencyCode,timeZone. Today's metrics.costMicros is a STRING in millionths. Mutate body {operations:[{update:{id,status}}]} or budget {id,amountMicros}. Shared campaignBudget IDs refer to ONE budget; changing it affects all siblings.`,
  crm: `${routes.crm}\nSOQL subset: SELECT comma-separated fields (or *) FROM Account [WHERE Team__c = 'retail' AND IsDeleted = false]. Results {records,totalSize,done,nextRecordsUrl?}; follow nextRecordsUrl exactly. Fields Id,Name,Client_Code__c,Team__c,CurrencyIsoCode,Fee_Pct__c,IsDeleted. Id differs from platform account IDs: join account_links.sf_account_id. Fee_Pct__c is commercial.`,
  plans: `${ddl.plans}\nRead-only SQLite. Dates are canonical YYYY-MM-DD text, amounts are minor units of currency. platform_campaign_id is nullable. account_links.id is the platform account ID.`,
  finance: `${ddl.finance}\nSQLite. Amounts are minor units. Commercial data. Only write supported: INSERT INTO disputes(id,invoice_id,reason,amount_minor) VALUES (?,?,?,?). Choose a unique id; every new row is a business effect.`,
  warehouse: `${ddl.warehouse}\nAlso delivery_daily_campaign(platform_campaign_id,platform,date,currency,spend_micros,impressions,clicks,platform_conversions), aggregated from the ad table. site_conversions(platform_campaign_id,date,conversions,revenue_minor), last non-direct click attribution. Read-only DuckDB; DATE columns, BIGINT money in millionths: SUM(spend_micros)/10000.0 yields account-currency minor units (GBP/EUR/USD). FX rates for every date/pair including identity and weekends; date applies to account-local date. etl_runs states latest loaded day. Int64 results are JSON strings.`,
};

export function prompt(principal: Principal) {
  return `You are an assistant at Northlight Media acting for ${principal} (${people[principal].role}). Today is Thursday 15 October 2026, 14:00 Europe/London. Follow the shared handbook and answer contract below. The handbook is also available through read_docs. Return only evidence-backed results, and finish by calling submit_answer exactly once. Do not attempt to inspect the host filesystem, process, network, grading or task source; only use the provided tools and injected helpers.\n\n${handbook}\n${submissionInstructions}`;
}

const properties = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };

export const toolSchemas = {
  read_docs: properties({ doc: string }),
  execute: properties({ code: string }),
  discover: properties({}),
  http_request: properties(
    {
      system: { enum: [...Object.keys(routes)] },
      method: { enum: ['GET', 'POST', 'PUT'] },
      path: string,
      query: { type: 'object', additionalProperties: string },
      body: {},
    },
    ['system', 'path'],
  ),
  sql_query: properties(
    {
      db: { enum: ['plans', 'finance', 'warehouse'] },
      sql: string,
      params: { type: 'array', items: {} },
    },
    ['db', 'sql'],
  ),
  submit_answer: properties(
    {
      answer: {},
      refused: {
        ...properties({ reason: string }),
        description:
          'Required for policy refusals: set answer to null and explain the authority restriction.',
      },
      caveats: {
        type: 'array',
        items: properties({
          kind: {
            ...string,
            description: 'Use stale-data for stale delivery.',
          },
          detail: {
            ...string,
            description:
              'Explain the limitation; include the observed YYYY-MM-DD cutoff for stale delivery.',
          },
        }),
      },
    },
    ['answer', 'caveats'],
  ),
};

export async function createArm(
  arm: Arm,
  principal: Principal,
  env: Environment,
) {
  const executor = createDevelopmentExecutor({
    timeoutMs: 60000,
    maxOutputBytes: 1048576,
  });
  const boundedHttp = async (system: System, request: HttpRequest) => {
    const result = await env.simulators.http(system, request),
      encoded = json(result.body);

    return Buffer.byteLength(encoded) > 100000
      ? {
          ...result,
          body: { truncated: true, preview: encoded.slice(0, 100000) },
        }
      : result;
  };
  const boundedSql = async (
    db: DatabaseName,
    text: string,
    params: unknown[] = [],
  ) => {
    const rows = await env.db.sql(db, text, params, 2001);

    return {
      columns: Object.keys(rows[0] ?? {}),
      rows: rows.slice(0, 2000),
      rowCount: Math.min(rows.length, 2000),
      truncated: rows.length > 2000,
    };
  };
  const agency =
    arm === 'relate'
      ? await createAgencyApp({
          principal,
          http: env.simulators.http,
          db: env.db,
          trace: env.trace,
          directory: env.directory,
        })
      : undefined;
  const access = defineAccess({
    roles: ['service'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const RawHttp = defineAction({
    id: 'raw.http',
    input: z.object({ request: z.string() }),
    output: z.object({ value: z.string() }),
    policy: { execute: access.role('service') },
  });
  const RawSql = defineAction({
    id: 'raw.sql',
    input: z.object({ request: z.string() }),
    output: z.object({ value: z.string() }),
    policy: { execute: access.role('service') },
  });
  const rawGraph = defineGraph({
    id: 'raw-transport-bridge',
    access,
    objects: {},
    actions: { http: RawHttp, sql: RawSql },
    policies: {},
  });
  // Bridge raw calls over the SAME public executor. No pagination/unit/business helpers.
  const raw =
    arm === 'baseline-code'
      ? createRuntime({
          graph: rawGraph,
          bindings: [],
          actionImplementations: [
            implementAction(rawGraph, RawHttp, async ({ input }) => {
              const r = JSON.parse(input.request) as {
                system: System;
                request: HttpRequest;
              };

              try {
                return {
                  value: json({
                    ok: true,
                    value: await boundedHttp(r.system, r.request),
                  }),
                };
              } catch (error) {
                return { value: json({ ok: false, error: String(error) }) };
              }
            }),
            implementAction(rawGraph, RawSql, async ({ input }) => {
              const r = JSON.parse(input.request) as {
                db: DatabaseName;
                text: string;
                params: unknown[];
              };

              try {
                return {
                  value: json({
                    ok: true,
                    value: await boundedSql(r.db, r.text, r.params),
                  }),
                };
              } catch (error) {
                return { value: json({ ok: false, error: String(error) }) };
              }
            }),
          ],
        })
      : undefined;
  const names =
    arm === 'baseline-tools'
      ? (['http_request', 'sql_query', 'read_docs', 'submit_answer'] as const)
      : arm === 'baseline-code'
        ? (['execute', 'read_docs', 'submit_answer'] as const)
        : (['discover', 'execute', 'read_docs', 'submit_answer'] as const);

  return {
    arm,
    agency,
    setupMs: agency?.setupMs ?? 0,
    tools: names.map((name) => ({
      name,
      description:
        name === 'execute'
          ? arm === 'relate'
            ? javascriptInstructions
            : 'Async JS function body with http(system,{path,method?,query?,body?}) and sql(db,text,params?) globals only. http returns {status,headers,body}, sql returns row objects (throws on >2000 rows). Return JSON explicitly. No helpers, retries or pagination.'
          : name === 'read_docs'
            ? `Read handbook${arm === 'relate' ? '' : ' or system API/database docs: ' + Object.keys(apiDocs).join(', ')}.`
            : name === 'submit_answer'
              ? 'Submit the requested answer shape using platform/source IDs and YYYY-MM-DD dates. For prohibited requests use answer:null and refused.reason. Caveats use [{kind,detail}], with stale-data for stale delivery.'
              : name,
      parameters: toolSchemas[name],
    })),
    async call(
      name: string,
      args: Row,
      signal?: AbortSignal,
    ): Promise<unknown> {
      if (
        !(names as readonly string[]).includes(name) ||
        name === 'submit_answer'
      )
        throw new Error('Unknown arm tool');

      if (name === 'read_docs') {
        if (args.doc === 'handbook') return handbook;

        if (arm === 'relate' || !Object.hasOwn(apiDocs, String(args.doc)))
          throw new Error('Unknown document');

        return apiDocs[String(args.doc)];
      }

      if (name === 'http_request')
        return boundedHttp(
          args.system as System,
          args as unknown as HttpRequest,
        );

      if (name === 'sql_query')
        return boundedSql(
          args.db as DatabaseName,
          String(args.sql),
          args.params as unknown[] | undefined,
        );

      if (name === 'discover')
        return {
          graph: agency!.binding.operations.discovery.describe(),
          instructions: javascriptInstructions,
        };

      if (name === 'execute') {
        const code = String(args.code);

        if (code.length > 256 * 1024) throw new Error('Code exceeds 256 KiB');

        if (arm === 'relate')
          return executor.execute({
            code,
            graph: agency!.binding,
            ...(signal ? { signal } : {}),
          });

        const prefix = JSON.stringify(randomUUID());
        const wrapper = `let sequence=0; const invoke=async (name,input)=>{const r=await graph.actions[name]({input:{request:JSON.stringify(input)},idempotencyKey:${prefix}+':'+(++sequence)});if(r.state!=='succeeded')throw new Error(JSON.stringify(r));const decoded=JSON.parse(r.output.value);if(!decoded.ok)throw new Error(decoded.error);return decoded.value;};return await (new (Object.getPrototypeOf(async function(){}).constructor)('http','sql',${JSON.stringify('"use strict";\n' + code)}))( (system,request)=>invoke('http',{system,request}), async(db,text,params=[])=>{const r=await invoke('sql',{db,text,params});if(r.truncated)throw new Error('SQL result exceeds 2000 rows; page or aggregate');return r.rows;});`;

        return executor.execute({
          code: wrapper,
          graph: {
            description: compile(rawGraph).consumer,
            operations: raw!.operations({
              id: 'service',
              roles: ['service'],
              claims: {},
            }),
          },
          ...(signal ? { signal } : {}),
        });
      }

      throw new Error('Unknown tool');
    },
    async close() {
      await raw?.close();
      await agency?.close();
    },
  };
}

export type ArmHandle = Awaited<ReturnType<typeof createArm>>;
