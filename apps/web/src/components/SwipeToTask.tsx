import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

interface SwipeToTaskProps {
  children: ReactNode;
  sessionId: string | null | undefined;
  onOpen: (sessionId: string) => void;
}

interface GestureStart {
  pointerId: number;
  x: number;
  y: number;
}

const OPEN_THRESHOLD = 72;

export function shouldOpenTaskSwipe(deltaX: number, deltaY: number): boolean {
  return deltaX >= OPEN_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
}

export function SwipeToTask({ children, sessionId, onOpen }: SwipeToTaskProps) {
  const start = useRef<GestureStart | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    start.current = null;
    setDragging(false);
    setOffset(0);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!sessionId || event.button !== 0) return;
    start.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - origin.x;
    const deltaY = event.clientY - origin.y;
    if (!dragging && (Math.abs(deltaX) < 10 || Math.abs(deltaX) <= Math.abs(deltaY))) return;
    if (deltaX < 0) {
      setOffset(0);
      return;
    }
    if (!dragging) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    event.preventDefault();
    setOffset(Math.min(104, deltaX));
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    const shouldOpen = Boolean(sessionId && origin && shouldOpenTaskSwipe(event.clientX - origin.x, event.clientY - origin.y));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    reset();
    if (shouldOpen) onOpen(sessionId!);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!sessionId || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === "ArrowRight") {
      event.preventDefault();
      onOpen(sessionId);
    }
  };

  return (
    <div
      className={`swipe-task ${dragging ? "is-dragging" : ""}`}
      tabIndex={sessionId ? 0 : undefined}
      aria-label={sessionId ? "右滑查看当前任务" : undefined}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={reset}
    >
      <div className="swipe-task-reveal" aria-hidden="true"><span>任务</span><strong>查看时间线</strong></div>
      <div className="swipe-task-content" style={{ transform: `translate3d(${offset}px, 0, 0)` }}>{children}</div>
    </div>
  );
}
