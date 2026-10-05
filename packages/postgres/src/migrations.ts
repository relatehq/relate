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
