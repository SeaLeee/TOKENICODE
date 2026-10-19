use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex, Notify};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    /// Desk-generated process key used as routing key and stdin identifier.
    /// Maps to StdinManager / ProcessManager keys. NOT the Claude CLI session UUID.
    pub stdin_id: String,
    /// Claude CLI's session UUID for --resume. `Some` when resuming an existing
    /// session (from `resume_session_id`), `None` for new sessions — the real
    /// UUID arrives later via the first system:init stream event and is stored
    /// on the frontend in `sessionStore.cliResumeId`.
    pub cli_session_id: Option<String>,
    pub pid: u32,
    pub cli_path: String,
}

/// A managed CLI session whose child process is owned by an independent
/// waiter task. `kill_tx` sends a request to that waiter task to kill the
/// child; the waiter task then emits `process_exit` authoritatively.
#[derive(Debug)]
#[allow(dead_code)]
pub struct ManagedProcess {
    pub session_id: String,
    pub pid: u32,
    /// Kill signal channel to the waiter task. Option so we can take() on remove.
    pub kill_tx: Option<oneshot::Sender<()>>,
    /// Signalled by the stdout reader after emitting process_exit.
    /// kill_session waits on this to avoid SESSION_ALREADY_ACTIVE races.
    pub exit_notify: Arc<Notify>,
}

#[derive(Debug, Default, Clone)]
pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<ManagedProcess>>>>>,
}

/// Manages stdin handles for sending user responses to Claude processes
#[derive(Debug, Default, Clone)]
pub struct StdinManager {
    handles: Arc<Mutex<HashMap<String, ChildStdin>>>,
}

impl StdinManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, stdin: ChildStdin) {
        let mut map = self.handles.lock().await;
        map.insert(id, stdin);
    }

    pub async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let mut map = self.handles.lock().await;
        if let Some(stdin) = map.get_mut(id) {
            // Atomic write: message + newline in one call to prevent interleaving (P1-2 fix)
            let payload = format!("{}\n", message);
            stdin
                .write_all(payload.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to stdin: {}", e))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush stdin: {}", e))?;
            Ok(())
        } else {
            Err(format!("No stdin handle for session: {}", id))
        }
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.handles.lock().await;
        map.remove(id);
    }

    /// Alias for remove — used by drop_entry path for natural process exit.
    pub async fn drop_entry(&self, id: &str) {
        self.remove(id).await;
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, process: ManagedProcess) {
        let mut map = self.processes.lock().await;
        map.insert(id, Arc::new(Mutex::new(process)));
    }

    /// Remove a process and send the kill signal. Returns the exit_notify
    /// so the caller can wait for the stdout reader to confirm process exit.
    pub async fn remove(&self, id: &str) -> Option<Arc<Notify>> {
        let mut map = self.processes.lock().await;
        if let Some(proc) = map.remove(id) {
            let mut managed = proc.lock().await;
            if let Some(tx) = managed.kill_tx.take() {
                if tx.send(()).is_err() {
                    // Receiver dropped — waiter task already exited because
                    // the child died naturally. No-op is correct.
                }
            }
            Some(managed.exit_notify.clone())
        } else {
            None
        }
    }

    /// TK-329: List all active stdinIds so the frontend can detect orphaned processes
    /// after a browser refresh (frontend state is wiped but backend keeps processes alive).
    pub async fn active_ids(&self) -> Vec<String> {
        let map = self.processes.lock().await;
        map.keys().cloned().collect()
    }

    /// Remove a process entry WITHOUT sending a kill signal.
    /// Used for naturally exited processes where the child is already dead.
    /// Prevents active_ids from accumulating stale entries (C2 fix).
    pub async fn drop_entry(&self, id: &str) {
        let mut map = self.processes.lock().await;
        map.remove(id);
    }
}

/// Per-session bypass mode flag, shared between the stdout reader task and
/// the `send_control_request` command. When the user switches permission mode
/// at runtime (e.g. bypass → plan), `send_control_request` updates the flag
/// so the stdout reader's control_request handler uses the current mode.
#[derive(Debug, Default, Clone)]
pub struct BypassModeMap {
    flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl BypassModeMap {
    pub fn new() -> Self {
        Self {
            flags: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a session with its initial bypass mode. Returns a shared flag
    /// for the stdout reader task to read.
    pub async fn register(&self, session_id: &str, is_bypass: bool) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(is_bypass));
        let mut map = self.flags.lock().await;
        map.insert(session_id.to_string(), flag.clone());
        flag
    }

    /// Update bypass mode for a session (called when permission_mode changes at runtime).
    pub async fn set_bypass(&self, session_id: &str, is_bypass: bool) {
        let map = self.flags.lock().await;
        if let Some(flag) = map.get(session_id) {
            flag.store(is_bypass, Ordering::Relaxed);
        }
    }

    /// Remove a session's flag (called on process exit).
    pub async fn remove(&self, session_id: &str) {
        let mut map = self.flags.lock().await;
        map.remove(session_id);
    }

    /// Remove the stored flag only if it still points to the same Arc.
    /// This avoids an old stdout reader dropping a newer session's flag when
    /// the same stdin_id is reused during a fast restart.
    pub async fn drop_if_current(&self, session_id: &str, current: &Arc<AtomicBool>) {
        let mut map = self.flags.lock().await;
        if map
            .get(session_id)
            .is_some_and(|flag| Arc::ptr_eq(flag, current))
        {
            map.remove(session_id);
        }
    }
}

/// Pending control requests (`set_permission_mode`, `set_model`) awaiting the
/// CLI's `control_response`, keyed by request_id.
///
/// The stdout reader resolves each waiter with the CLI's answer. Without this,
/// `send_control_request` could only fire-and-forget: a rejected runtime mode
/// switch (e.g. bypass disabled by settings) would still be reflected in the
/// UI, leaving the frontend and CLI in different permission modes.
#[derive(Debug, Default, Clone)]
pub struct ControlResponseMap {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>>,
}

impl ControlResponseMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a waiter *before* sending the request. Returns the receiver.
    pub async fn register(
        &self,
        request_id: &str,
    ) -> oneshot::Receiver<Result<serde_json::Value, String>> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(request_id.to_string(), tx);
        rx
    }

    /// Resolve a pending request. No-op when the id is unknown (timed out or
    /// already resolved).
    pub async fn resolve(&self, request_id: &str, result: Result<serde_json::Value, String>) {
        if let Some(tx) = self.pending.lock().await.remove(request_id) {
            let _ = tx.send(result);
        }
    }

    /// Drop a waiter after a timeout so the map does not leak.
    pub async fn forget(&self, request_id: &str) {
        self.pending.lock().await.remove(request_id);
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StartSessionParams {
    pub prompt: String,
    /// Image files attached to the first user turn. The backend encodes these
    /// as Claude stream-json image content blocks.
    pub image_paths: Option<Vec<String>>,
    pub cwd: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    /// When set, resume an existing Claude CLI session instead of starting a new one.
    /// The value should be the Claude CLI session ID (UUID).
    pub resume_session_id: Option<String>,
    /// Thinking effort level: "off", "low", "medium", "high", or "max".
    pub thinking_level: Option<String>,
    /// Session mode: "ask", "plan", or "auto" (default).
    pub session_mode: Option<String>,
    /// Active provider ID from providers.json.
    /// When set, the provider's env vars are injected into the CLI process.
    pub provider_id: Option<String>,
    /// Permission mode for CLI. Maps from frontend session modes:
    ///   "acceptEdits" (code mode) | "default" (ask mode) | "plan" | "bypassPermissions" (bypass)
    /// When not "bypassPermissions", enables --permission-prompt-tool stdio for structured
    /// permission requests via the SDK control protocol.
    pub permission_mode: Option<String>,
    /// When true and resume_session_id is set, strip thinking blocks from the session JSONL
    /// before resuming. This prevents "invalid thinking signature" 400 errors when switching
    /// to a different model that can't verify the old model's cryptographic signatures.
    pub model_switch: Option<bool>,
}

#[cfg(test)]
mod control_response_tests {
    use super::ControlResponseMap;

    #[tokio::test]
    async fn resolve_delivers_success_to_the_waiter() {
        let map = ControlResponseMap::new();
        let rx = map.register("req-1").await;
        map.resolve("req-1", Ok(serde_json::json!({ "mode": "bypassPermissions" })))
            .await;
        let got = rx.await.expect("waiter should be resolved").expect("success");
        assert_eq!(got["mode"], "bypassPermissions");
    }

    #[tokio::test]
    async fn resolve_delivers_cli_error_to_the_waiter() {
        let map = ControlResponseMap::new();
        let rx = map.register("req-2").await;
        map.resolve("req-2", Err("bypass disabled".to_string())).await;
        let err = rx.await.expect("waiter should be resolved").unwrap_err();
        assert_eq!(err, "bypass disabled");
    }

    #[tokio::test]
    async fn unknown_request_id_is_a_no_op() {
        let map = ControlResponseMap::new();
        // Must not panic when a stale/foreign control_response arrives.
        map.resolve("missing", Ok(serde_json::Value::Null)).await;
        map.forget("missing").await;
    }

    #[tokio::test]
    async fn forget_drops_the_waiter_after_timeout() {
        let map = ControlResponseMap::new();
        let rx = map.register("req-3").await;
        map.forget("req-3").await;
        // Sender was dropped, so the receiver observes a closed channel.
        assert!(rx.await.is_err());
    }
}
