import { AppIcon } from "./AppIcon";

export type CoreActionState = "idle" | "active" | "attention" | "offline" | "composing";

interface CoreActionInputs {
  connected: boolean;
  composerOpen: boolean;
  pendingActionCount: number;
  failedOutboxCount: number;
  pendingOutboxCount: number;
  taskStates: string[];
  commandStates: string[];
}

const ATTENTION_TASK_STATES = new Set(["waiting", "waiting_input", "user_review", "failed"]);
const ACTIVE_TASK_STATES = new Set(["running", "reviewing"]);
const ACTIVE_COMMAND_STATES = new Set(["queued", "dispatching", "running"]);

const ACCESSIBILITY_VALUE: Record<CoreActionState, string> = {
  idle: "可以创建新任务",
  active: "Agent 正在工作",
  attention: "有任务需要处理",
  offline: "当前离线，新任务会先保存在本机",
  composing: "正在编辑新任务",
};

export function coreActionState({ connected, composerOpen, pendingActionCount, failedOutboxCount, pendingOutboxCount, taskStates, commandStates }: CoreActionInputs): CoreActionState {
  if (composerOpen) return "composing";
  if (!connected) return "offline";
  if (
    pendingActionCount > 0
    || failedOutboxCount > 0
    || taskStates.some((state) => ATTENTION_TASK_STATES.has(state))
    || commandStates.includes("failed")
  ) return "attention";
  if (
    pendingOutboxCount > 0
    || taskStates.some((state) => ACTIVE_TASK_STATES.has(state))
    || commandStates.some((state) => ACTIVE_COMMAND_STATES.has(state))
  ) return "active";
  return "idle";
}

export function CoreActionButton({ state, onClick }: { state: CoreActionState; onClick: () => void }) {
  return (
    <button
      className={`new-task-nav core-action is-${state}`}
      type="button"
      aria-label="新任务"
      aria-valuetext={ACCESSIBILITY_VALUE[state]}
      aria-pressed={state === "composing"}
      title={ACCESSIBILITY_VALUE[state]}
      onClick={onClick}
    >
      <span className="core-action-mark" aria-hidden="true">
        <span className="core-action-node"><AppIcon name="plus" /></span>
        <svg className="core-action-arc" viewBox="0 0 60 60">
          <path d="M29 4.5a25.5 25.5 0 0 1 23.6 35.1" />
        </svg>
        <span className="core-action-satellite" />
      </span>
    </button>
  );
}
