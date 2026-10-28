//! Host-selected providers are independent of Relate's public query model.
use anyhow::{bail, Result};
use async_trait::async_trait;
use datafusion::{
    catalog::TableProvider,
    prelude::{ParquetReadOptions, SessionContext},
};
use object_store::aws::AmazonS3Builder;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use url::Url;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Source {
    Parquet { url: String, s3: Option<S3> },
    Custom { provider: String, options: Value },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct S3 {
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    #[serde(default)]
    pub allow_http: bool,
}

/// Implement in a host-owned Rust binary; no changes to Relate runtime required.
#[async_trait]
pub trait ProviderFactory: Send + Sync {
    async fn open(
        &self,
        context: &SessionContext,
        options: &Value,
    ) -> Result<Arc<dyn TableProvider>>;
}
#[derive(Default)]
pub struct ProviderRegistry {
    factories: HashMap<String, Arc<dyn ProviderFactory>>,
}
impl ProviderRegistry {
    pub fn register(
        &mut self,
        name: impl Into<String>,
        factory: Arc<dyn ProviderFactory>,
    ) -> Result<()> {
        let name = name.into();
        if name.is_empty() || self.factories.contains_key(&name) {
            bail!("duplicate or empty provider name");
        }
        self.factories.insert(name, factory);
        Ok(())
    }
    pub async fn open(
        &self,
        context: &SessionContext,
        source: &Source,
    ) -> Result<Arc<dyn TableProvider>> {
        match source {
            Source::Custom { provider, options } => {
                self.factories
                    .get(provider)
                    .ok_or_else(|| anyhow::anyhow!("unknown custom provider"))?
                    .open(context, options)
                    .await
            }
            Source::Parquet { url, s3 } => {
                if let Some(s3) = s3 {
                    let location = Url::parse(url)?;
                    if location.scheme() != "s3" || location.host_str() != Some(&s3.bucket) {
                        bail!("S3 location does not match configured bucket");
                    }
                    let mut builder = AmazonS3Builder::new()
                        .with_bucket_name(&s3.bucket)
                        .with_region(&s3.region)
                        .with_access_key_id(&s3.access_key_id)
                        .with_secret_access_key(&s3.secret_access_key)
                        .with_allow_http(s3.allow_http);
                    if let Some(endpoint) = &s3.endpoint {
                        builder = builder.with_endpoint(endpoint);
                    }
                    if let Some(token) = &s3.session_token {
                        builder = builder.with_token(token);
                    }
                    context.register_object_store(
                        &Url::parse(&format!("s3://{}", s3.bucket))?,
                        Arc::new(builder.build()?),
                    );
                } else if url.contains("://") && !url.starts_with("file://") {
                    bail!("remote Parquet requires explicit S3 configuration");
                }
                Ok(context
                    .read_parquet(url, ParquetReadOptions::default())
                    .await?
                    .into_view())
            }
        }
    }
}
