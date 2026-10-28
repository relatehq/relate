//! Reusable one-request protocol for binaries registering host-owned providers.
use crate::{open, providers::ProviderRegistry, run, Request};
use serde_json::json;
use std::io::Write;
use tokio::io::{AsyncBufReadExt, BufReader};

pub async fn serve(registry: ProviderRegistry) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let input = match lines.next_line().await {
        Ok(Some(input)) => input,
        _ => return,
    };
    let execute = async {
        let request: Request = serde_json::from_str(&input)?;
        let ctx = open(&request.source, &registry).await?;
        println!("{}", json!({"kind":"ready"}));
        std::io::stdout().flush()?;
        run(&ctx, &request).await
    };
    // Node holds stdin open until process exit. A crashed parent closes the pipe;
    // exit immediately so detached native tasks cannot outlive their owner.
    let result = tokio::select! {
        result = execute => result,
        _ = lines.next_line() => std::process::exit(0),
    };
    let response = match result {
        Ok(value) => json!({"kind":"result", "value":value}),
        Err(error) => json!({"kind":"failure", "detail":error.to_string()}),
    };
    println!("{response}");
    // The parent closes stdin after receiving this response. That releases
    // Tokio's blocking stdin reader and lets normal runtime teardown join it.
    let _ = std::io::stdout().flush();
}
