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
