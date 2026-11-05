use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

use crate::{config, modules, AppRuntime};

const PIPE_NAME: &str = r"\\.\pipe\STanJK-CC-toolhub";
const PROTOCOL: &str = "cc-pipe-v1";
const MODULE_ID: &str = "toolhub";
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

struct Connection {
    writer: Mutex<File>,
}

impl Connection {
    fn new(writer: File) -> Self {
        Self {
            writer: Mutex::new(writer),
        }
    }

    fn send_value(&self, value: &Value) -> Result<(), String> {
        let payload =
            serde_json::to_vec(value).map_err(|error| format!("serialize pipe JSON failed: {error}"))?;
        if payload.len() > MAX_FRAME_BYTES {
            return Err(format!(
                "pipe payload too large: {} bytes > {}",
                payload.len(),
                MAX_FRAME_BYTES
            ));
        }

        let length = u32::try_from(payload.len())
            .map_err(|_| "pipe payload length does not fit u32".to_string())?
            .to_le_bytes();

        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "pipe writer lock poisoned".to_string())?;
        writer
            .write_all(&length)
            .and_then(|_| writer.write_all(&payload))
            .and_then(|_| writer.flush())
            .map_err(|error| format!("write pipe frame failed: {error}"))
    }
}

struct HttpResult {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

impl HttpResult {
    fn json<T: serde::Serialize>(status: u16, value: &T) -> Self {
        match serde_json::to_vec(value) {
            Ok(body) => Self {
                status,
                content_type: "application/json",
                body,
            },
            Err(error) => Self::error(500, format!("serialize response failed: {error}")),
        }
    }

    fn error(status: u16, message: impl Into<String>) -> Self {
        Self::json(status, &json!({ "error": message.into() }))
    }
}

pub fn start(runtime: AppRuntime) -> Result<(), String> {
    let first_pipe = create_pipe_instance()
        .map_err(|error| format!("create initial CC pipe instance failed: {error}"))?;

    thread::Builder::new()
        .name("ToolHubCcPipeServer".to_string())
        .spawn(move || server_loop(runtime, Some(first_pipe)))
        .map_err(|error| format!("start CC pipe server failed: {error}"))?;

    Ok(())
}

fn server_loop(runtime: AppRuntime, mut next_pipe: Option<File>) {
    log::info!(
        target: "toolhub::cc",
        "CC Pipe Adapter listening at {PIPE_NAME}"
    );

    loop {
        let pipe = match next_pipe.take() {
            Some(pipe) => Ok(pipe),
            None => create_pipe_instance(),
        };

        match pipe {
            Ok(mut reader) => {
                if let Err(error) = connect_pipe(&reader) {
                    log::warn!(target: "toolhub::cc", "CC pipe connect failed: {error}");
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }

                let writer = match reader.try_clone() {
                    Ok(writer) => writer,
                    Err(error) => {
                        log::warn!(
                            target: "toolhub::cc",
                            "CC pipe handle clone failed: {error}"
                        );
                        disconnect_pipe(&reader);
                        continue;
                    }
                };

                let connection = Arc::new(Connection::new(writer));
                match handshake(&mut reader, &connection) {
                    Ok(()) => {
                        log::info!(target: "toolhub::cc", "CC pipe session bound");
                        if let Err(error) = serve_session(
                            &mut reader,
                            Arc::clone(&connection),
                            runtime.clone(),
                        ) {
                            log::warn!(target: "toolhub::cc", "CC pipe session ended: {error}");
                        }
                    }
                    Err(error) => {
                        log::warn!(target: "toolhub::cc", "CC pipe handshake failed: {error}");
                    }
                }

                disconnect_pipe(&reader);
            }
            Err(error) => {
                log::error!(target: "toolhub::cc", "CreateNamedPipeW failed: {error}");
                thread::sleep(Duration::from_secs(2));
            }
        }
    }
}

fn create_pipe_instance() -> Result<File, String> {
    let wide: Vec<u16> = PIPE_NAME.encode_utf16().chain(std::iter::once(0)).collect();

    let handle = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            std::ptr::null(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }

    Ok(unsafe { File::from_raw_handle(handle as _) })
}

fn connect_pipe(file: &File) -> Result<(), String> {
    let connected = unsafe {
        ConnectNamedPipe(file.as_raw_handle() as _, std::ptr::null_mut())
    };

    if connected != 0 {
        return Ok(());
    }

    let error = unsafe { GetLastError() };
    if error == ERROR_PIPE_CONNECTED {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(error as i32).to_string())
    }
}

fn disconnect_pipe(file: &File) {
    unsafe {
        let _ = DisconnectNamedPipe(file.as_raw_handle() as _);
    }
}

fn handshake(reader: &mut File, connection: &Connection) -> Result<(), String> {
    log::debug!(target: "toolhub::cc", "CC pipe transport connected; sending hello");
    connection.send_value(&json!({
        "type": "hello",
        "protocol": PROTOCOL,
        "module_id": MODULE_ID
    }))?;
    log::debug!(target: "toolhub::cc", "CC pipe hello sent; waiting for hello-ack");

    let ack = read_value(reader)?;
    log::debug!(target: "toolhub::cc", "CC pipe received handshake frame: {ack}");
    let valid = ack.get("type").and_then(Value::as_str) == Some("hello-ack")
        && ack.get("protocol").and_then(Value::as_str) == Some(PROTOCOL);

    if valid {
        log::debug!(target: "toolhub::cc", "CC pipe hello-ack accepted");
        Ok(())
    } else {
        Err(format!("invalid hello-ack: {ack}"))
    }
}

fn serve_session(
    reader: &mut File,
    connection: Arc<Connection>,
    runtime: AppRuntime,
) -> Result<(), String> {
    let mut mailbox_state: Option<Option<String>> = None;
    let mut next_mailbox_check = Instant::now();

    loop {
        let now = Instant::now();
        if now >= next_mailbox_check {
            maybe_send_error_mailbox(&runtime, &connection, &mut mailbox_state)?;
            next_mailbox_check = now + Duration::from_millis(500);
        }

        match pipe_bytes_available(reader)? {
            PipeAvailability::Disconnected => {
                return Err("CC pipe client disconnected".to_string());
            }
            PipeAvailability::Available(0) => {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            PipeAvailability::Available(_) => {}
        }

        let message = read_value(reader)?;
        match message.get("type").and_then(Value::as_str) {
            Some("http.request") => {
                let request_id = message
                    .get("request_id")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let method = message
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>");
                let path = message
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>");
                log::debug!(
                    target: "toolhub::cc",
                    "CC http.request received: request_id={request_id} method={method} path={path}"
                );

                let response = handle_http_message(&runtime, &message);
                let status = response
                    .get("status")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                log::debug!(
                    target: "toolhub::cc",
                    "CC http.response ready: request_id={request_id} status={status}"
                );

                connection.send_value(&response)?;
                log::debug!(
                    target: "toolhub::cc",
                    "CC http.response sent: request_id={request_id}"
                );
            }
            Some("lifecycle.stop") => {
                let request_id = message
                    .get("request_id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "lifecycle.stop missing request_id".to_string())?;

                let result = runtime.tunnel.stop();
                let response = match &result {
                    Ok(_) => json!({
                        "type": "lifecycle.result",
                        "request_id": request_id,
                        "ok": true
                    }),
                    Err(error) => json!({
                        "type": "lifecycle.result",
                        "request_id": request_id,
                        "ok": false,
                        "error": error
                    }),
                };

                connection.send_value(&response)?;

                if result.is_ok() {
                    log::info!(
                        target: "toolhub::cc",
                        "CC requested lifecycle.stop; shutting down ToolHub backend"
                    );
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(100));
                        std::process::exit(0);
                    });
                    return Ok(());
                }
            }
            Some(other) => {
                log::warn!(
                    target: "toolhub::cc",
                    "Ignoring unsupported CC pipe message type: {other}"
                );
            }
            None => {
                log::warn!(
                    target: "toolhub::cc",
                    "Ignoring CC pipe message without type"
                );
            }
        }
    }
}

enum PipeAvailability {
    Available(u32),
    Disconnected,
}

fn pipe_bytes_available(file: &File) -> Result<PipeAvailability, String> {
    let mut available = 0u32;
    let ok = unsafe {
        PeekNamedPipe(
            file.as_raw_handle() as _,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };

    if ok != 0 {
        return Ok(PipeAvailability::Available(available));
    }

    let error = unsafe { GetLastError() };
    if error == ERROR_BROKEN_PIPE || error == ERROR_NO_DATA {
        Ok(PipeAvailability::Disconnected)
    } else {
        Err(format!(
            "PeekNamedPipe failed: {}",
            std::io::Error::from_raw_os_error(error as i32)
        ))
    }
}

fn read_value(reader: &mut File) -> Result<Value, String> {
    let mut length = [0u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(|error| format!("read pipe frame length failed: {error}"))?;
    let length = u32::from_le_bytes(length) as usize;

    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(format!("invalid pipe frame length: {length}"));
    }

    let mut payload = vec![0u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("read pipe frame payload failed: {error}"))?;

    serde_json::from_slice(&payload).map_err(|error| format!("parse pipe JSON failed: {error}"))
}

fn handle_http_message(runtime: &AppRuntime, request: &Value) -> Value {
    let request_id = match request.get("request_id").and_then(Value::as_u64) {
        Some(value) => value,
        None => {
            return json!({
                "type": "http.response",
                "request_id": 0,
                "status": 400,
                "content_type": "application/json",
                "body_b64": BASE64.encode(br#"{"error":"missing request_id"}"#)
            });
        }
    };

    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET");
    let path = request
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("/");
    let query = request
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("");

    let body = request
        .get("body_b64")
        .and_then(Value::as_str)
        .map(|encoded| BASE64.decode(encoded))
        .transpose();

    let result = match body {
        Ok(body) => route_http(runtime, method, path, query, body.unwrap_or_default()),
        Err(error) => HttpResult::error(400, format!("invalid base64 request body: {error}")),
    };

    json!({
        "type": "http.response",
        "request_id": request_id,
        "status": result.status,
        "content_type": result.content_type,
        "body_b64": BASE64.encode(result.body)
    })
}

fn route_http(
    runtime: &AppRuntime,
    method: &str,
    path: &str,
    query: &str,
    body: Vec<u8>,
) -> HttpResult {
    match (method, path) {
        ("GET", "/health") => HttpResult::json(200, &json!({
            "ok": true,
            "module": MODULE_ID,
            "protocol": PROTOCOL
        })),
        ("GET", "/dashboard") => HttpResult::json(200, &crate::dashboard_snapshot_impl(runtime)),
        ("POST", "/tunnel/restart") => match runtime.tunnel.restart() {
            Ok(snapshot) => HttpResult::json(200, &snapshot),
            Err(error) => HttpResult::error(500, error),
        },
        ("GET", "/logs") => {
            let after = query_value(query, "afterSequence").and_then(|value| value.parse::<u64>().ok());
            HttpResult::json(200, &runtime.logs.snapshot_after(after))
        }
        ("POST", "/logs/clear") => {
            runtime.logs.clear_memory();
            HttpResult::json(200, &json!({ "ok": true }))
        }
        ("GET", "/modules") => match config::module_summaries(&runtime.config_path) {
            Ok(modules) => HttpResult::json(200, &modules),
            Err(error) => HttpResult::error(500, error),
        },
        _ => route_module_http(runtime, method, path, &body),
    }
}

fn route_module_http(
    runtime: &AppRuntime,
    method: &str,
    path: &str,
    body: &[u8],
) -> HttpResult {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if parts.len() != 3 || parts[0] != "modules" {
        return HttpResult::error(404, format!("unknown ToolHub API route: {method} {path}"));
    }

    let module_id = parts[1];
    match (method, parts[2]) {
        ("GET", "config") => match config::read_module_config(&runtime.config_path, module_id) {
            Ok(view) => HttpResult::json(200, &view),
            Err(error) => HttpResult::error(500, error),
        },
        ("PUT", "config") => {
            let parsed: Value = match serde_json::from_slice(body) {
                Ok(value) => value,
                Err(error) => return HttpResult::error(400, format!("invalid JSON body: {error}")),
            };
            let Some(content) = parsed.get("content").and_then(Value::as_str) else {
                return HttpResult::error(400, "missing string field: content");
            };

            match config::write_module_config(&runtime.config_path, module_id, content) {
                Ok(view) => {
                    log::info!(
                        target: "toolhub::config",
                        "Saved module config for {module_id} through CC pipe"
                    );
                    HttpResult::json(200, &view)
                }
                Err(error) => HttpResult::error(500, error),
            }
        }
        ("POST", "probe") => match modules::probe(
            &runtime.repo_root,
            &runtime.config_path,
            module_id,
        ) {
            Ok(probe) => HttpResult::json(200, &probe),
            Err(error) => HttpResult::error(500, error),
        },
        _ => HttpResult::error(404, format!("unknown ToolHub API route: {method} {path}")),
    }
}

fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

fn maybe_send_error_mailbox(
    runtime: &AppRuntime,
    connection: &Connection,
    last_sent: &mut Option<Option<String>>,
) -> Result<(), String> {
    let desired = top_level_error(runtime);
    let desired_code = desired.as_ref().map(|(code, _, _)| code.clone());

    if last_sent.as_ref() == Some(&desired_code) {
        return Ok(());
    }

    match desired {
        Some((code, summary, detail)) => connection.send_value(&json!({
            "type": "error.set",
            "error": {
                "code": code,
                "summary": summary,
                "detail": detail
            }
        }))?,
        None => connection.send_value(&json!({
            "type": "error.clear"
        }))?,
    }

    *last_sent = Some(desired_code);
    Ok(())
}

fn top_level_error(runtime: &AppRuntime) -> Option<(String, String, Option<String>)> {
    let snapshot = runtime.tunnel.snapshot();

    if snapshot.phase == "blocked" || snapshot.phase == "error" {
        return Some((
            "tunnel-runtime-error".to_string(),
            "ToolHub tunnel runtime error".to_string(),
            snapshot.last_error,
        ));
    }

    let active = snapshot.phase == "running" || snapshot.phase == "external";
    if active && snapshot.connection == "degraded" {
        return Some((
            "tunnel-disconnected".to_string(),
            "ToolHub tunnel disconnected".to_string(),
            snapshot.last_error,
        ));
    }

    None
}
