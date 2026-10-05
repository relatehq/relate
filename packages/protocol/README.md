# @relate/protocol

Transport-neutral Customer read requests, results, evidence, and errors. Private
and unpublished. No runtime, database, or provider dependencies.

Results distinguish `not-found` from `ok`, then represent each requested field
as available, absent (a known optional value), or unavailable. Hidden, unknown
and unobtainable fields share the public unavailable shape. Null remains a
legitimate available value. Data is a partial JSON record, never typed as a
complete model.

Completeness, freshness, and durability are independent. Evidence reports source
identity only for authorized exposed values and never includes raw provider
errors or aliases. HTTP and MCP adapters are not implemented in this slice.

Field evidence separates the retention outcome from `retentionDurability`:
`volatile` for memory and `persistent` for storage that survives process
restart. A confirmed retention outcome alone is not a persistence guarantee.
