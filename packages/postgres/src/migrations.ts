// Physical schema is adapter-owned; runtime modules use capability operations.
export const initialMigration = `
CREATE SEQUENCE relate.fetch_order AS bigint CACHE 1;
CREATE TABLE relate.graphs (
  graph_id text PRIMARY KEY,
  definition_revision text NOT NULL
);
CREATE TABLE relate.objects (
  graph_id text NOT NULL REFERENCES relate.graphs(graph_id),
  object_type text NOT NULL,
  source_id text NOT NULL,
  connection_id text NOT NULL,
  partition text NOT NULL,
  object_key text NOT NULL,
  provider_key text NOT NULL,
  observation jsonb NOT NULL,
  PRIMARY KEY (graph_id, object_type, object_key),
  UNIQUE (graph_id, object_type, source_id, connection_id, partition, provider_key)
);
CREATE TABLE relate.value_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  graph_id text NOT NULL,
  object_type text NOT NULL,
  object_key text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('adoption', 'source-refresh')),
  state text NOT NULL,
  values jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  fetch_token bigint NOT NULL,
  FOREIGN KEY (graph_id, object_type, object_key) REFERENCES relate.objects(graph_id, object_type, object_key)
);
`;

export const nativeActionMigration = `
CREATE TABLE relate.native_objects (
  graph_id text NOT NULL REFERENCES relate.graphs(graph_id),
  object_type text NOT NULL,
  object_key text NOT NULL,
  values jsonb NOT NULL,
  created_at double precision NOT NULL,
  PRIMARY KEY (graph_id, object_type, object_key)
);
CREATE TABLE relate.native_invocations (
  graph_id text NOT NULL REFERENCES relate.graphs(graph_id),
  action_id text NOT NULL,
  idempotency_key text NOT NULL,
  invocation_id text,
  input jsonb,
  receipt jsonb,
  PRIMARY KEY (graph_id, action_id, idempotency_key),
  UNIQUE (graph_id, invocation_id)
);
`;

// Legacy observations have no authenticated account provenance. Keep them for
// explicit operator recovery, but never assign them to the next configured account.
export const providerAccountMigration = `
ALTER TABLE relate.objects ADD COLUMN provider_account_id text;
ALTER TABLE relate.objects ADD CONSTRAINT objects_verified_account
  CHECK (provider_account_id IS NOT NULL AND length(btrim(provider_account_id)) > 0) NOT VALID;
DO $$
DECLARE alias_constraint text;
BEGIN
  SELECT conname INTO STRICT alias_constraint FROM pg_constraint
  WHERE conrelid = 'relate.objects'::regclass AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (graph_id, object_type, source_id, connection_id, partition, provider_key)';
  EXECUTE format('ALTER TABLE relate.objects DROP CONSTRAINT %I', alias_constraint);
END $$;
ALTER TABLE relate.objects ADD CONSTRAINT objects_account_alias
  UNIQUE (graph_id, object_type, source_id, connection_id, partition, provider_account_id, provider_key);
`;

// Preserve legacy keys, but do not invent an originating actor or read evidence.
export const receiptRecoveryMigration = `
ALTER TABLE relate.native_invocations ADD COLUMN actor_id text;
ALTER TABLE relate.native_invocations ADD COLUMN reads jsonb;
`;

// Application-owned identity is explicit; legacy NULL provenance remains quarantined.
export const applicationIdentityMigration = `
ALTER TABLE relate.objects ADD COLUMN identity_kind text NOT NULL DEFAULT 'provider';
ALTER TABLE relate.objects DROP CONSTRAINT objects_verified_account;
ALTER TABLE relate.objects ADD CONSTRAINT objects_identity
  CHECK (provider_account_id IS NOT NULL AND (
    (identity_kind = 'provider' AND length(btrim(provider_account_id)) > 0) OR
    (identity_kind = 'application' AND provider_account_id = '')
  )) NOT VALID;
ALTER TABLE relate.objects DROP CONSTRAINT objects_account_alias;
ALTER TABLE relate.objects ADD CONSTRAINT objects_account_alias
  UNIQUE (graph_id, object_type, source_id, connection_id, partition, identity_kind, provider_account_id, provider_key);
`;

export const activityMigration = `
-- One row per attempt, any kind. Always best effort, recorded once the outcome
-- is known; never written inside a committing transaction.
CREATE TABLE relate.operations (
  graph_id text NOT NULL REFERENCES relate.graphs(graph_id),
  id uuid NOT NULL,                        -- UUIDv7; fresh per attempt
  schema_version smallint NOT NULL,
  parent_operation_id uuid,                -- enclosing operation, e.g. the read that triggered a refresh
  kind text NOT NULL,                      -- 'get' | 'query' | 'traverse' | 'invoke' | 'receipt' | 'adopt' | 'refresh'
  actor_kind text NOT NULL,                -- 'principal' | 'system' | 'source'
  actor_id text NOT NULL,
  request_id text NOT NULL,
  transport text NOT NULL,                 -- 'embedded' | 'http' | 'mcp'
  execution_id text,
  runtime_id text,
  initiator_kind text,
  initiator_id text,
  definition_revision text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  duration_ms double precision NOT NULL,   -- monotonic clock
  recorded_at timestamptz NOT NULL,
  outcome text NOT NULL,                   -- 'ok' | 'not-found' | 'succeeded' | 'failed' | 'rejected' | 'uncertain'
  outcome_code text,                       -- ReadErrorCode, ActionErrorCode or a domain failure code
  definition_id text,                      -- result object definition, or the action definition
  target_type text,                        -- requested get target, retained even when absent
  target_key text,
  invocation_id text,                      -- invocation executed or replayed
  replayed boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}',     -- kind-specific: traversalId, from, hasMore, truncated, refresh
  PRIMARY KEY (graph_id, id)
);
CREATE INDEX ON relate.operations (graph_id, recorded_at, id);
CREATE INDEX ON relate.operations (graph_id, parent_operation_id) WHERE parent_operation_id IS NOT NULL;
CREATE INDEX ON relate.operations (graph_id, actor_kind, actor_id, recorded_at);
CREATE INDEX ON relate.operations (graph_id, request_id);
CREATE INDEX ON relate.operations (graph_id, invocation_id) WHERE invocation_id IS NOT NULL;

-- What an operation touched: the lineage edges.
CREATE TABLE relate.operation_objects (
  graph_id text NOT NULL,
  operation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0), -- position in the typed result
  object_type text NOT NULL,
  object_key text NOT NULL,
  role text NOT NULL,                      -- 'target' | 'returned' | 'traversal-origin'
  returned text[] NOT NULL DEFAULT '{}',   -- stable property definition IDs
  forbidden text[] NOT NULL DEFAULT '{}',
  unavailable text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (graph_id, operation_id, ordinal),
  FOREIGN KEY (graph_id, operation_id)
    REFERENCES relate.operations(graph_id, id) ON DELETE CASCADE
);
CREATE INDEX ON relate.operation_objects (graph_id, object_type, object_key, operation_id);

-- One row per committed object change or durable invocation completion.
CREATE TABLE relate.feed_entries (
  graph_id text NOT NULL REFERENCES relate.graphs(graph_id),
  id uuid NOT NULL,                        -- UUIDv7 identity, NOT the feed cursor
  schema_version smallint NOT NULL,
  position bigint NOT NULL,                -- publication order from feed_streams
  kind text NOT NULL CHECK (kind IN (
    'created', 'adopted', 'updated', 'deleted', 'restored',
    'invocation-succeeded', 'invocation-failed'
  )),
  object_type text,
  object_key text,
  changed_property_ids text[],
  source_definition_id text,               -- present exactly for source-backed changes
  action_id text,
  failure_code text,
  invocation_id text,                      -- required for native changes and invocation events
  operation_id uuid NOT NULL,              -- attempt reference; its row may not exist
  parent_operation_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('principal', 'system', 'source')),
  actor_id text NOT NULL,
  triggered_by_kind text,
  triggered_by_id text,
  request_id text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('embedded', 'http', 'mcp')),
  context jsonb NOT NULL DEFAULT '{}',     -- executionId, runtimeId, initiator only
  definition_revision text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (graph_id, id),
  UNIQUE (graph_id, position),
  CHECK (
    (kind IN ('created', 'adopted', 'updated', 'deleted', 'restored')
      AND object_type IS NOT NULL AND object_key IS NOT NULL
      AND changed_property_ids IS NOT NULL
      AND action_id IS NULL AND failure_code IS NULL)
    OR
    (kind IN ('invocation-succeeded', 'invocation-failed')
      AND action_id IS NOT NULL AND invocation_id IS NOT NULL
      AND object_type IS NULL AND object_key IS NULL
      AND changed_property_ids IS NULL AND source_definition_id IS NULL
      AND triggered_by_kind IS NULL AND triggered_by_id IS NULL
      AND actor_kind IN ('principal', 'system')
      AND ((kind = 'invocation-succeeded' AND failure_code IS NULL)
        OR (kind = 'invocation-failed' AND failure_code IS NOT NULL)))
  ),
  CHECK (kind <> 'created' OR source_definition_id IS NULL),
  CHECK (kind <> 'adopted' OR source_definition_id IS NOT NULL),
  CHECK (kind NOT IN ('deleted', 'restored') OR cardinality(changed_property_ids) = 0),
  CHECK (
    kind IN ('invocation-succeeded', 'invocation-failed')
    OR (source_definition_id IS NULL
      AND invocation_id IS NOT NULL AND actor_kind IN ('principal', 'system')
      AND triggered_by_kind IS NULL AND triggered_by_id IS NULL)
    OR (source_definition_id IS NOT NULL AND invocation_id IS NULL
      AND ((kind = 'adopted' AND actor_kind IN ('principal', 'system')
          AND triggered_by_kind IS NULL AND triggered_by_id IS NULL)
        OR (kind IN ('updated', 'deleted', 'restored')
          AND actor_kind = 'source' AND actor_id = source_definition_id
          AND triggered_by_kind IS NOT NULL
          AND triggered_by_kind IN ('principal', 'system')
          AND triggered_by_id IS NOT NULL)))
  )
);
CREATE UNIQUE INDEX ON relate.feed_entries (graph_id, invocation_id)
  WHERE kind IN ('invocation-succeeded', 'invocation-failed');
CREATE INDEX ON relate.feed_entries (graph_id, object_type, object_key, position)
  WHERE object_key IS NOT NULL;
CREATE INDEX ON relate.feed_entries (graph_id, actor_kind, actor_id, position);
CREATE INDEX ON relate.feed_entries (graph_id, invocation_id) WHERE invocation_id IS NOT NULL;
CREATE INDEX ON relate.feed_entries (graph_id, action_id, position) WHERE action_id IS NOT NULL;
CREATE INDEX ON relate.feed_entries (graph_id, source_definition_id, position)
  WHERE source_definition_id IS NOT NULL;
CREATE INDEX ON relate.feed_entries (graph_id, request_id, position);

-- One transactional counter and retention floor per graph, shared by changes
-- and invocation events.
CREATE TABLE relate.feed_streams (
  graph_id text PRIMARY KEY REFERENCES relate.graphs(graph_id),
  stream_id text NOT NULL,                 -- new identity only on explicit reset
  position bigint NOT NULL DEFAULT 0,      -- last committed
  floor bigint NOT NULL DEFAULT 0          -- positions at or below are pruned
);

ALTER TABLE relate.native_invocations RENAME TO invocations;
ALTER TABLE relate.invocations
  ADD COLUMN actor_kind text,
  ADD COLUMN operation_id uuid,
  ADD COLUMN request_id text,
  ADD COLUMN transport text,
  ADD COLUMN definition_revision text,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz;

ALTER TABLE relate.value_changes RENAME TO object_versions;
ALTER TABLE relate.object_versions ADD COLUMN change_id uuid;

-- Creation and adoption provenance, kept for the object's lifetime.
ALTER TABLE relate.native_objects
  ADD COLUMN created_by_kind text,
  ADD COLUMN created_by_id text,
  ADD COLUMN created_invocation_id text;
ALTER TABLE relate.objects
  ADD COLUMN adopted_by_kind text,
  ADD COLUMN adopted_by_id text,
  ADD COLUMN adopted_at timestamptz;
`;
