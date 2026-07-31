import { useEffect, useRef } from "react";
import { useModalFocus } from "./useModalFocus";

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// 危险操作的二次确认：说明影响范围，Escape / 点击遮罩取消，焦点限制在对话框内。
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = "取消", danger = true, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onCancel();
    }}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title} ref={dialogRef}>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="confirm-actions">
          <button type="button" className="secondary-button" onClick={onCancel} data-autofocus>{cancelLabel}</button>
          <button type="button" className={danger ? "danger-button" : "primary-button"} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
