import type { Emitted } from './spi.js';

export interface DeltaWindow {
  ms: number;
  chars: number;
}

interface Pending {
  event: Emitted;
  key: string;
  text: string;
}

const textOf = (e: Emitted): string | undefined => {
  if (e.type !== 'kernel.part.delta') return undefined;
  const data = e.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || typeof data.text !== 'string') return undefined;
  return Object.keys(data).length === 1 ? data.text : undefined;
};

const keyOf = (e: Emitted) => JSON.stringify([e.v ?? 1, e.span, e.fallback, e.audience]);

export class DeltaCoalescer {
  private pending: Pending | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWrite = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly window: DeltaWindow,
    private readonly write: (e: Emitted) => Promise<unknown>,
    private readonly onError: (error: unknown) => void,
  ) {}

  async push(e: Emitted): Promise<void> {
    const text = textOf(e);
    if (text === undefined) {
      await this.flush();
      await this.write(e);
      return;
    }
    const key = keyOf(e);
    if (this.pending && this.pending.key !== key) await this.flush();
    if (this.pending) this.pending.text += text;
    else this.pending = { event: e, key, text };
    if (
      this.pending.text.length >= this.window.chars ||
      Date.now() - this.lastWrite >= this.window.ms
    ) {
      await this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush().catch(this.onError);
    }, this.window.ms);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    if (!pending) return Promise.resolve();
    this.pending = undefined;
    this.lastWrite = Date.now();
    return this.write({ ...pending.event, data: { text: pending.text } }).then(() => {
      this.lastWrite = Date.now();
    });
  }
}
