import { backoffDelayMs } from "@zimlo/protocol";

// 重连退避：连接断开后立即尝试另一传输通道（存在备用通道时首次延迟为 0），
// 之后按 protocol 的 1/2/4/8/16/30s + ±20% 抖动递增；认证成功或页面回前台重置；
// navigator.onLine === false 时暂停计时，恢复在线后立即重试。

export function reconnectDelayMs(attempt: number, hasAlternateTransport: boolean, random: () => number = Math.random): number {
  if (attempt <= 0 && hasAlternateTransport) return 0;
  return backoffDelayMs(hasAlternateTransport ? attempt - 1 : attempt, random);
}

export interface ReconnectDriver {
  /** 发起一次连接尝试（由调用方决定传输通道轮换） */
  connect: () => void;
  isOnline: () => boolean;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (id: number) => void;
  random: () => number;
  now?: () => number;
}

export interface ReconnectState {
  /** 已经连续失败的次数（下一次尝试的序号） */
  attempt: number;
  /** 是否已安排或正在等待下一次重试 */
  waiting: boolean;
  /** 因离线而暂停 */
  pausedOffline: boolean;
  /** 下一次重试的时间戳（now() 基准）；暂停或无计划时为 null */
  nextRetryAt: number | null;
}

export class ReconnectController {
  private attempt = 0;
  private timer: number | null = null;
  private pausedOffline = false;
  private connected = false;
  private disposed = false;

  constructor(
    private readonly driver: ReconnectDriver,
    private readonly hasAlternateTransport: () => boolean,
    private readonly onStateChange?: (state: ReconnectState) => void,
  ) {}

  private now(): number {
    return this.driver.now?.() ?? Date.now();
  }

  private emit(nextRetryAt: number | null): void {
    this.onStateChange?.({
      attempt: this.attempt,
      waiting: this.timer !== null,
      pausedOffline: this.pausedOffline,
      nextRetryAt,
    });
  }

  private clearTimer(): void {
    if (this.timer !== null) this.driver.clearTimeout(this.timer);
    this.timer = null;
  }

  /** 连接断开（或首次需要连接）时调用，安排下一次尝试。 */
  notifyDisconnected(): void {
    if (this.disposed || this.connected) return;
    this.clearTimer();
    if (!this.driver.isOnline()) {
      this.pausedOffline = true;
      this.emit(null);
      return;
    }
    this.pausedOffline = false;
    const delay = reconnectDelayMs(this.attempt, this.hasAlternateTransport(), this.driver.random);
    this.attempt += 1;
    const retryAt = this.now() + delay;
    this.timer = this.driver.setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.connected) return;
      this.emit(null);
      this.driver.connect();
    }, delay);
    this.emit(retryAt);
  }

  /** 认证成功：重置退避序列。 */
  notifyConnected(): void {
    this.connected = true;
    this.attempt = 0;
    this.pausedOffline = false;
    this.clearTimer();
    this.emit(null);
  }

  /** 连接建立前（socket 打开）也应解除 connected 标记由调用方负责。 */
  notifyConnecting(): void {
    this.connected = false;
  }

  /** 页面回到前台：重置退避并立即重试。 */
  notifyForeground(): void {
    if (this.disposed) return;
    this.attempt = 0;
    if (this.connected) {
      this.emit(null);
      return;
    }
    this.retryNow();
  }

  /** 恢复在线：立即重试。 */
  notifyOnline(): void {
    if (this.disposed || this.connected) return;
    if (!this.pausedOffline && this.timer !== null) return;
    this.pausedOffline = false;
    this.retryNow();
  }

  /** 离线：暂停计时。 */
  notifyOffline(): void {
    if (this.disposed || this.connected) return;
    this.clearTimer();
    this.pausedOffline = true;
    this.emit(null);
  }

  /** 用户点击"立即重试"。 */
  retryNow(): void {
    if (this.disposed || this.connected) return;
    this.clearTimer();
    this.pausedOffline = false;
    this.attempt += 1;
    this.emit(null);
    this.driver.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }
}
