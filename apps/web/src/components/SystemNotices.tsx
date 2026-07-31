import { relativeTime, useNow } from "../lib/nowTicker";

interface SystemNoticesProps {
  online: boolean;
  pendingCount: number;
  error: string | null;
  /** 断线时展示的本地快照时间（"数据更新于 X 分钟前"） */
  connected?: boolean;
  snapshotSavedAt?: string | null | undefined;
  onDismissError?: (() => void) | undefined;
  /** 点击同步提示打开指令队列面板 */
  onShowOutbox?: (() => void) | undefined;
}

export function pendingOperationNotice(online: boolean, pendingCount: number): string | null {
  if (!online) {
    return pendingCount > 0
      ? `${pendingCount} 个操作已保存在本机，联网后自动发送`
      : "当前离线，新操作会保存在本机";
  }
  return pendingCount > 0 ? `正在发送 ${pendingCount} 个操作…` : null;
}

export function SystemNotices({ online, pendingCount, error, connected = true, snapshotSavedAt = null, onDismissError, onShowOutbox }: SystemNoticesProps) {
  const now = useNow();
  const pendingNotice = pendingOperationNotice(online, pendingCount);
  const staleNotice = !connected && snapshotSavedAt ? `数据更新于 ${relativeTime(snapshotSavedAt, now)}` : null;
  if (!pendingNotice && !error && !staleNotice) return null;

  return (
    <div className="system-notice-stack" aria-live="polite">
      {pendingNotice && (
        <div className="system-notice system-notice-sync" role="status">
          <span className="system-notice-dot" aria-hidden="true" />
          {onShowOutbox ? (
            <button type="button" className="system-notice-button" onClick={onShowOutbox}>{pendingNotice}</button>
          ) : <span>{pendingNotice}</span>}
        </div>
      )}
      {staleNotice && (
        <div className="system-notice system-notice-stale" role="status">
          <span className="system-notice-dot" aria-hidden="true" />
          <span>{staleNotice}</span>
        </div>
      )}
      {error && (
        <div className="system-notice system-notice-error" role="alert">
          <span className="system-notice-dot" aria-hidden="true" />
          <span>{error}</span>
          {onDismissError && (
            <button type="button" className="system-notice-close" aria-label="关闭这条错误" onClick={onDismissError}>×</button>
          )}
        </div>
      )}
    </div>
  );
}
