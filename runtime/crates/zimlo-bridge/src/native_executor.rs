use zimlo_store::{Store, TaskCommandRecord};

use crate::{
    ActionBroker, ClaudeTaskExecutor, CodexTaskExecutor, ResolvedMaterial, TaskExecutionResult,
    TaskExecutor,
};

#[derive(Clone)]
pub struct NativeTaskExecutor {
    claude: ClaudeTaskExecutor,
    codex: CodexTaskExecutor,
}

impl NativeTaskExecutor {
    pub fn new(store: Store, broker: ActionBroker) -> Self {
        Self {
            claude: ClaudeTaskExecutor::new(store.clone()),
            codex: CodexTaskExecutor::new(store, broker),
        }
    }
}

impl TaskExecutor for NativeTaskExecutor {
    fn supports(&self, command: &TaskCommandRecord) -> bool {
        self.claude.supports(command) || self.codex.supports(command)
    }

    async fn execute(
        &self,
        command: TaskCommandRecord,
        materials: Vec<ResolvedMaterial>,
    ) -> TaskExecutionResult {
        match command.provider.as_str() {
            "claude" => self.claude.execute(command, materials).await,
            "codex" => self.codex.execute(command, materials).await,
            _ => TaskExecutionResult {
                ok: false,
                message: "不支持这个任务执行器。".into(),
                session_id: command.session_id,
            },
        }
    }
}
