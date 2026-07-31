import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex=\"-1\"])";

// 模态焦点管理：打开时聚焦首控件（或 [data-autofocus]），Tab 在内部循环，
// 关闭后恢复之前的焦点。
export function useModalFocus(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((element) => element.getClientRects().length > 0);
    const initial = node.querySelector<HTMLElement>("[data-autofocus]")
      ?? (node.contains(document.activeElement) ? null : focusables()[0]);
    initial?.focus();

    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!node.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previouslyFocused?.focus();
    };
  }, [ref, active]);
}

// 点击 <details> 外部时自动收起（搜索面板等）。
export function useOutsideClickClose(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      const node = ref.current;
      if (!node?.open) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      node.open = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [ref]);
}
