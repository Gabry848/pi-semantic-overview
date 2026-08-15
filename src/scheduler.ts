export type SummaryReason = "periodic" | "key-event" | "manual";

export interface SchedulerOptions {
  everyTurns: number;
  run: (reason: SummaryReason) => Promise<void>;
  onError?: (error: unknown) => void;
}

export class SingleFlightScheduler {
  private running = false;
  private pending: SummaryReason | undefined;
  private disposed = false;
  private generation = 0;
  private turns = 0;

  constructor(private options: SchedulerOptions) {}

  configureEveryTurns(everyTurns: number): void {
    this.options.everyTurns = Math.max(1, Math.trunc(everyTurns));
  }

  onTurn(): boolean {
    this.turns++;
    if (this.turns % this.options.everyTurns !== 0) return false;
    this.trigger("periodic");
    return true;
  }

  onKeyEvent(): void { this.trigger("key-event"); }
  force(): void { this.trigger("manual"); }

  trigger(reason: SummaryReason): void {
    if (this.disposed) return;
    if (this.running) {
      this.pending = prioritize(this.pending, reason);
      return;
    }
    this.pending = prioritize(this.pending, reason);
    const generation = this.generation;
    queueMicrotask(() => { void this.drain(generation); });
  }

  private async drain(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation || this.running) return;
    const reason = this.pending;
    if (!reason) return;
    this.pending = undefined;
    this.running = true;
    try { await this.options.run(reason); }
    catch (error) { this.options.onError?.(error); }
    finally {
      this.running = false;
      if (!this.disposed && this.pending) {
        const currentGeneration = this.generation;
        queueMicrotask(() => { void this.drain(currentGeneration); });
      }
    }
  }

  invalidate(): void {
    this.pending = undefined;
    this.turns = 0;
    this.generation++;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  get isRunning(): boolean { return this.running; }
  get hasPending(): boolean { return this.pending !== undefined; }
}

function prioritize(current: SummaryReason | undefined, incoming: SummaryReason): SummaryReason {
  const rank: Record<SummaryReason, number> = { periodic: 0, "key-event": 1, manual: 2 };
  return !current || rank[incoming] > rank[current] ? incoming : current;
}
