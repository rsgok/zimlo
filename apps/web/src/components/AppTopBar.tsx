import { ZimloAvatar } from "./UserAvatar";
import type { ReactNode } from "react";

interface AppTopBarProps {
  title: string;
  connected?: boolean;
  online?: boolean;
  connectionMode?: "offline" | "local" | "cloud";
  detail?: boolean;
  onBack?: () => void;
  action?: ReactNode;
}

export function AppTopBar({ title, connected = false, online = true, connectionMode = "offline", detail = false, onBack, action }: AppTopBarProps) {
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
              {!online ? "离线" : connected ? (connectionMode === "cloud" ? "云端" : "本地") : "重连"}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
