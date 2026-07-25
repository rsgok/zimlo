interface SystemNoticesProps {
  online: boolean;
  pendingCount: number;
  error: string | null;
}

export function pendingOperationNotice(online: boolean, pendingCount: number): string | null {
  if (!online) {
    return pendingCount > 0
      ? `${pendingCount} 个操作已保存在本机，联网后自动发送`
      : "当前离线，新操作会保存在本机";
  }
  return pendingCount > 0 ? `正在发送 ${pendingCount} 个操作…` : null;
}

export function SystemNotices({ online, pendingCount, error }: SystemNoticesProps) {
  const pendingNotice = pendingOperationNotice(online, pendingCount);
  if (!pendingNotice && !error) return null;

  return (
    <div className="system-notice-stack" aria-live="polite">
      {pendingNotice && (
        <div className="system-notice system-notice-sync" role="status">
          <span className="system-notice-dot" aria-hidden="true" />
          <span>{pendingNotice}</span>
        </div>
      )}
      {error && (
        <div className="system-notice system-notice-error" role="alert">
          <span className="system-notice-dot" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
