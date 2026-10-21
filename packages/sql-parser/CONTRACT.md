# SQL parser contract

- `createSqlParser` resolves only after the pinned grammar is initialized. Each
  returned `SqlParser.parse` is synchronous and performs no I/O. Initialization
  errors reject startup; there is no alternate grammar or fallback parser.
- The scanner performs the lexical parameter pass, preserving strings, quoted
  identifiers, dollar-quoted strings and nested comments. Only contiguous
  `$name` tokens are rewritten; caller positional parameters are rejected.
- PostgreSQL locations count UTF-8 bytes and syntax error positions count
  Unicode characters. Both map to original-source UTF-16 spans. Repeated named
  parameters share a positional number without losing their individual source
  spans.
- Every consumed tree object has a key allowlist; relevant enum values and list
  arities are checked. Unknown syntax fails closed. An aggregate target and one
  `FROM self.<association>` are required. The whole statement is validated.
- Lowering preserves numeric text without conversion to Number. Identifier names
  are already PostgreSQL-folded or Unicode-decoded; the representation
  separately retains quotedness. Runtime resolution applies the model's
  identifier rules.
- `COALESCE` permits exactly one aggregate and one non-null literal, with type
  compatibility checked later by runtime resolution. `DISTINCT` is allowed only
  for `COUNT(x)`. A caller cannot introduce an aggregate's `FILTER` or ordering.
- The portable result and issue types come from `relate/analytics`. Parser node
  types, driver objects, rewritten SQL and upstream error details never cross
  the public package boundary. Diagnostics contain only fixed messages and
  spans.
- SQL length is bounded before scanning. Parsed object/array count is bounded
  before lowering. Limits are positive integers configured by the host.
- The package owns no connections or database capability. A successful parse
  grants no authorization and cannot be executed as caller SQL.
