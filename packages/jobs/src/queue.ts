export interface QueueMessage<T = unknown> {
  id: string;
  body: T;
  deliveries: number;
}

export type QueueHandler<T = unknown> = (message: QueueMessage<T>) => Promise<void>;

export interface MessageQueue {
  send<T>(queue: string, body: T): Promise<string>;
  subscribe<T>(queue: string, handler: QueueHandler<T>): () => void;
}

export interface DeadLetter {
  queue: string;
  message: QueueMessage;
  error: string;
}

export class InMemoryQueue implements MessageQueue {
  readonly #pending = new Map<string, QueueMessage[]>();
  readonly #handlers = new Map<string, QueueHandler>();
  readonly deadLetters: DeadLetter[] = [];
  #counter = 0;

  constructor(private readonly maxDeliveries = 3) {}

  async send<T>(queue: string, body: T): Promise<string> {
    const message: QueueMessage = { id: `m${++this.#counter}`, body, deliveries: 0 };
    this.#pending.set(queue, [...(this.#pending.get(queue) ?? []), message]);
    await this.#drain(queue);
    return message.id;
  }

  subscribe<T>(queue: string, handler: QueueHandler<T>): () => void {
    if (this.#handlers.has(queue)) throw new Error(`queue ${queue} already has a consumer`);
    this.#handlers.set(queue, handler as QueueHandler);
    void this.#drain(queue);
    return () => this.#handlers.delete(queue);
  }

  pending(queue: string): number {
    return this.#pending.get(queue)?.length ?? 0;
  }

  async #drain(queue: string) {
    const handler = this.#handlers.get(queue);
    if (!handler) return;
    let message = this.#pending.get(queue)?.shift();
    while (message) {
      message.deliveries += 1;
      try {
        await handler(message);
      } catch (error) {
        if (message.deliveries >= this.maxDeliveries)
          this.deadLetters.push({
            queue,
            message,
            error: error instanceof Error ? error.message : String(error),
          });
        else this.#pending.get(queue)?.push(message);
      }
      message = this.#pending.get(queue)?.shift();
    }
  }
}
