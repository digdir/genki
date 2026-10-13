export type ChangeTopic =
  | 'settings'
  | 'support-sessions'
  | 'config-entries'
  | 'definitions'
  | 'model-classifications'
  | 'tool-connections';

export interface ChangeFeed {
  on(topic: string, fn: () => void | Promise<void>): () => void;
}

export class LocalChangeFeed implements ChangeFeed {
  readonly #listeners = new Map<string, Set<() => void | Promise<void>>>();

  on(topic: string, fn: () => void | Promise<void>): () => void {
    const listeners = this.#listeners.get(topic) ?? new Set();
    listeners.add(fn);
    this.#listeners.set(topic, listeners);
    return () => {
      listeners.delete(fn);
    };
  }

  async emit(topic: string): Promise<void> {
    await Promise.all([...(this.#listeners.get(topic) ?? [])].map((fn) => fn()));
  }
}

export interface ChangeFollowers {
  settings: { reload(): Promise<void> };
  supportSessions: { reload(): Promise<void> };
  catalog: { refresh(): Promise<void> };
  definitions: { sync(): Promise<void> };
  models: { refresh(): Promise<unknown> };
  toolConnections: { reload(): Promise<void> };
}

export const followChanges = (feed: ChangeFeed, followers: ChangeFollowers): (() => void) => {
  const actions: Record<ChangeTopic, () => Promise<void>> = {
    settings: () => followers.settings.reload(),
    'support-sessions': () => followers.supportSessions.reload(),
    'config-entries': () => followers.catalog.refresh(),
    definitions: () => followers.definitions.sync(),
    'model-classifications': async () => {
      await followers.models.refresh();
    },
    'tool-connections': () => followers.toolConnections.reload(),
  };
  const stops = Object.entries(actions).map(([topic, action]) => feed.on(topic, action));
  return () => {
    for (const stop of stops) stop();
  };
};
