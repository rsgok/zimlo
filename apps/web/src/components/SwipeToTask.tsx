import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

interface SwipeToTaskProps {
  children: ReactNode;
  sessionId: string | null | undefined;
  onOpen: (sessionId: string) => void;
  onDismiss: () => void;
}

interface GestureStart {
  pointerId: number;
  x: number;
  y: number;
}

const SWIPE_THRESHOLD = 82;

export function shouldOpenTaskSwipe(deltaX: number, deltaY: number): boolean {
  return deltaX <= -SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
}

export function shouldDismissFeedSwipe(deltaX: number, deltaY: number): boolean {
  return deltaX >= SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
}

export function SwipeToTask({ children, sessionId, onOpen, onDismiss }: SwipeToTaskProps) {
  const start = useRef<GestureStart | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    start.current = null;
    setDragging(false);
    setOffset(0);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    start.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - origin.x;
    const deltaY = event.clientY - origin.y;
    if (!dragging && (Math.abs(deltaX) < 10 || Math.abs(deltaX) <= Math.abs(deltaY))) return;
    if (deltaX < 0 && !sessionId) return setOffset(0);
    if (!dragging) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    event.preventDefault();
    setOffset(Math.max(-116, Math.min(116, deltaX)));
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    const deltaX = origin ? event.clientX - origin.x : 0;
    const deltaY = origin ? event.clientY - origin.y : 0;
    const shouldOpen = Boolean(sessionId && origin && shouldOpenTaskSwipe(deltaX, deltaY));
    const shouldDismiss = Boolean(origin && shouldDismissFeedSwipe(deltaX, deltaY));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    reset();
    if (shouldOpen) onOpen(sessionId!);
    else if (shouldDismiss) onDismiss();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (sessionId && (event.key === "Enter" || event.key === "ArrowLeft")) {
      event.preventDefault();
      onOpen(sessionId);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDismiss();
    }
  };

  return (
    <div
      className={`swipe-task ${dragging ? "is-dragging" : ""}`}
      tabIndex={0}
      aria-label={sessionId ? "左滑查看当前任务，右滑移出 Feed" : "右滑移出 Feed"}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={reset}
    >
      <div className="swipe-task-reveal swipe-task-reveal-dismiss" aria-hidden="true"><strong>移出 Feed</strong></div>
      <div className="swipe-task-reveal swipe-task-reveal-profile" aria-hidden="true"><strong>查看任务</strong></div>
      <div className="swipe-task-content" style={{ transform: `translate3d(${offset}px, 0, 0)` }}>{children}</div>
    </div>
  );
}
