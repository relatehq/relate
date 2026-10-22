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

// Activity: the durable feed, best-effort operations and permanent object
// provenance. Legacy rows keep null provenance; nothing is invented for them.
export const activityMigration = `
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

ALTER TABLE relate.native_objects
  ADD COLUMN created_by_kind text,
  ADD COLUMN created_by_id text,
  ADD COLUMN created_invocation_id text;
ALTER TABLE relate.objects
  ADD COLUMN adopted_by_kind text,
  ADD COLUMN adopted_by_id text,
  ADD COLUMN adopted_at timestamptz;

CREATE TABLE relate.operations (
  graph_id text NOT NULL REFERENCES relate.graphs(graph_id),
  id uuid NOT NULL,
  schema_version smallint NOT NULL,
  parent_operation_id uuid,
  kind text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  transport text NOT NULL,
  execution_id text,
  runtime_id text,
  initiator_kind text,
  initiator_id text,
  definition_revision text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  duration_ms double precision NOT NULL,
  recorded_at timestamptz NOT NULL,
  outcome text NOT NULL,
  outcome_code text,
  definition_id text,
  target_type text,
  target_key text,
  invocation_id text,
  replayed boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (graph_id, id)
);
CREATE INDEX ON relate.operations (graph_id, recorded_at, id);
CREATE INDEX ON relate.operations (graph_id, parent_operation_id) WHERE parent_operation_id IS NOT NULL;
CREATE INDEX ON relate.operations (graph_id, actor_kind, actor_id, recorded_at);
CREATE INDEX ON relate.operations (graph_id, request_id);
CREATE INDEX ON relate.operations (graph_id, invocation_id) WHERE invocation_id IS NOT NULL;

CREATE TABLE relate.operation_objects (
  graph_id text NOT NULL,
  operation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  object_type text NOT NULL,
  object_key text NOT NULL,
  role text NOT NULL,
  returned text[] NOT NULL DEFAULT '{}',
  forbidden text[] NOT NULL DEFAULT '{}',
  unavailable text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (graph_id, operation_id, ordinal),
  FOREIGN KEY (graph_id, operation_id)
    REFERENCES relate.operations(graph_id, id) ON DELETE CASCADE
);
CREATE INDEX ON relate.operation_objects (graph_id, object_type, object_key, operation_id);

CREATE TABLE relate.feed_entries (
  graph_id text NOT NULL REFERENCES relate.graphs(graph_id),
  id uuid NOT NULL,
  schema_version smallint NOT NULL,
  position bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'created', 'adopted', 'updated', 'deleted', 'restored',
    'invocation-succeeded', 'invocation-failed'
  )),
  object_type text,
  object_key text,
  changed_property_ids text[],
  source_definition_id text,
  action_id text,
  failure_code text,
  invocation_id text,
  operation_id uuid NOT NULL,
  parent_operation_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('principal', 'system', 'source')),
  actor_id text NOT NULL,
  triggered_by_kind text,
  triggered_by_id text,
  request_id text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('embedded', 'http', 'mcp')),
  context jsonb NOT NULL DEFAULT '{}',
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

-- One transactional counter and retention floor per graph. A separate row:
-- source and native transactions hold graphs FOR SHARE throughout.
CREATE TABLE relate.feed_streams (
  graph_id text PRIMARY KEY REFERENCES relate.graphs(graph_id),
  stream_id text NOT NULL,
  position bigint NOT NULL DEFAULT 0,
  floor bigint NOT NULL DEFAULT 0
);
INSERT INTO relate.feed_streams(graph_id, stream_id)
  SELECT graph_id, gen_random_uuid()::text FROM relate.graphs;
`;

// Development-only reset: old observations do not identify their physical resource.
// Never guess a resource for retained data. Native objects and activity survive.
export const resourceIdentityMigration = `
DELETE FROM relate.object_versions;
DELETE FROM relate.objects;
ALTER TABLE relate.objects ADD COLUMN resource_id text NOT NULL
  CHECK (length(btrim(resource_id)) > 0);
ALTER TABLE relate.objects DROP CONSTRAINT objects_account_alias;
ALTER TABLE relate.objects ADD CONSTRAINT objects_resource_alias
  UNIQUE (graph_id, object_type, source_id, connection_id, resource_id,
          partition, identity_kind, provider_account_id, provider_key);
`;
