import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "@zimlo/protocol";
import backoffVector from "../../../../packages/protocol/test-vectors/backoff.json";
import { ReconnectController, reconnectDelayMs, type ReconnectDriver, type ReconnectState } from "./reconnect";

describe("reconnectDelayMs", () => {
  it("matches the protocol backoff vectors when there is no alternate transport", () => {
    for (const testCase of backoffVector.cases) {
      expect(backoffDelayMs(testCase.input.attempt, () => testCase.input.randomValue), testCase.name).toBe(testCase.expected.delayMs);
    }
  });

  it("tries the alternate transport immediately on the first attempt, then shifts the schedule", () => {
    expect(reconnectDelayMs(0, true, () => 0.5)).toBe(0);
    expect(reconnectDelayMs(1, true, () => 0.5)).toBe(1_000);
    expect(reconnectDelayMs(2, true, () => 0.5)).toBe(2_000);
    expect(reconnectDelayMs(0, false, () => 0.5)).toBe(1_000);
  });
});

interface FakeDriver {
  driver: ReconnectDriver;
  calls: string[];
  timers: Map<number, { callback: () => void; delayMs: number }>;
  fire: (id: number) => void;
  setOnline: (online: boolean) => void;
}

function fakeDriver(initialOnline = true): FakeDriver {
  const calls: string[] = [];
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let online = initialOnline;
  let nextId = 1;
  return {
    calls,
    timers,
    driver: {
      connect: () => { calls.push("connect"); },
      isOnline: () => online,
      setTimeout: (callback, delayMs) => {
        const id = nextId++;
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout: (id) => { timers.delete(id); },
      random: () => 0.5,
      now: () => 1_000,
    },
    fire: (id) => {
      const timer = timers.get(id);
      if (!timer) throw new Error(`no timer ${id}`);
      timers.delete(id);
      timer.callback();
    },
    setOnline: (value) => { online = value; },
  };
}

describe("ReconnectController", () => {
  it("schedules an immediate first retry on the alternate transport and resets after a successful connect", () => {
    const fake = fakeDriver();
    const states: ReconnectState[] = [];
    const controller = new ReconnectController(fake.driver, () => true, (state) => states.push(state));

    controller.notifyDisconnected();
    expect([...fake.timers.values()][0]?.delayMs).toBe(0);
    expect(states.at(-1)).toMatchObject({ attempt: 1, waiting: true, pausedOffline: false });

    const timerId = [...fake.timers.keys()][0]!;
    fake.fire(timerId);
    expect(fake.calls).toEqual(["connect"]);

    controller.notifyConnecting();
    controller.notifyDisconnected();
    expect([...fake.timers.values()][0]?.delayMs).toBe(1_000);

    controller.notifyConnected();
    expect(fake.timers.size).toBe(0);
    expect(states.at(-1)).toMatchObject({ attempt: 0, waiting: false });

    controller.dispose();
  });

  it("pauses while offline and retries immediately once back online", () => {
    const fake = fakeDriver(false);
    const controller = new ReconnectController(fake.driver, () => false);

    controller.notifyDisconnected();
    expect(fake.timers.size).toBe(0);
    expect(fake.calls).toEqual([]);

    fake.setOnline(true);
    controller.notifyOnline();
    expect(fake.calls).toEqual(["connect"]);

    controller.dispose();
  });

  it("clears a pending timer when the page goes offline", () => {
    const fake = fakeDriver();
    const controller = new ReconnectController(fake.driver, () => false);

    controller.notifyDisconnected();
    expect(fake.timers.size).toBe(1);

    controller.notifyOffline();
    expect(fake.timers.size).toBe(0);

    controller.dispose();
  });

  it("resets the backoff when the page returns to the foreground", () => {
    const fake = fakeDriver();
    const states: ReconnectState[] = [];
    const controller = new ReconnectController(fake.driver, () => false, (state) => states.push(state));

    controller.notifyDisconnected();
    controller.notifyDisconnected();
    const lastTimer = [...fake.timers.values()].at(-1);
    expect(lastTimer?.delayMs).toBe(2_000);

    controller.notifyForeground();
    expect(fake.calls).toEqual(["connect"]);
    expect(fake.timers.size).toBe(0);

    controller.dispose();
  });

  it("retries immediately on user request, replacing any scheduled attempt", () => {
    const fake = fakeDriver();
    const controller = new ReconnectController(fake.driver, () => false);

    controller.notifyDisconnected();
    expect(fake.timers.size).toBe(1);

    controller.retryNow();
    expect(fake.calls).toEqual(["connect"]);
    expect(fake.timers.size).toBe(0);

    controller.dispose();
  });
});
