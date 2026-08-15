import { describe, expect, it, vi } from "vitest";
import { SingleFlightScheduler } from "../src/scheduler.js";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("single-flight scheduler", () => {
  it("triggers periodically and on key events", async () => {
    const run = vi.fn(async () => {});
    const scheduler = new SingleFlightScheduler({ everyTurns: 2, run });
    expect(scheduler.onTurn()).toBe(false);
    expect(scheduler.onTurn()).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledWith("periodic");
    scheduler.onKeyEvent();
    await flush();
    expect(run).toHaveBeenCalledWith("key-event");
  });

  it("runs serially and coalesces pending requests", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    let active = 0; let peak = 0; let calls = 0;
    const scheduler = new SingleFlightScheduler({ everyTurns: 1, run: async () => {
      calls++; active++; peak = Math.max(peak, active);
      if (calls === 1) await first;
      active--;
    } });
    scheduler.force(); await flush();
    scheduler.onKeyEvent(); scheduler.force(); scheduler.onKeyEvent();
    expect(calls).toBe(1);
    release(); await flush(); await flush();
    expect(calls).toBe(2);
    expect(peak).toBe(1);
  });

  it("invalidates queued branch-bound work while remaining reusable", async () => {
    const run = vi.fn(async () => {});
    const scheduler = new SingleFlightScheduler({ everyTurns: 1, run });
    scheduler.force(); scheduler.invalidate();
    await flush();
    expect(run).not.toHaveBeenCalled();
    scheduler.onKeyEvent(); await flush();
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs new-branch work queued while invalidated work is still settling", async () => {
    let release!: () => void; let calls = 0;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new SingleFlightScheduler({ everyTurns: 1, run: async () => { calls++; if (calls === 1) await first; } });
    scheduler.force(); await flush();
    scheduler.invalidate(); scheduler.onKeyEvent();
    release(); await flush(); await flush();
    expect(calls).toBe(2);
  });

  it("cleans up pending work on dispose", async () => {
    const run = vi.fn(async () => {});
    const scheduler = new SingleFlightScheduler({ everyTurns: 1, run });
    scheduler.force(); scheduler.dispose();
    await flush();
    expect(run).not.toHaveBeenCalled();
    scheduler.onKeyEvent(); await flush();
    expect(run).not.toHaveBeenCalled();
  });
});
