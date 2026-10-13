import {
  envelopeEventTypes,
  type Event,
  type Principal,
  type Ref,
  type Task,
} from '@genai/contracts';
import { KernelError } from './spi.js';

export interface ContentScope {
  tenant: string;
  key: string;
}

export interface EventLog {
  append(event: Omit<Event, 'seq'>, scope: ContentScope): Promise<Event>;
  read(task: string, fromSeq: number, isLive: () => boolean): AsyncIterable<Event>;
  wake(task: string): void;
}

export interface StoredTask {
  task: Task;
  principal: Principal;
  lastSeq: number;
  checkpoint?: unknown;
}

export interface TaskStore {
  put(stored: StoredTask, scope: ContentScope): Promise<void>;
  get(id: string): Promise<StoredTask | undefined>;
  pendingFor(who: Ref): Promise<Task[]>;
}

export interface StateStore {
  get(key: string, scope: ContentScope): Promise<{ v: number; value: unknown } | undefined>;
  put(key: string, value: unknown, scope: ContentScope, expectV?: number): Promise<number>;
}

export const sameRef = (a: Ref | undefined, b: Ref) =>
  a !== undefined && a.kind === b.kind && a.id === b.id && a.tenant === b.tenant;

const envelopeTypes = new Set<string>(envelopeEventTypes);

export class InMemoryEventLog implements EventLog {
  readonly #events = new Map<string, Event[]>();
  readonly #waiters = new Map<string, (() => void)[]>();

  async append(event: Omit<Event, 'seq'>): Promise<Event> {
    const list = this.#events.get(event.task) ?? [];
    const stored = { ...event, seq: list.length } as Event;
    list.push(stored);
    this.#events.set(event.task, list);
    this.wake(event.task);
    return stored;
  }

  dropPayloads(task: string): void {
    const list = this.#events.get(task) ?? [];
    this.#events.set(
      task,
      list.map((e) => {
        if (envelopeTypes.has(e.type)) return e;
        const stripped: Event = { ...e, data: { erased: true } };
        delete stripped.fallback;
        return stripped;
      }),
    );
  }

  drop(task: string): void {
    this.#events.delete(task);
  }

  wake(task: string): void {
    const waiters = this.#waiters.get(task) ?? [];
    this.#waiters.delete(task);
    for (const w of waiters) w();
  }

  async *read(task: string, fromSeq: number, isLive: () => boolean): AsyncIterable<Event> {
    let next = Math.max(0, Math.trunc(fromSeq));
    for (;;) {
      const list = this.#events.get(task) ?? [];
      while (next < list.length) {
        const event = list.at(next);
        next += 1;
        if (event) yield event;
      }
      if (!isLive()) return;
      await new Promise<void>((resolve) => {
        const waiters = this.#waiters.get(task) ?? [];
        waiters.push(resolve);
        this.#waiters.set(task, waiters);
      });
    }
  }
}

export class InMemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, StoredTask>();

  async put(stored: StoredTask): Promise<void> {
    this.#tasks.set(stored.task.id, structuredClone(stored));
  }

  async get(id: string): Promise<StoredTask | undefined> {
    const found = this.#tasks.get(id);
    return found && structuredClone(found);
  }

  all(): StoredTask[] {
    return [...this.#tasks.values()].map((s) => structuredClone(s));
  }

  dropContent(id: string): void {
    const found = this.#tasks.get(id);
    if (!found) return;
    const task = { ...found.task };
    delete task.result;
    delete task.pendingInterrupt;
    this.#tasks.set(id, {
      task,
      principal: {
        kind: found.principal.kind,
        issuer: 'erased',
        subject: 'erased',
        ...(found.principal.tenant === undefined ? {} : { tenant: found.principal.tenant }),
      },
      lastSeq: found.lastSeq,
    });
  }

  delete(id: string): void {
    this.#tasks.delete(id);
  }

  async pendingFor(who: Ref): Promise<Task[]> {
    return [...this.#tasks.values()]
      .map((s) => s.task)
      .filter(
        (t) =>
          t.status === 'interrupted' &&
          (sameRef(t.principal, who) || sameRef(t.pendingInterrupt?.assignee, who)),
      )
      .map((t) => structuredClone(t));
  }
}

export class InMemoryStateStore implements StateStore {
  readonly #values = new Map<string, { v: number; value: unknown }>();

  async get(key: string) {
    return this.#values.get(key);
  }

  async put(key: string, value: unknown, _scope?: ContentScope, expectV?: number): Promise<number> {
    const current = this.#values.get(key);
    if (expectV !== undefined && (current?.v ?? 0) !== expectV) {
      throw new KernelError('invalid_state', `state ${key} changed since version ${expectV}`);
    }
    const v = (current?.v ?? 0) + 1;
    this.#values.set(key, { v, value });
    return v;
  }
}
