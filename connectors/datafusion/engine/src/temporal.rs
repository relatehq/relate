//! Format in the source's time unit. DataFusion's generic to_char coerces to
//! nanoseconds, whose range cannot cover Relate's year 0000..9999 contract.
use crate::functions::scalar;
use datafusion::{
    arrow::{
        datatypes::{DataType, TimeUnit},
        temporal_conversions::{
            date32_to_datetime, timestamp_ms_to_datetime, timestamp_us_to_datetime,
        },
    },
    common::ScalarValue,
    prelude::SessionContext,
};

pub fn register(ctx: &SessionContext) {
    scalar(
        ctx,
        "relate_date",
        vec![DataType::Date32],
        DataType::Utf8,
        |values| {
            let text = match values[0] {
                ScalarValue::Date32(Some(days)) => Some(
                    date32_to_datetime(days)
                        .map(|date| date.format("%Y-%m-%d").to_string())
                        .unwrap_or_else(|| "invalid-date".into()),
                ),
                _ => None,
            };
            ScalarValue::Utf8(text)
        },
    );
    for millis in [true, false] {
        scalar(
            ctx,
            if millis {
                "relate_timestamp_ms"
            } else {
                "relate_timestamp_us"
            },
            vec![DataType::Timestamp(
                if millis {
                    TimeUnit::Millisecond
                } else {
                    TimeUnit::Microsecond
                },
                None,
            )],
            DataType::Utf8,
            move |values| {
                let text = match &values[0] {
                    ScalarValue::TimestampMillisecond(Some(ticks), _) => Some(
                        timestamp_ms_to_datetime(*ticks)
                            .map(|date| date.format("%Y-%m-%dT%H:%M:%S.%3fZ").to_string())
                            .unwrap_or_else(|| "invalid-timestamp".into()),
                    ),
                    ScalarValue::TimestampMicrosecond(Some(ticks), _) => Some(
                        timestamp_us_to_datetime(*ticks)
                            .map(|date| date.format("%Y-%m-%dT%H:%M:%S.%6fZ").to_string())
                            .unwrap_or_else(|| "invalid-timestamp".into()),
                    ),
                    _ => None,
                };
                ScalarValue::Utf8(text)
            },
        );
    }
}
