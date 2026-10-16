import type { Clock } from "../../shared/core/clock";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

export class ManualClock implements Clock {
  private t = 0;
  private waiters: { at: number; resolve: () => void }[] = [];
  now() {
    return this.t;
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => {
      this.waiters.push({ at: this.t + ms, resolve });
    });
  }
  pending() {
    return this.waiters.map((w) => w.at - this.t).sort((a, b) => a - b);
  }
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const due = this.waiters.filter((w) => w.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.waiters = this.waiters.filter((w) => w !== due);
      this.t = due.at;
      due.resolve();
    }
    this.t = target;
    await flush();
  }
}
