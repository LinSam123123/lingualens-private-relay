/** Coalesce navigation pulses without losing the final URL's handshake. */
export class PageCheckQueue {
  private active: Promise<void> | null = null;
  private pending: (() => Promise<void>) | null = null;

  run(check: () => Promise<void>): Promise<void> {
    this.pending = check;
    if (this.active) return this.active;
    this.active = Promise.resolve().then(async () => {
      try {
        while (this.pending) {
          const next = this.pending;
          this.pending = null;
          await next();
        }
      } finally { this.active = null; }
    });
    return this.active;
  }

  clear(): void { this.pending = null; }
}
