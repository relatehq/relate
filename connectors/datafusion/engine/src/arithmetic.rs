//! Checked cells preserve Relate semantics without relying on native overflow behavior.
use crate::functions::scalar;
use datafusion::{
    arrow::{
        array::{Array, ArrayRef, StringArray, UInt64Array},
        datatypes::DataType,
    },
    common::{Result, ScalarValue},
    logical_expr::{create_udaf, Accumulator, Volatility},
    prelude::SessionContext,
};
use num_bigint::BigInt;
use num_traits::{ToPrimitive, Zero};
use std::sync::Arc;

fn text(value: &ScalarValue) -> Option<&str> {
    match value {
        ScalarValue::Utf8(v) => v.as_deref(),
        _ => None,
    }
}
fn number(value: &ScalarValue) -> Option<f64> {
    match value {
        ScalarValue::Float64(v) => *v,
        _ => None,
    }
}
pub fn register(ctx: &SessionContext) {
    scalar(
        ctx,
        "relate_ifailed",
        vec![DataType::Utf8],
        DataType::Boolean,
        |v| ScalarValue::Boolean(text(&v[0]).map(|s| s == "!")),
    );
    scalar(
        ctx,
        "relate_ffailed",
        vec![DataType::Float64],
        DataType::Boolean,
        |v| ScalarValue::Boolean(number(&v[0]).map(|x| !x.is_finite())),
    );
    scalar(
        ctx,
        "relate_ifloat",
        vec![DataType::Utf8],
        DataType::Float64,
        |v| {
            ScalarValue::Float64(
                text(&v[0]).map(|s| s.parse::<i64>().map(|x| x as f64).unwrap_or(f64::NAN)),
            )
        },
    );
    for (name, op) in [("add", '+'), ("sub", '-'), ("mul", '*'), ("div", '/')] {
        scalar(
            ctx,
            &format!("relate_i{name}"),
            vec![DataType::Utf8, DataType::Utf8],
            DataType::Utf8,
            move |v| {
                let (a, b) = (text(&v[0]), text(&v[1]));
                let value =
                    if a == Some("!") || b == Some("!") {
                        Some("!".into())
                    } else {
                        a.zip(b).map(|(a, b)| {
                            let result = a.parse::<i64>().ok().zip(b.parse::<i64>().ok()).and_then(
                                |(a, b)| match op {
                                    '+' => a.checked_add(b),
                                    '-' => a.checked_sub(b),
                                    '*' => a.checked_mul(b),
                                    _ => None,
                                },
                            );
                            result.map(|x| x.to_string()).unwrap_or_else(|| "!".into())
                        })
                    };
                ScalarValue::Utf8(value)
            },
        );
        scalar(
            ctx,
            &format!("relate_f{name}"),
            vec![DataType::Float64, DataType::Float64],
            DataType::Float64,
            move |v| {
                let (a, b) = (number(&v[0]), number(&v[1]));
                let value =
                    if a.is_some_and(|x| !x.is_finite()) || b.is_some_and(|x| !x.is_finite()) {
                        Some(f64::NAN)
                    } else {
                        a.zip(b).map(|(a, b)| match op {
                            '+' => a + b,
                            '-' => a - b,
                            '*' => a * b,
                            _ => a / b,
                        })
                    };
                ScalarValue::Float64(value)
            },
        );
    }
    for average in [false, true] {
        ctx.register_udaf(create_udaf(
            if average {
                "relate_iavg"
            } else {
                "relate_isum"
            },
            vec![DataType::Utf8],
            Arc::new(if average {
                DataType::Float64
            } else {
                DataType::Utf8
            }),
            Volatility::Immutable,
            Arc::new(move |_| {
                Ok(Box::new(IntegerAccumulator {
                    sum: BigInt::zero(),
                    count: 0,
                    average,
                }))
            }),
            Arc::new(vec![DataType::Utf8, DataType::UInt64]),
        ));
    }
}
#[derive(Debug)]
struct IntegerAccumulator {
    sum: BigInt,
    count: u64,
    average: bool,
}
impl Accumulator for IntegerAccumulator {
    fn update_batch(&mut self, values: &[ArrayRef]) -> Result<()> {
        let values = values[0].as_any().downcast_ref::<StringArray>().unwrap();
        for value in values.iter().flatten() {
            if let Ok(value) = value.parse::<i64>() {
                self.sum += value;
                self.count += 1;
            }
        }
        Ok(())
    }
    fn evaluate(&mut self) -> Result<ScalarValue> {
        if self.average {
            let value = if self.count == 0 {
                None
            } else {
                let n = BigInt::from(self.count);
                Some(
                    (&self.sum / &n).to_f64().unwrap()
                        + (&self.sum % n).to_f64().unwrap() / self.count as f64,
                )
            };
            Ok(ScalarValue::Float64(value))
        } else {
            Ok(ScalarValue::Utf8((self.count > 0).then(|| {
                self.sum
                    .to_i64()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "!".into())
            })))
        }
    }
    fn state(&mut self) -> Result<Vec<ScalarValue>> {
        Ok(vec![
            ScalarValue::Utf8(Some(self.sum.to_string())),
            ScalarValue::UInt64(Some(self.count)),
        ])
    }
    fn merge_batch(&mut self, states: &[ArrayRef]) -> Result<()> {
        let sums = states[0].as_any().downcast_ref::<StringArray>().unwrap();
        let counts = states[1].as_any().downcast_ref::<UInt64Array>().unwrap();
        for i in 0..sums.len() {
            if !sums.is_null(i) {
                self.sum += sums.value(i).parse::<BigInt>().unwrap();
                self.count += counts.value(i);
            }
        }
        Ok(())
    }
    fn size(&self) -> usize {
        std::mem::size_of::<Self>() + self.sum.bits().div_ceil(8) as usize
    }
}
