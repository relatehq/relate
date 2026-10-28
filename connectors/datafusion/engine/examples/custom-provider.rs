//! Run via datafusion({ enginePath: '.../examples/custom-provider' }).
//! Register providers here; Relate's runtime and authoring contracts stay unchanged.
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
    providers::{ProviderFactory, ProviderRegistry},
    stdio::serve,
};
use serde_json::Value;
use std::sync::Arc;

struct EventsFactory;
#[derive(Debug)]
struct Events {
    table: MemTable,
}
#[async_trait]
impl ProviderFactory for EventsFactory {
    async fn open(
        &self,
        _: &SessionContext,
        options: &Value,
    ) -> anyhow::Result<Arc<dyn TableProvider>> {
        let customer = options["customerId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("customerId is required"))?;
        let schema = Arc::new(Schema::new(vec![
            Field::new("customerId", DataType::Utf8, false),
            Field::new("amount", DataType::Int64, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(vec![customer, customer])),
                Arc::new(Int64Array::from(vec![9007199254740993, 2])),
            ],
        )?;
        Ok(Arc::new(Events {
            table: MemTable::try_new(schema, vec![vec![batch]])?,
        }))
    }
}
#[async_trait]
impl TableProvider for Events {
    fn schema(&self) -> SchemaRef {
        self.table.schema()
    }
    fn table_type(&self) -> TableType {
        TableType::Base
    }
    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        // Build a plan, not an eager remote fetch. For a remote provider, put I/O
        // in its ExecutionPlan's stream. Default filter pushdown is Unsupported:
        // DataFusion retains the filter and never trusts unimplemented pushdown.
        self.table.scan(state, projection, filters, limit).await
    }
}
#[tokio::main(worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let mut registry = ProviderRegistry::default();
    registry.register("demo-events", Arc::new(EventsFactory))?;
    serve(registry).await;
    Ok(())
}
