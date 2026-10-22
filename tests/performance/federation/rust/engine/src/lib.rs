//! Experimental, trusted-host SQL runner. Not a public Relate authorization boundary.
use anyhow::{bail, Context, Result};
use datafusion::{
    arrow::{
        array::{ArrayRef, BooleanArray, StringArray, UInt32Array},
        datatypes::{DataType, Field, Schema},
        json::ArrayWriter,
        record_batch::RecordBatch,
    },
    catalog::{
        CatalogProvider, CatalogProviderList, MemoryCatalogProvider, MemoryCatalogProviderList,
        MemorySchemaProvider,
    },
    datasource::MemTable,
    execution::session_state::SessionStateBuilder,
    physical_plan::display::DisplayableExecutionPlan,
    prelude::{ParquetReadOptions, SessionConfig, SessionContext},
    sql::TableReference,
};
use datafusion_table_providers::{
    postgres::PostgresTableFactory,
    sql::db_connection_pool::{
        postgrespool::PostgresConnectionPool, sqlitepool::SqliteConnectionPoolFactory, Mode,
        StaticPasswordProvider,
    },
    sqlite::SqliteTableFactory,
    util::secrets::to_secret_map,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub customers_path: String,
    pub events_path: String,
    pub schema: String,
    #[serde(default = "partitions")]
    pub partitions: usize,
}
fn partitions() -> usize {
    4
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub sql: String,
    #[serde(default = "mode")]
    pub mode: String,
    #[serde(default)]
    pub explain: bool,
    #[serde(default = "timeout")]
    pub timeout_ms: u64,
    pub candidate_ids: Option<Vec<String>>,
    #[serde(default)]
    pub scopes: Vec<ScopeInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeInput {
    pub key_count: usize,
    pub mask_count: usize,
    pub rows: Vec<ScopeRow>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeRow {
    pub row_index: u32,
    pub values: Vec<Option<String>>,
    pub valid: Vec<bool>,
}
fn mode() -> String {
    "federated".into()
}
fn timeout() -> u64 {
    60_000
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub rows: serde_json::Value,
    pub plan_ms: f64,
    pub collect_ms: f64,
    pub encode_ms: f64,
    pub plan: Option<String>,
}

pub struct Engine {
    scan: SessionContext,
    federated: SessionContext,
}
impl Engine {
    pub async fn open(config: Config) -> Result<Self> {
        if config.partitions == 0 || config.partitions > 32 {
            bail!("partitions must be 1..32");
        }
        // Credentials stay in the process environment, never the benchmark protocol/report.
        let url = url::Url::parse(
            &std::env::var("RELATE_TEST_DATABASE_URL")
                .context("RELATE_TEST_DATABASE_URL required")?,
        )?;
        let host = match url.host_str().context("database host required")? {
            "localhost" | "127.0.0.1" => "127.0.0.1",
            _ => bail!("spike supports only local IPv4 PostgreSQL"),
        };
        let user = url.username();
        let database = url.path().trim_start_matches('/');
        for value in [user, database] {
            if value.is_empty()
                || !value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                bail!("spike requires simple local database/user names");
            }
        }
        // hostaddr avoids the provider's DNS preflight for an already known IP.
        // Its Hickory DNS preflight fails on this macOS host.
        // The real PostgreSQL connection is still opened and verified by the pool.
        let params = to_secret_map(HashMap::from([
            (
                "connection_string".into(),
                format!(
                    "hostaddr={host} port={} user={user} dbname={database} sslmode=disable",
                    url.port().unwrap_or(5432)
                ),
            ),
            ("connection_pool_size".into(), "4".into()),
        ]));
        let password = Arc::new(StaticPasswordProvider::new(
            url.password().unwrap_or("").to_owned().into(),
        ));
        let pg = PostgresTableFactory::new(Arc::new(
            PostgresConnectionPool::new_with_password_provider(params, password).await?,
        ));
        let sqlite = SqliteTableFactory::new(Arc::new(
            SqliteConnectionPoolFactory::new(
                &config.customers_path,
                Mode::File,
                Duration::from_secs(5),
            )
            .build()
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?,
        ));
        let session_config = SessionConfig::new().with_target_partitions(config.partitions);
        let scan = SessionContext::new_with_config(session_config.clone());
        let federated = SessionContext::new_with_state(
            SessionStateBuilder::new_from_existing(datafusion_federation::default_session_state())
                .with_config(session_config)
                .build(),
        );
        let customers = sqlite
            .table_provider(TableReference::bare("customers"))
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let events = pg
            .table_provider(TableReference::partial(config.schema.clone(), "events"))
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let invoices = pg
            .table_provider(TableReference::partial(config.schema, "invoices"))
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        for ctx in [&scan, &federated] {
            ctx.register_table("customers", customers.clone())?;
            ctx.register_table("events", events.clone())?;
            ctx.register_table("invoices", invoices.clone())?;
            ctx.register_parquet(
                "file_events",
                &config.events_path,
                ParquetReadOptions::default(),
            )
            .await?;
        }
        Ok(Self { scan, federated })
    }

    pub async fn query(&self, request: Request) -> Result<Response> {
        if request.timeout_ms == 0 || request.timeout_ms > 120_000 {
            bail!("timeoutMs must be 1..120000");
        }
        let ctx = match request.mode.as_str() {
            "scan" => &self.scan,
            "federated" => &self.federated,
            _ => bail!("unknown execution mode"),
        };
        // API is only for trusted benchmark SQL. SessionContext SQL is NOT a sandbox.
        tokio::time::timeout(Duration::from_millis(request.timeout_ms), async {
            let start = Instant::now();
            // A fresh catalog per request is essential: concurrent requests may
            // have disjoint authorized inputs. Never mutate the shared catalog.
            let scoped;
            let ctx = if let Some(ids) = &request.candidate_ids {
                if ids.len() > 50_000 || request.scopes.len() > 32 {
                    bail!("scope input exceeds spike capacity");
                }
                let catalog_list = Arc::new(MemoryCatalogProviderList::new());
                let catalog = Arc::new(MemoryCatalogProvider::new());
                catalog.register_schema("public", Arc::new(MemorySchemaProvider::new()))?;
                catalog_list.register_catalog("datafusion".into(), catalog);
                scoped = SessionContext::new_with_state(
                    SessionStateBuilder::new_from_existing(ctx.state())
                        .with_catalog_list(catalog_list)
                        .build(),
                );
                for name in ["customers", "events", "invoices", "file_events"] {
                    scoped.register_table(name, ctx.table_provider(name).await?)?;
                }
                let schema = Arc::new(Schema::new(vec![
                    Field::new("row_index", DataType::UInt32, false),
                    Field::new("object_id", DataType::Utf8, false),
                ]));
                let batch = RecordBatch::try_new(
                    schema.clone(),
                    vec![
                        Arc::new(UInt32Array::from_iter_values(0..ids.len() as u32)),
                        Arc::new(StringArray::from_iter_values(ids)),
                    ],
                )?;
                scoped.register_table(
                    "authorized",
                    Arc::new(MemTable::try_new(schema, vec![vec![batch]])?),
                )?;
                for (index, input) in request.scopes.iter().enumerate() {
                    if input.key_count > 32 || input.mask_count > 32 || input.rows.len() > ids.len()
                    {
                        bail!("invalid scope dimensions");
                    }
                    let mut seen = std::collections::HashSet::new();
                    for row in &input.rows {
                        if row.row_index as usize >= ids.len()
                            || !seen.insert(row.row_index)
                            || row.values.len() != input.key_count
                            || row.valid.len() != input.mask_count
                        {
                            bail!("invalid scope row");
                        }
                    }
                    let mut fields = vec![Field::new("row_index", DataType::UInt32, false)];
                    let mut arrays: Vec<ArrayRef> = vec![Arc::new(UInt32Array::from_iter_values(
                        input.rows.iter().map(|r| r.row_index),
                    ))];
                    for key in 0..input.key_count {
                        fields.push(Field::new(format!("k{key}"), DataType::Utf8, true));
                        arrays.push(Arc::new(StringArray::from_iter(
                            input.rows.iter().map(|r| r.values[key].as_deref()),
                        )));
                    }
                    for mask in 0..input.mask_count {
                        fields.push(Field::new(format!("m{mask}"), DataType::Boolean, false));
                        arrays.push(Arc::new(BooleanArray::from_iter(
                            input.rows.iter().map(|r| Some(r.valid[mask])),
                        )));
                    }
                    let schema = Arc::new(Schema::new(fields));
                    let batch = RecordBatch::try_new(schema.clone(), arrays)?;
                    scoped.register_table(
                        format!("scope_{index}"),
                        Arc::new(MemTable::try_new(schema, vec![vec![batch]])?),
                    )?;
                }
                &scoped
            } else {
                if !request.scopes.is_empty() {
                    bail!("scopes require candidateIds");
                }
                ctx
            };
            let frame = ctx.sql(&request.sql).await?;
            let physical = frame.create_physical_plan().await?;
            let plan_ms = start.elapsed().as_secs_f64() * 1000.;
            let start = Instant::now();
            let batches =
                datafusion::physical_plan::collect(physical.clone(), ctx.task_ctx()).await?;
            let collect_ms = start.elapsed().as_secs_f64() * 1000.;
            let plan = request.explain.then(|| {
                DisplayableExecutionPlan::with_metrics(physical.as_ref())
                    .indent(true)
                    .to_string()
            });
            let start = Instant::now();
            let mut writer = ArrayWriter::new(Vec::new());
            writer.write_batches(&batches.iter().collect::<Vec<_>>())?;
            writer.finish()?;
            let rows = serde_json::from_slice(&writer.into_inner())?;
            Ok(Response {
                rows,
                plan_ms,
                collect_ms,
                encode_ms: start.elapsed().as_secs_f64() * 1000.,
                plan,
            })
        })
        .await
        .context("query deadline exceeded (remote cancellation not guaranteed)")?
    }

    // Snapshot is deliberately a separate setup operation; query timing never hides loading.
    pub async fn snapshot(&self) -> Result<f64> {
        let start = Instant::now();
        for table in ["customers", "events", "invoices", "file_events"] {
            let frame = self.scan.table(table).await?;
            let declared_schema = Arc::new(frame.schema().as_arrow().clone());
            let batches = frame.collect().await?;
            // Providers can return a narrower observed schema (e.g. timestamp
            // timezone metadata); cache actual batches, not discovery metadata.
            let schema = batches
                .first()
                .map(|b| b.schema())
                .unwrap_or(declared_schema);
            let snapshot = Arc::new(MemTable::try_new(schema, vec![batches])?);
            self.federated
                .register_table(format!("cached_{table}"), snapshot)?;
        }
        Ok(start.elapsed().as_secs_f64() * 1000.)
    }
}

pub async fn dispatch(engine: &Engine, input: &str) -> Result<serde_json::Value> {
    if input == "snapshot" {
        return Ok(serde_json::json!({"snapshotMs": engine.snapshot().await?}));
    }
    Ok(serde_json::to_value(
        engine.query(serde_json::from_str(input)?).await?,
    )?)
}
