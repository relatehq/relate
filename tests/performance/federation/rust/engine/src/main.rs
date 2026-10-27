use axum::{
    extract::{DefaultBodyLimit, State},
    routing::post,
    Json, Router,
};
use relate_federation_spike::{dispatch, runtime, Config, Engine};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn reply(engine: &Engine, input: &str) -> Value {
    match dispatch(engine, input).await {
        Ok(result) => json!({"ok": true, "result": result}),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}
async fn http(State(engine): State<Arc<Engine>>, body: String) -> Json<Value> {
    Json(reply(&engine, &body).await)
}
fn main() -> anyhow::Result<()> {
    runtime().block_on(async {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        let config: Config = serde_json::from_str(
            &lines
                .next_line()
                .await?
                .ok_or_else(|| anyhow::anyhow!("missing config"))?,
        )?;
        let engine = Arc::new(Engine::open(config).await?);
        if std::env::args().any(|arg| arg == "--http") {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            println!(
                "{}",
                json!({"ready":true, "port":listener.local_addr()?.port()})
            );
            let app = Router::new()
                .route("/query", post(http))
                .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
                .with_state(engine);
            axum::serve(listener, app).await?;
        } else {
            println!("{}", json!({"ready":true}));
            // Persistent sequential worker. Multiple requests are safely queued at Node.
            while let Some(line) = lines.next_line().await? {
                let result = reply(&engine, &line).await;
                let mut out = tokio::io::stdout();
                out.write_all(format!("{result}\n").as_bytes()).await?;
                out.flush().await?;
            }
        }
        Ok(())
    })
}
