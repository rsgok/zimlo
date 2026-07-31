import { useSyncExternalStore } from "react";

// 分钟级共享时钟：所有相对时间显示都由这一个 ticker 驱动，页面回前台立即刷新，
// 避免每张卡片各自 setInterval。

const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let currentNow = Date.now();

function tick(): void {
  currentNow = Date.now();
  for (const listener of listeners) listener();
}

function onVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    intervalId = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onVisibilityChange);
    }
  };
}

function getSnapshot(): number {
  return currentNow;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function relativeTime(value: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}
