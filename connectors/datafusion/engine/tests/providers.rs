use async_trait::async_trait;
use datafusion::{
    arrow::{
        array::{Int64Array, StringArray},
        datatypes::{DataType, Field, Schema, SchemaRef},
        record_batch::RecordBatch,
    },
    catalog::{Session, TableProvider},
    common::Result,
    datasource::MemTable,
    logical_expr::{Expr, TableType},
    physical_plan::ExecutionPlan,
    prelude::SessionContext,
};
use relate_datafusion::{
    open,
    providers::{ProviderFactory, ProviderRegistry, Source},
    run, Operation, Request,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
#[derive(Debug)]
struct TestProvider {
    table: MemTable,
    scans: Arc<AtomicUsize>,
}
#[async_trait]
impl TableProvider for TestProvider {
    fn schema(&self) -> SchemaRef {
        self.table.schema()
    }
    fn table_type(&self) -> TableType {
        TableType::Base
    }
    async fn scan(
        &self,
        session: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        self.scans.fetch_add(1, Ordering::SeqCst);
        self.table.scan(session, projection, filters, limit).await
    }
}
struct Factory {
    scans: Arc<AtomicUsize>,
}
#[async_trait]
impl ProviderFactory for Factory {
    async fn open(
        &self,
        _: &SessionContext,
        options: &Value,
    ) -> anyhow::Result<Arc<dyn TableProvider>> {
        let schema = Arc::new(Schema::new(vec![
            Field::new("customer", DataType::Utf8, false),
            Field::new("amount", DataType::Int64, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(vec!["a", "b", "a"])),
                Arc::new(Int64Array::from(vec![
                    options["amount"].as_i64().unwrap(),
                    100,
                    2,
                ])),
            ],
        )?;
        Ok(Arc::new(TestProvider {
            table: MemTable::try_new(schema, vec![vec![batch]])?,
            scans: self.scans.clone(),
        }))
    }
}
#[tokio::test]
async fn custom_provider_is_selected_and_planned_without_runtime_types() -> anyhow::Result<()> {
    let scans = Arc::new(AtomicUsize::new(0));
    let mut registry = ProviderRegistry::default();
    registry.register(
        "test",
        Arc::new(Factory {
            scans: scans.clone(),
        }),
    )?;
    assert!(registry
        .register(
            "test",
            Arc::new(Factory {
                scans: scans.clone()
            })
        )
        .is_err());
    let source = Source::Custom {
        provider: "test".into(),
        options: json!({"amount":9007199254740993_i64}),
    };
    let ctx = open(&source, &registry).await?;
    assert_eq!(scans.load(Ordering::SeqCst), 0);
    let request = Request { source, columns: HashMap::new(), operation: Operation::Execute {
        sql: "SELECT relate_isum(CAST(amount AS VARCHAR)) FROM dataset WHERE customer = CAST($1 AS VARCHAR)".into(), values: vec![Some("a".into())],
    }};
    assert_eq!(
        run(&ctx, &request).await?,
        json!({"rows":[["9007199254740995"]]})
    );
    assert!(scans.load(Ordering::SeqCst) > 0);
    for sql in [
        "DELETE FROM dataset",
        "CREATE TABLE x AS SELECT * FROM dataset",
        "SET datafusion.execution.target_partitions = 1",
        "COPY dataset TO '/tmp/relate-unauthorized-write.parquet' STORED AS PARQUET",
    ] {
        let request = Request {
            source: Source::Custom {
                provider: "unused".into(),
                options: Value::Null,
            },
            columns: HashMap::new(),
            operation: Operation::Execute {
                sql: sql.into(),
                values: vec![],
            },
        };
        assert!(run(&ctx, &request).await.is_err(), "accepted {sql}");
    }
    Ok(())
}
#[tokio::test]
async fn unknown_providers_and_implicit_remote_access_are_rejected() {
    let registry = ProviderRegistry::default();
    assert!(open(
        &Source::Custom {
            provider: "missing".into(),
            options: Value::Null
        },
        &registry
    )
    .await
    .is_err());
    assert!(open(
        &Source::Parquet {
            url: "https://example.com/data.parquet".into(),
            s3: None
        },
        &registry
    )
    .await
    .is_err());
}
