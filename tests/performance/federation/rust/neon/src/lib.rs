use neon::prelude::*;
use relate_federation_spike::{dispatch, runtime, Engine};
use std::sync::Arc;
struct Handle(Arc<Engine>);
impl Finalize for Handle {}
fn open(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let config = cx.argument::<JsString>(0)?.value(&mut cx);
    Ok(cx
        .task(move || {
            let config = serde_json::from_str(&config).map_err(|e| e.to_string())?;
            runtime()
                .block_on(Engine::open(config))
                .map(Arc::new)
                .map_err(|e| e.to_string())
        })
        .promise(|mut cx, result| match result {
            Ok(engine) => Ok(cx.boxed(Handle(engine))),
            Err(error) => cx.throw_error(error),
        }))
}
fn query(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let engine = cx.argument::<JsBox<Handle>>(0)?.0.clone();
    let input = cx.argument::<JsString>(1)?.value(&mut cx);
    Ok(cx
        .task(move || {
            runtime()
                .block_on(dispatch(&engine, &input))
                .map(|v| v.to_string())
                .map_err(|e| e.to_string())
        })
        .promise(|mut cx, result| match result {
            Ok(result) => Ok(cx.string(result)),
            Err(error) => cx.throw_error(error),
        }))
}
#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("open", open)?;
    cx.export_function("query", query)?;
    Ok(())
}
