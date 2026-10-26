/** Request-local durations only. Never records message content or credentials. */
export class SendTiming {
  private readonly started = performance.now();
  private readonly durations = new Map<string, number>();
  async measure<T>(name: string, work: () => PromiseLike<T>): Promise<T> {
    const start = performance.now();
    try {
      return await work();
    } finally {
      this.record(name, performance.now() - start);
    }
  }
  record(name: string, duration: number) {
    if (!/^[a-z_]+$/.test(name) || !Number.isFinite(duration)) return;
    this.durations.set(
      name,
      (this.durations.get(name) ?? 0) + Math.max(0, duration)
    );
  }
  elapsed() {
    return performance.now() - this.started;
  }
  header() {
    return [
      ...this.durations,
      ['total', performance.now() - this.started] as const,
    ]
      .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`)
      .join(', ');
  }
}
