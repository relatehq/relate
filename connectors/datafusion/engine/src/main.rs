use relate_datafusion::{providers::ProviderRegistry, stdio::serve};
#[tokio::main(worker_threads = 2)]
async fn main() {
    serve(ProviderRegistry::default()).await;
}
