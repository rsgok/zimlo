import { useEffect, useRef, useState } from "react";
import { USER_AVATAR_IDS } from "@zimlo/protocol";
import type { UserAvatarId } from "@zimlo/protocol";
import type { PairingInfo } from "../hooks/useBridge";
import { UserAvatar } from "./UserAvatar";
import { useModalFocus } from "./useModalFocus";

function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
}

export function AvatarPickerDialog({ selectedAvatarId, onSelect, onClose }: {
  selectedAvatarId: UserAvatarId;
  onSelect: (avatarId: UserAvatarId) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef);
  useEscapeToClose(onClose);

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <div className="settings-dialog avatar-dialog" role="dialog" aria-modal="true" aria-label="选择头像" ref={dialogRef}>
        <header><h2>头像</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
        <div className="user-avatar-picker" role="group" aria-label="选择用户头像">
          {USER_AVATAR_IDS.map((avatarId, index) => (
            <button
              type="button"
              className={avatarId === selectedAvatarId ? "selected" : ""}
              aria-label={`选择头像 ${index + 1}`}
              aria-pressed={avatarId === selectedAvatarId}
              key={avatarId}
              onClick={() => onSelect(avatarId)}
            ><UserAvatar avatarId={avatarId} alt="" /></button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PairingDialog({ pairing, onRefresh, onClose }: {
  pairing: PairingInfo | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useModalFocus(dialogRef);
  useEscapeToClose(onClose);

  const copyPairingLink = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <div className="settings-dialog pairing-dialog" role="dialog" aria-modal="true" aria-label="连接手机" ref={dialogRef}>
        <header><h2>连接手机</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
        {pairing ? (
          <>
            <img src={pairing.qrDataUrl} alt="Zimlo 手机配对二维码" />
            <p>在 iPhone 的 Zimlo 中扫描 · {new Date(pairing.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前有效</p>
            <div className="settings-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => void copyPairingLink()}>{copyState === "copied" ? "已复制连接码" : copyState === "failed" ? "复制失败" : "复制连接码"}</button>
              <button type="button" className="primary-button" onClick={onRefresh}>刷新二维码</button>
            </div>
          </>
        ) : (
          <div className="pairing-dialog-loading" role="status">
            <span aria-hidden="true" />
            <strong>正在生成安全连接码…</strong>
            <button type="button" className="secondary-button" onClick={onRefresh}>重试</button>
          </div>
        )}
      </div>
    </div>
  );
}
