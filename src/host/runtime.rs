use std::future::pending;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{AbortHandle, JoinError, JoinHandle, JoinSet};
use tokio::time::Instant;

use super::dispatch;
use super::native_messaging;
use super::socket::LocalSocket;
use super::{LocalRequest, SocketReply};
use crate::config::BridgeConfig;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CLOSED_ERROR: &str = "The Chrome connection to Holvi Agent Bridge closed.";
const TIMEOUT_ERROR: &str =
    "Holvi Agent Bridge timed out. Inspect the transaction before retrying an upload.";

struct ActiveRequest {
    id: String,
    reply: SocketReply,
    deadline: Instant,
    task: AbortHandle,
}

#[derive(Default)]
struct RuntimeState {
    tab_ready: bool,
    active: Option<ActiveRequest>,
}

impl RuntimeState {
    fn start(&mut self, incoming: LocalRequest, task: AbortHandle, now: Instant) {
        self.active = Some(ActiveRequest {
            id: incoming.request.id,
            reply: incoming.reply,
            deadline: now + REQUEST_TIMEOUT,
            task,
        });
    }

    fn deadline(&self) -> Option<Instant> {
        self.active.as_ref().map(|active| active.deadline)
    }

    fn deadline_expired(&self, now: Instant) -> bool {
        self.deadline().is_some_and(|deadline| now >= deadline)
    }

    fn native_message(&mut self, message: Value) {
        match message.get("type").and_then(Value::as_str) {
            Some("tab_ready") => self.tab_ready = true,
            Some("tab_unavailable") => self.tab_ready = false,
            Some("result") => {
                let Some(id) = message.get("id").and_then(Value::as_str) else {
                    return;
                };
                if self.active.as_ref().is_none_or(|active| active.id != id) {
                    return;
                }
                let response = if message.get("ok") == Some(&Value::Bool(true)) {
                    json!({"ok": true, "data": message.get("data").cloned().unwrap_or(Value::Null)})
                } else {
                    let error = message
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Holvi Agent Bridge request failed.");
                    json!({"ok": false, "error": error})
                };
                self.finish(response);
            }
            _ => {}
        }
    }

    fn action_finished(&mut self, id: &str, result: Result<()>) {
        if let Err(error) = result {
            if self.active.as_ref().is_some_and(|active| active.id == id) {
                self.finish(json!({"ok": false, "error": error.to_string()}));
            }
        }
    }

    fn finish(&mut self, response: Value) {
        if let Some(active) = self.active.take() {
            active.task.abort();
            let _ = active.reply.send(response);
        }
    }
}

struct ActionOutcome {
    id: String,
    result: Result<()>,
}

enum LoopExit {
    Signal,
    NativeInput(Result<()>),
    NativeOutput(Result<()>),
    SocketAcceptor(Result<()>),
    Failure(anyhow::Error),
}

struct HostRuntime {
    config: BridgeConfig,
    native: mpsc::Sender<Value>,
    native_input: mpsc::Receiver<Value>,
    local_input: mpsc::Receiver<LocalRequest>,
    actions: JoinSet<ActionOutcome>,
    state: RuntimeState,
}

pub async fn run(config: BridgeConfig, socket: LocalSocket) -> Result<()> {
    let (native, native_output) = mpsc::channel::<Value>(8);
    let (native_input, native_messages) = mpsc::channel::<Value>(8);
    let (local, local_input) = mpsc::channel::<LocalRequest>(8);
    let (socket_shutdown, socket_shutdown_rx) = oneshot::channel();
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;

    let mut writer = tokio::spawn(native_messaging::writer(native_output));
    let mut reader = tokio::spawn(native_messaging::reader(native_input));
    let mut acceptor =
        tokio::spawn(socket.accept(config.hmac_secret.clone(), local, socket_shutdown_rx));

    native
        .send(json!({"type": "host_ready", "config": config.public()}))
        .await
        .context("Chrome native output closed.")?;

    let mut runtime = HostRuntime {
        config,
        native,
        native_input: native_messages,
        local_input,
        actions: JoinSet::new(),
        state: RuntimeState::default(),
    };

    let exit = runtime
        .event_loop(
            &mut reader,
            &mut writer,
            &mut acceptor,
            &mut sigterm,
            &mut sigint,
        )
        .await;
    runtime
        .state
        .finish(json!({"ok": false, "error": CLOSED_ERROR}));
    while let Ok(incoming) = runtime.local_input.try_recv() {
        let _ = incoming
            .reply
            .send(json!({"ok": false, "error": CLOSED_ERROR}));
    }
    let _ = socket_shutdown.send(());

    let mut cleanup_failure = None;
    runtime.actions.abort_all();
    while let Some(result) = runtime.actions.join_next().await {
        if let Err(error) = result {
            if !error.is_cancelled() && cleanup_failure.is_none() {
                cleanup_failure =
                    Some(anyhow!(error).context("Action dispatch task failed during shutdown."));
            }
        }
    }

    let input_exited = matches!(exit, LoopExit::NativeInput(_));
    let output_exited = matches!(exit, LoopExit::NativeOutput(_));
    let acceptor_exited = matches!(exit, LoopExit::SocketAcceptor(_));
    if !input_exited {
        reader.abort();
        if let Err(error) = await_cancelled(reader, "Native input task").await {
            cleanup_failure.get_or_insert(error);
        }
    }
    if !acceptor_exited {
        if let Err(error) = task_result(acceptor.await, "Local socket acceptor task") {
            cleanup_failure.get_or_insert(error);
        }
    }

    drop(runtime);
    if !output_exited {
        if let Err(error) = task_result(writer.await, "Native output task") {
            cleanup_failure.get_or_insert(error);
        }
    }

    let result = match exit {
        LoopExit::Signal => Ok(()),
        LoopExit::NativeInput(result) => result,
        LoopExit::NativeOutput(result) => {
            result?;
            Err(anyhow!("Native output task exited unexpectedly."))
        }
        LoopExit::SocketAcceptor(result) => {
            result?;
            Err(anyhow!("Local socket acceptor task exited unexpectedly."))
        }
        LoopExit::Failure(error) => Err(error),
    };
    match (result, cleanup_failure) {
        (Err(error), _) => Err(error),
        (Ok(()), Some(error)) => Err(error),
        (Ok(()), None) => Ok(()),
    }
}

impl HostRuntime {
    async fn event_loop(
        &mut self,
        reader: &mut JoinHandle<Result<()>>,
        writer: &mut JoinHandle<Result<()>>,
        acceptor: &mut JoinHandle<Result<()>>,
        sigterm: &mut tokio::signal::unix::Signal,
        sigint: &mut tokio::signal::unix::Signal,
    ) -> LoopExit {
        loop {
            tokio::select! {
                message = self.native_input.recv() => {
                    let Some(message) = message else {
                        return LoopExit::NativeInput(task_result(reader.await, "Native input task"));
                    };
                    self.state.native_message(message);
                }
                incoming = self.local_input.recv() => {
                    let Some(incoming) = incoming else {
                        return LoopExit::SocketAcceptor(task_result(
                            acceptor.await,
                            "Local socket acceptor task",
                        ));
                    };
                    self.handle_local(incoming);
                }
                completed = self.actions.join_next(), if !self.actions.is_empty() => {
                    match completed {
                        Some(Ok(outcome)) => self.state.action_finished(&outcome.id, outcome.result),
                        Some(Err(error)) if error.is_cancelled() => {}
                        Some(Err(error)) => {
                            return LoopExit::Failure(
                                anyhow!(error).context("Action dispatch task failed."),
                            );
                        }
                        None => {}
                    }
                }
                _ = wait_for_deadline(self.state.deadline()) => {
                    if self.state.deadline_expired(Instant::now()) {
                        self.state.finish(json!({"ok": false, "error": TIMEOUT_ERROR}));
                    }
                }
                result = &mut *reader => {
                    return LoopExit::NativeInput(task_result(result, "Native input task"));
                }
                result = &mut *writer => {
                    return LoopExit::NativeOutput(task_result(result, "Native output task"));
                }
                result = &mut *acceptor => {
                    return LoopExit::SocketAcceptor(task_result(
                        result,
                        "Local socket acceptor task",
                    ));
                }
                _ = sigterm.recv() => return LoopExit::Signal,
                _ = sigint.recv() => return LoopExit::Signal,
            }
        }
    }

    fn handle_local(&mut self, incoming: LocalRequest) {
        if let Err(error) = dispatch::validate(
            &incoming.request,
            &self.config,
            self.state.tab_ready,
            self.state.active.is_some(),
        ) {
            let _ = incoming
                .reply
                .send(json!({"ok": false, "error": error.to_string()}));
            return;
        }

        let request = incoming.request.clone();
        let id = request.id.clone();
        let config = self.config.clone();
        let native = self.native.clone();
        let task = self.actions.spawn(async move {
            let result = dispatch::send(request, config, native).await;
            ActionOutcome { id, result }
        });
        self.state.start(incoming, task, Instant::now());
    }
}

async fn wait_for_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending::<()>().await,
    }
}

fn task_result(result: std::result::Result<Result<()>, JoinError>, name: &str) -> Result<()> {
    result
        .with_context(|| format!("{name} failed."))?
        .with_context(|| format!("{name} exited with an error."))
}

async fn await_cancelled(task: JoinHandle<Result<()>>, name: &str) -> Result<()> {
    match task.await {
        Err(error) if error.is_cancelled() => Ok(()),
        result => task_result(result, name),
    }
}

#[cfg(test)]
mod tests {
    use tokio::task::JoinSet;

    use crate::protocol::{Action, EmptyParams};

    use super::*;

    #[tokio::test]
    async fn native_results_finish_only_the_matching_request() {
        let (mut state, response) = active_state();
        state.native_message(json!({"type": "result", "id": "other", "ok": true}));
        assert!(state.active.is_some());

        state.native_message(json!({
            "type": "result",
            "id": "request-id",
            "ok": true,
            "data": {"status": "ready"},
        }));
        assert_eq!(
            response.await.unwrap(),
            json!({"ok": true, "data": {"status": "ready"}})
        );
        assert!(state.active.is_none());
    }

    #[tokio::test]
    async fn action_failure_finishes_the_active_request() {
        let (mut state, response) = active_state();
        state.action_finished("request-id", Err(anyhow!("receipt disappeared")));

        assert_eq!(
            response.await.unwrap(),
            json!({"ok": false, "error": "receipt disappeared"})
        );
        assert!(state.active.is_none());
    }

    #[tokio::test]
    async fn shutdown_finishes_the_active_request() {
        let (mut state, response) = active_state();
        state.finish(json!({"ok": false, "error": CLOSED_ERROR}));

        assert_eq!(
            response.await.unwrap(),
            json!({"ok": false, "error": CLOSED_ERROR})
        );
    }

    #[tokio::test]
    async fn deadline_tracks_the_active_request() {
        let (reply, _) = oneshot::channel();
        let mut tasks = JoinSet::new();
        let task = tasks.spawn(pending::<()>());
        let now = Instant::now();
        let mut state = RuntimeState::default();
        state.start(test_local(reply), task, now);

        assert!(!state.deadline_expired(now + REQUEST_TIMEOUT - Duration::from_millis(1)));
        assert!(state.deadline_expired(now + REQUEST_TIMEOUT));
    }

    #[tokio::test]
    async fn supervised_task_errors_keep_the_task_role() {
        let task = tokio::spawn(async { Err(anyhow!("broken frame")) });
        let error = task_result(task.await, "Native input task").unwrap_err();

        assert_eq!(error.to_string(), "Native input task exited with an error.");
        assert_eq!(error.root_cause().to_string(), "broken frame");
    }

    #[tokio::test]
    async fn shutdown_accepts_supervisor_cancellation() {
        let task = tokio::spawn(pending::<Result<()>>());
        task.abort();

        assert!(await_cancelled(task, "Native input task").await.is_ok());
    }

    fn active_state() -> (RuntimeState, oneshot::Receiver<Value>) {
        let (reply, response) = oneshot::channel();
        let mut tasks = JoinSet::new();
        let task = tasks.spawn(pending::<()>());
        let mut state = RuntimeState::default();
        state.start(test_local(reply), task, Instant::now());
        (state, response)
    }

    fn test_local(reply: SocketReply) -> LocalRequest {
        LocalRequest {
            request: crate::protocol::BridgeRequest {
                version: 1,
                id: "request-id".into(),
                issued_at: 0,
                nonce: "a".repeat(32),
                action: Action::Doctor(EmptyParams {}),
            },
            reply,
        }
    }
}
