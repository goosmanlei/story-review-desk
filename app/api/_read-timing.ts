/** Durations end at serialization; transfer and rendering are measured by the browser. */
export class ReadTiming {
  private start = performance.now();
  private values = new Map<string, number>();
  record(name: string, milliseconds: number) { this.values.set(name, (this.values.get(name) || 0) + milliseconds); }
  async measure<T>(name: string, read: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await read(); } finally { this.record(name, performance.now() - start); }
  }
  headers() { return { 'Server-Timing': [...this.values, ['total', performance.now() - this.start]].map(([name, ms]) => `${name};dur=${Number(ms).toFixed(1)}`).join(', ') }; }
}
