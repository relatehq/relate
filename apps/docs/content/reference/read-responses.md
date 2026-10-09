# Read Responses & Evidence

Relate returns **compact evidence by default** from `get`, `query`, and both
kinds of `traverse`. The same default applies to reads and queries inside an
action handler. Values, authorization, freshness rules, and pagination are
identical in compact and full modes; only the evidence presentation changes.

## Choosing evidence detail

```ts
// Compact is the default. Select only the properties needed for the task.
const customer = await objects.Customer.get(customerId, {
  select: ['name', 'status'],
});

// Ask for full provenance when inspecting an observation.
const detailed = await objects.Customer.get(customerId, {
  select: ['name'],
  evidence: 'full',
});

// The same option works with collection reads.
const page = await objects.Customer.query({
  select: ['name'],
  limit: 20,
  evidence: 'compact',
});
```

A later full read is a new authorized read and may observe newer data. It is not
a lookup of the exact evidence from an earlier compact response.

## Single-object response

`get` and to-one traversal return one of these shapes. IDs and revisions below
are illustrative.

```json
{
  "status": "ok",
  "id": "b2375d21-941a-4bc7-b9ae-669a3b798ecf",
  "data": { "name": "Northwind", "status": "active" },
  "meta": {
    "evidence": "compact",
    "completeness": "complete",
    "degraded": false,
    "definitionRevision": "sha256:…"
  }
}
```

```json
{ "status": "not-found" }
```

| Field    | Meaning and use                                                                                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status` | `ok` means the object is readable. `not-found` covers missing and hidden objects without revealing which; it has no `id`, `data`, or `meta`.                                                                                                                     |
| `id`     | Relate's canonical object ID. Use it in subsequent graph operations. It is not the provider's source key and is present even if `id` was not selected in `data`.                                                                                                 |
| `data`   | Selected, authorized property values, keyed by the graph's property names. Fields can be omitted; never assume selection guarantees a value. `null`, `false`, `0`, and empty strings are legitimate values. Business properties named `meta` are left untouched. |
| `meta`   | Evidence about this selection, described below. It is separate from business data.                                                                                                                                                                               |

The lower-level `@relate/runtime` method `read` returns the same envelope
without the top-level `id`; its caller already supplies the ID. The typed
`@relate/node` `get` result includes it.

## Response metadata

| Field                     | Meaning and use                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.evidence`           | `compact` or `full`. Identifies the presentation actually returned.                                                                                                                                                              |
| `meta.completeness`       | `complete` means every selected field is available or known absent. `partial` means at least one is forbidden or unavailable. This describes the field selection, not provider coverage.                                         |
| `meta.degraded`           | `true` when the read has stale/unavailable evidence, failed refresh, or retention/ordering warnings. A permission-only omission can be `partial` with `degraded: false`. Inspect exceptional fields and warnings for the reason. |
| `meta.definitionRevision` | Hash of the compiled graph definition used for this read. Use it to associate the response with the model; it is not a data version or snapshot identifier.                                                                      |
| `meta.fields`             | Evidence keyed by selected property name. Full mode includes all selected fields. Compact mode includes only exceptions and omits this member when none exist. Use optional access, such as `result.meta.fields?.name`.          |
| `meta.warnings`           | Observation retention or ordering warnings. Full mode always includes an array, possibly empty. Compact mode omits an empty array but preserves every nonempty warning.                                                          |

Compact omits a field's evidence only when it is `available`, `fresh`, has
confirmed retention and ordering, and refresh was `not-needed` or `succeeded`.
It keeps **full evidence for every other field**, including known absence,
forbidden/unavailable values, stale values, failed or superseded refresh, and
uncertain retention or ordering.

Omitted routine evidence does not promise persistent storage or complete
provider coverage. Request full evidence if source identity, observation time,
or storage durability matters to your decision.

## Full field evidence

A full response has `meta.evidence: "full"` and includes this shape for each
available or known absent field:

```json
{
  "status": "available",
  "freshness": "fresh",
  "observedAt": "2026-10-09T07:00:00.000Z",
  "source": "source",
  "sourceDefinitionId": "crm.customers",
  "orderingBasis": "fetch-start",
  "retention": "confirmed",
  "retentionDurability": "volatile",
  "ordering": "confirmed",
  "refresh": "not-needed"
}
```

| Field                 | Values and use                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`              | `available`: a value is supplied. `absent`: an optional value is known to be absent and omitted from `data`; this still counts as complete. `forbidden`: the caller lacks the selected field's access group. `unavailable`: no value can be supplied, including an unknown field, omitted stale value, or undisclosable reference target. |
| `freshness`           | `fresh` or `stale` under this read's freshness rules. Freshness is relative to Relate's observation, not a guarantee that the provider has not changed.                                                                                                                                                                                   |
| `observedAt`          | ISO timestamp of the observation. Useful for assessing age. It is not necessarily the provider's last-modified timestamp.                                                                                                                                                                                                                 |
| `source`              | `source` for connector-backed values, `native` for values owned by Relate.                                                                                                                                                                                                                                                                |
| `sourceDefinitionId`  | Stable source-definition ID for a source-backed value. Omitted for native values. Identifies the modeled source, not credentials or a provider record key.                                                                                                                                                                                |
| `orderingBasis`       | `source-version` if source version ordering is available; otherwise `fetch-start`. Omitted for native values. Explains how competing observations are ordered.                                                                                                                                                                            |
| `retention`           | `confirmed`: the observation was retained; `failed`: retention failed; `unconfirmed`: its retention outcome is uncertain. A returned value need not have been retained.                                                                                                                                                                   |
| `retentionDurability` | `volatile` for memory storage or `persistent` for storage that survives process restart. Confirmed retention alone does not imply persistence.                                                                                                                                                                                            |
| `ordering`            | `confirmed` or `unconfirmed`. Whether observation ordering was established. Use this alongside retention when assessing concurrent refreshes.                                                                                                                                                                                             |
| `refresh`             | `not-needed`: no refresh was needed; `succeeded`: refresh succeeded; `unavailable`: the source could not supply a refresh; `invalid`: the refreshed observation was invalid; `superseded`: a newer observation won.                                                                                                                       |

Forbidden and unavailable fields contain **only** their status:

```json
{
  "revenue": { "status": "forbidden" },
  "manager": { "status": "unavailable" }
}
```

They contain no private source or policy details. A hidden reference target is
indistinguishable from a missing target. Default selection includes only
permitted fields, so it does not enumerate forbidden fields.

### Warnings

| Warning                    | Meaning and use                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `observation_not_retained` | A fetched observation could not be retained. The value may still be returned; do not assume a later read can recover it from storage. |
| `retention_unconfirmed`    | Whether the observation was retained could not be confirmed.                                                                          |
| `ordering_unconfirmed`     | Observation ordering could not be confirmed. Do not treat the result as proof that no newer observation exists.                       |

## Collection responses

`query` and to-many traversal return a `QueryResult`. Await it for **one page**:

```json
{
  "data": [
    {
      "id": "b2375d21-941a-4bc7-b9ae-669a3b798ecf",
      "data": { "name": "Northwind" },
      "meta": {
        "evidence": "compact",
        "completeness": "complete",
        "degraded": false,
        "definitionRevision": "sha256:…"
      }
    }
  ],
  "meta": { "exhausted": false, "continuationCursor": "opaque-token" }
}
```

| Field                     | Meaning and use                                                                                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`                    | Array of authorized records. Each has `id`, `data`, and the same per-record `meta` described above, but no `status` member.                                                                                                                  |
| `meta.exhausted`          | `true` when the graph scan has finished. `false` means continuation is required, even when this page has no records.                                                                                                                         |
| `meta.continuationCursor` | Opaque continuation token, present exactly when `exhausted` is `false`. Pass it as `cursor` with the same operation, principal, selection, filters and other options; the evidence mode may change between pages. Do not decode or alter it. |

Collections enumerate **adopted graph members**, not all provider records.
Exhaustion does not establish provider-wide coverage. Pages are not a frozen
snapshot; concurrent changes can affect later reads.

`for await` automatically follows pages. When returning data to an agent, await
one page and pass on its continuation instead of gathering an unbounded array.
Compact evidence reduces repetition, but does not bound large values or total
collection size. Use `select`, filters and a small `limit` as well.

## Read options

| Option            | Default and behavior                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence`        | `compact`. Set `full` for every selected field's evidence. Does not change resolution or authorization.                                                                       |
| `select`          | All permitted properties. An explicit array limits returned properties; at most 100 names. An empty array requests no property values.                                        |
| `maxAgeMs`        | `60000`. Maximum acceptable observation age before attempting refresh. Must be finite and nonnegative.                                                                        |
| `refresh`         | `false`. `true` requests refresh even within the freshness window.                                                                                                            |
| `stale`           | `allow`. `omit` withholds stale values and reports them as unavailable.                                                                                                       |
| `requireComplete` | `false`. `true` throws `ReadError('incomplete')` when any selected field is forbidden or unavailable. Known absence is complete; use `assertFields` to require actual values. |
| `timeoutMs`       | `3000`. Source-operation timeout; must be greater than zero and at most `10000`.                                                                                              |
| `limit`           | `25`, from 1 to 100. Applies to query and to-many traversal. A page can contain fewer records because of filtering or authorization.                                          |
| `cursor`          | No continuation by default. Applies to query and to-many traversal.                                                                                                           |
| `where`           | No filters. Query only: equality filters on graph property names, combined with AND. Filter values must conform to the property schema and the caller must have field access. |

Invalid requests throw `ReadError('invalid-request')`. Reads that cannot be
performed can throw `ReadError('unavailable')`; incomplete required evidence can
throw `ReadError('incomplete')`. These are errors, not additional `status`
values. Compact mode does not hide them.

HTTP and MCP adapters remain planned. This reference describes the currently
implemented embedded APIs and the shared protocol they will use.
