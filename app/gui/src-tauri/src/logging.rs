use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock, mpsc};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use log::{LevelFilter, Log, Metadata, Record};
use serde::Serialize;

const MAX_MEMORY_ENTRIES: usize = 2_000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub level: String,
    pub target: String,
    pub message: String,
}

struct Shared {
    entries: RwLock<VecDeque<LogEntry>>,
    log_path: RwLock<Option<PathBuf>>,
    next_sequence: AtomicU64,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            entries: RwLock::new(VecDeque::new()),
            log_path: RwLock::new(None),
            next_sequence: AtomicU64::new(1),
        }
    }
}

#[derive(Clone)]
pub struct LogRuntime {
    shared: Arc<Shared>,
}

impl LogRuntime {
    pub fn snapshot_after(&self, after_sequence: Option<u64>) -> Vec<LogEntry> {
        let after = after_sequence.unwrap_or(0);
        self.shared.entries.read().map(|entries| {
            entries.iter().filter(|entry| entry.sequence > after).cloned().collect()
        }).unwrap_or_default()
    }

    pub fn clear_memory(&self) {
        if let Ok(mut entries) = self.shared.entries.write() {
            entries.clear();
        }
    }
}

struct RuntimeLogger {
    tx: mpsc::Sender<LogEntry>,
    shared: Arc<Shared>,
}

impl Log for RuntimeLogger {
    fn enabled(&self, _metadata: &Metadata<'_>) -> bool { true }

    fn log(&self, record: &Record<'_>) {
        let sequence = self.shared.next_sequence.fetch_add(1, Ordering::Relaxed);
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0);
        let _ = self.tx.send(LogEntry {
            sequence,
            timestamp_ms,
            level: record.level().to_string(),
            target: record.target().to_string(),
            message: record.args().to_string(),
        });
    }

    fn flush(&self) {}
}

struct FileState {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
}

impl FileState {
    fn new(log_dir: &Path) -> Self {
        let _ = fs::create_dir_all(log_dir);
        let path = log_dir.join("toolhub-gui.log");

        if fs::metadata(&path).map(|meta| meta.len() >= MAX_FILE_BYTES).unwrap_or(false) {
            let rotated = log_dir.join("toolhub-gui.previous.log");
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(&path, rotated);
        }

        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        let bytes = file.as_ref().and_then(|file| file.metadata().ok())
            .map(|meta| meta.len()).unwrap_or(0);
        Self { path, file, bytes }
    }

    fn write(&mut self, entry: &LogEntry) {
        let line = format!("{} {:<5} {} {}\n",
            entry.timestamp_ms, entry.level, entry.target, entry.message);

        if self.file.is_some()
            && self.bytes > 0
            && self.bytes.saturating_add(line.len() as u64) > MAX_FILE_BYTES
        {
            self.file.take();
            let rotated = self.path.parent().unwrap_or_else(|| Path::new("."))
                .join("toolhub-gui.previous.log");
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(&self.path, rotated);
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
            self.bytes = 0;
        }

        if let Some(file) = self.file.as_mut()
            && file.write_all(line.as_bytes()).and_then(|_| file.flush()).is_ok()
        {
            self.bytes = self.bytes.saturating_add(line.len() as u64);
        }
    }
}

pub fn install(log_dir: impl AsRef<Path>) -> Result<LogRuntime, String> {
    let shared = Arc::new(Shared::default());
    let (tx, rx) = mpsc::channel::<LogEntry>();
    let worker_shared = Arc::clone(&shared);
    let log_dir = log_dir.as_ref().to_path_buf();

    thread::Builder::new()
        .name("ToolHubGuiLogger".to_string())
        .spawn(move || {
            let mut file = FileState::new(&log_dir);
            if let Ok(mut path) = worker_shared.log_path.write() {
                *path = Some(file.path.clone());
            }
            while let Ok(entry) = rx.recv() {
                file.write(&entry);
                if let Ok(mut entries) = worker_shared.entries.write() {
                    entries.push_back(entry);
                    while entries.len() > MAX_MEMORY_ENTRIES {
                        entries.pop_front();
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;

    log::set_boxed_logger(Box::new(RuntimeLogger {
        tx,
        shared: Arc::clone(&shared),
    })).map_err(|error| error.to_string())?;
    log::set_max_level(LevelFilter::Debug);

    Ok(LogRuntime { shared })
}
