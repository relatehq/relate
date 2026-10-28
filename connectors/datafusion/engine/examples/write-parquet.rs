//! Test-owned fixture writer. Fields are explicit so nullability and time precision
//! come from the Parquet file, never from overrides in the connector.
use datafusion::{
    arrow::{
        array::{ArrayRef, BooleanArray, Float64Array, Int32Array, Int64Array, StringArray},
        compute::cast,
        datatypes::{DataType, Field, Schema, TimeUnit},
        record_batch::RecordBatch,
    },
    parquet::arrow::ArrowWriter,
};
use serde::Deserialize;
use serde_json::Value;
use std::{io::Read, sync::Arc};
#[derive(Deserialize)]
struct Input {
    fields: Vec<Column>,
    rows: Vec<Vec<Value>>,
}
#[derive(Deserialize)]
struct Column {
    name: String,
    kind: String,
    nullable: bool,
}
fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("output path");
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    let input: Input = serde_json::from_str(&text)?;
    let mut fields = Vec::new();
    let mut arrays: Vec<ArrayRef> = Vec::new();
    for (i, column) in input.fields.iter().enumerate() {
        let strings = || {
            input
                .rows
                .iter()
                .map(|row| {
                    if row[i].is_null() {
                        None
                    } else {
                        Some(
                            row[i]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| row[i].to_string()),
                        )
                    }
                })
                .collect::<Vec<_>>()
        };
        let (kind, array): (DataType, ArrayRef) = match column.kind.as_str() {
            "string" => (DataType::Utf8, Arc::new(StringArray::from(strings()))),
            "boolean" => (
                DataType::Boolean,
                Arc::new(BooleanArray::from(
                    input
                        .rows
                        .iter()
                        .map(|r| r[i].as_bool())
                        .collect::<Vec<_>>(),
                )),
            ),
            "int32" => (
                DataType::Int32,
                Arc::new(Int32Array::from(
                    strings()
                        .iter()
                        .map(|v| v.as_ref().map(|s| s.parse::<i32>().unwrap()))
                        .collect::<Vec<_>>(),
                )),
            ),
            "int64" => (
                DataType::Int64,
                Arc::new(Int64Array::from(
                    strings()
                        .iter()
                        .map(|v| v.as_ref().map(|s| s.parse::<i64>().unwrap()))
                        .collect::<Vec<_>>(),
                )),
            ),
            "float64" => (
                DataType::Float64,
                Arc::new(Float64Array::from(
                    strings()
                        .iter()
                        .map(|v| v.as_ref().map(|s| s.parse::<f64>().unwrap()))
                        .collect::<Vec<_>>(),
                )),
            ),
            "timestamp3" | "timestamp6" | "date" => {
                let kind = if column.kind == "date" {
                    DataType::Date32
                } else {
                    DataType::Timestamp(
                        if column.kind == "timestamp3" {
                            TimeUnit::Millisecond
                        } else {
                            TimeUnit::Microsecond
                        },
                        None,
                    )
                };
                let array = cast(&StringArray::from(strings()), &kind)?;
                (kind, array)
            }
            _ => anyhow::bail!("unsupported fixture type"),
        };
        fields.push(Field::new(&column.name, kind, column.nullable));
        arrays.push(array);
    }
    let schema = Arc::new(Schema::new(fields));
    let batch = RecordBatch::try_new(schema.clone(), arrays)?;
    let mut writer = ArrowWriter::try_new(std::fs::File::create(path)?, schema, None)?;
    writer.write(&batch)?;
    writer.close()?;
    Ok(())
}
