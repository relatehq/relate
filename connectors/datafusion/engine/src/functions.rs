//! Typed scalar function adapter shared by arithmetic and temporal semantics.
use datafusion::{
    arrow::{array::new_empty_array, datatypes::DataType},
    common::{Result, ScalarValue},
    logical_expr::{create_udf, ColumnarValue, Volatility},
    prelude::SessionContext,
};
use std::sync::Arc;

pub(crate) fn scalar(
    ctx: &SessionContext,
    name: &str,
    types: Vec<DataType>,
    output: DataType,
    function: impl Fn(&[ScalarValue]) -> ScalarValue + Send + Sync + 'static,
) {
    let output_type = output.clone();
    ctx.register_udf(create_udf(
        name,
        types,
        output,
        Volatility::Immutable,
        Arc::new(move |args| {
            if args.iter().all(|a| matches!(a, ColumnarValue::Scalar(_))) {
                let values = args
                    .iter()
                    .map(|a| match a {
                        ColumnarValue::Scalar(v) => v.clone(),
                        _ => unreachable!(),
                    })
                    .collect::<Vec<_>>();
                return Ok(ColumnarValue::Scalar(function(&values)));
            }
            let arrays = ColumnarValue::values_to_arrays(args)?;
            if arrays[0].is_empty() {
                return Ok(ColumnarValue::Array(new_empty_array(&output_type)));
            }
            let values = (0..arrays[0].len())
                .map(|i| {
                    let row = arrays
                        .iter()
                        .map(|a| ScalarValue::try_from_array(a, i))
                        .collect::<Result<Vec<_>>>()?;
                    Ok(function(&row))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(ColumnarValue::Array(ScalarValue::iter_to_array(values)?))
        }),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::{arrow::datatypes::Field, logical_expr::ScalarFunctionArgs};

    #[test]
    fn empty_provider_batches_keep_the_declared_output_type() -> Result<()> {
        let ctx = SessionContext::new();
        scalar(
            &ctx,
            "empty_test",
            vec![DataType::Utf8],
            DataType::Boolean,
            |_| panic!("an empty batch has no scalar rows to evaluate"),
        );
        let state = ctx.state();
        let function = state.scalar_functions().get("empty_test").unwrap();
        let value = function.invoke_with_args(ScalarFunctionArgs {
            args: vec![ColumnarValue::Array(new_empty_array(&DataType::Utf8))],
            arg_fields: vec![Arc::new(Field::new("input", DataType::Utf8, true))],
            number_rows: 0,
            return_field: Arc::new(Field::new("output", DataType::Boolean, true)),
            config_options: Arc::default(),
        })?;
        let ColumnarValue::Array(array) = value else {
            panic!("expected an array")
        };
        assert_eq!(array.len(), 0);
        assert_eq!(array.data_type(), &DataType::Boolean);
        Ok(())
    }
}
