import type { Clock } from "../../src/infra/time.js";

/** Virtual clock: `sleep` advances time instantly so timing logic is deterministic. */
export class FakeClock implements Clock {
  private t: number;
  sleeps: number[] = [];

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}
