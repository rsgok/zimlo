import { ZimloAvatar } from "./UserAvatar";
import type { ReactNode } from "react";

interface AppTopBarProps {
  title: string;
  connected?: boolean;
  online?: boolean;
  connectionMode?: "offline" | "local" | "cloud" | "multi";
  detail?: boolean;
  onBack?: () => void;
  action?: ReactNode;
  /** 已连续重连失败次数（>0 时展示），配合 onRetryReconnect 提供"立即重试" */
  reconnectAttempt?: number;
  reconnectPausedOffline?: boolean;
  onRetryReconnect?: (() => void) | undefined;
}

export function AppTopBar({ title, connected = false, online = true, connectionMode = "offline", detail = false, onBack, action, reconnectAttempt = 0, reconnectPausedOffline = false, onRetryReconnect }: AppTopBarProps) {
  const reconnecting = online && !connected;
  return (
    <header className={`app-top-bar${detail ? " is-detail" : ""}`}>
      <div className="app-top-bar-row">
        <div className="app-top-bar-side app-top-bar-left">
          {detail
            ? <button className="app-top-bar-back" onClick={onBack} aria-label="返回">←</button>
            : <ZimloAvatar className="app-top-bar-mark" />}
        </div>
        <strong className="app-top-bar-title">{title}</strong>
        <div className="app-top-bar-side app-top-bar-right">
          {action ?? (
            <span className={`app-top-bar-status ${connected && online ? "is-connected" : ""}`}>
              <i aria-hidden="true" />
              {!online
                ? (reconnectPausedOffline ? "离线 · 已暂停重连" : "离线")
                : connected
                  ? (connectionMode === "multi" ? "多设备" : connectionMode === "cloud" ? "云端" : "本地")
                  : null}
              {reconnecting && (
                <>
                  {reconnectAttempt > 0 ? `重连中 · 第 ${reconnectAttempt} 次` : "重连中"}
                  {onRetryReconnect && (
                    <button type="button" className="app-top-bar-retry" onClick={onRetryReconnect}>立即重试</button>
                  )}
                </>
              )}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
