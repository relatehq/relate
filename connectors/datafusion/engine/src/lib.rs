//! Relate's replaceable DataFusion backend. Only host-generated, typed queries enter here.
pub mod arithmetic;
mod functions;
pub mod providers;
pub mod stdio;
mod temporal;

use anyhow::{bail, Result};
use datafusion::{
    arrow::{
        array::Array,
        datatypes::{DataType, TimeUnit},
    },
    common::ScalarValue,
    execution::{
        disk_manager::{DiskManagerBuilder, DiskManagerMode},
        runtime_env::RuntimeEnvBuilder,
    },
    prelude::{SessionConfig, SessionContext},
};
use providers::{ProviderRegistry, Source};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub source: Source,
    pub columns: HashMap<String, String>,
    pub operation: Operation,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Describe,
    Execute {
        sql: String,
        values: Vec<Option<String>>,
    },
}

pub async fn open(source: &Source, registry: &ProviderRegistry) -> Result<SessionContext> {
    let runtime = RuntimeEnvBuilder::new()
        .with_disk_manager_builder(
            DiskManagerBuilder::default().with_mode(DiskManagerMode::Disabled),
        )
        .with_memory_limit(256 * 1024 * 1024, 1.0)
        .build_arc()?;
    let ctx =
        SessionContext::new_with_config_rt(SessionConfig::new().with_target_partitions(2), runtime);
    arithmetic::register(&ctx);
    temporal::register(&ctx);
    let provider = registry.open(&ctx, source).await?;
    ctx.register_table("dataset", provider)?;
    Ok(ctx)
}

pub async fn run(ctx: &SessionContext, request: &Request) -> Result<Value> {
    match &request.operation {
        Operation::Describe => {
            let schema = ctx.table_provider("dataset").await?.schema();
            let mut columns = serde_json::Map::new();
            for (declared, physical) in &request.columns {
                if let Ok(field) = schema.field_with_name(physical) {
                    let types = match field.data_type() {
                        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => {
                            vec![json!({"type":"string"})]
                        }
                        DataType::Boolean => vec![json!({"type":"boolean"})],
                        DataType::Int32 => vec![json!({"type":"int32"})],
                        DataType::Int64 => vec![json!({"type":"int64"})],
                        DataType::Float64 => vec![json!({"type":"float64"})],
                        DataType::Date32 => vec![json!({"type":"date"})],
                        DataType::Timestamp(TimeUnit::Millisecond, None) => {
                            vec![json!({"type":"timestamp","precision":3})]
                        }
                        DataType::Timestamp(TimeUnit::Microsecond, None) => {
                            vec![json!({"type":"timestamp","precision":6})]
                        }
                        _ => vec![],
                    };
                    columns.insert(
                        declared.clone(),
                        json!({
                            "supportedTypes":types,"nullable":field.is_nullable(),
                            "databaseType":field.data_type().to_string(),
                        }),
                    );
                }
            }
            Ok(json!({"columns":columns}))
        }
        Operation::Execute { sql, values } => {
            // Reject mutations before DataFusion can execute a DDL/DML statement.
            let options = datafusion::execution::context::SQLOptions::new()
                .with_allow_ddl(false)
                .with_allow_dml(false)
                .with_allow_statements(false);
            let frame = ctx
                .sql_with_options(sql, options)
                .await?
                .with_param_values(
                    values
                        .iter()
                        .map(|v| ScalarValue::Utf8(v.clone()))
                        .collect::<Vec<_>>(),
                )?;
            let batches = frame.collect().await?;
            let mut rows = Vec::new();
            for batch in batches {
                for row in 0..batch.num_rows() {
                    let mut cells = Vec::new();
                    for column in batch.columns() {
                        if column.is_null(row) {
                            cells.push(Value::Null);
                            continue;
                        }
                        let value = ScalarValue::try_from_array(column, row)?;
                        cells.push(match value {
                            ScalarValue::Int32(Some(v)) => json!(v),
                            ScalarValue::Int64(Some(v)) => json!(v.to_string()),
                            ScalarValue::Float64(Some(v)) if v.is_finite() => json!(v),
                            ScalarValue::Float64(Some(_)) => json!({"nonFinite":true}),
                            ScalarValue::Boolean(Some(v)) => json!(v),
                            ScalarValue::Utf8(Some(v))
                            | ScalarValue::LargeUtf8(Some(v))
                            | ScalarValue::Utf8View(Some(v)) => json!(v),
                            _ => bail!("unsupported result type"),
                        });
                    }
                    rows.push(cells);
                }
            }
            Ok(json!({"rows":rows}))
        }
    }
}
