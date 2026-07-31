import { useEffect } from "react";

export interface UndoToastData {
  id: number;
  label: string;
  undo: () => void;
}

interface UndoToastProps {
  toast: UndoToastData | null;
  onClose: (id: number) => void;
}

export const UNDO_TOAST_MS = 6_000;

// 6 秒撤销窗口：超时自动关闭；撤销或关闭都由调用方清理状态。
export function UndoToast({ toast, onClose }: UndoToastProps) {
  const id = toast?.id;
  useEffect(() => {
    if (id === undefined) return;
    const timer = window.setTimeout(() => onClose(id), UNDO_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [id, onClose]);

  if (!toast) return null;
  return (
    <div className="undo-toast" role="status">
      <span>{toast.label}</span>
      <button type="button" onClick={() => { toast.undo(); onClose(toast.id); }}>撤销</button>
      <button type="button" className="undo-toast-close" aria-label="关闭" onClick={() => onClose(toast.id)}>×</button>
    </div>
  );
}
