import { describe, expect, it } from 'vitest';
import { followChanges, LocalChangeFeed, refreshEverywhere } from './change-feed.js';
import { discoverWithRetry } from './discovery-retry.js';

const idle = { reload: async () => undefined };

const replica = async (feed: LocalChangeFeed, listing: () => Promise<{ failed: never[] }>) => {
  let up = false;
  let calls = 0;
  const discovery = await discoverWithRetry({
    refresh: async () => {
      calls += 1;
      if (!up) return { failed: [{ endpoint: 'foundry', error: '408' }] };
      return listing();
    },
    maxAttempts: 1,
    schedule: () => ({}),
  });
  followChanges(feed, {
    settings: idle,
    supportSessions: idle,
    catalog: { refresh: async () => undefined },
    definitions: { sync: async () => undefined },
    models: discovery,
    toolConnections: idle,
  });
  return {
    discovery,
    calls: () => calls,
    recover: () => {
      up = true;
    },
  };
};

describe('model discovery over the change feed', () => {
  it('a change-feed refresh shares the in-flight discovery and clears a failed state', async () => {
    const feed = new LocalChangeFeed();
    let release: (value: { failed: never[] }) => void = () => undefined;
    const node = await replica(
      feed,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(node.discovery.state()).toMatchObject({ state: 'failed' });
    node.recover();

    const operator = node.discovery.refresh();
    const followed = feed.emit('model-classifications');
    release({ failed: [] });
    await Promise.all([operator, followed]);

    expect(node.calls()).toBe(2);
    expect(node.discovery.state()).toEqual({ state: 'ok', attempts: 2 });
  });

  it('an operator refresh reaches the other replicas through the feed', async () => {
    const feed = new LocalChangeFeed();
    const own = await replica(feed, async () => ({ failed: [] }));
    const other = await replica(new LocalChangeFeed(), async () => ({ failed: [] }));
    followChanges(feed, {
      settings: idle,
      supportSessions: idle,
      catalog: { refresh: async () => undefined },
      definitions: { sync: async () => undefined },
      models: other.discovery,
      toolConnections: idle,
    });
    own.recover();
    other.recover();

    await refreshEverywhere(own.discovery, { announce: (topic) => feed.emit(topic) });

    expect(other.discovery.state()).toMatchObject({ state: 'ok' });
  });

  it('announces to the other replicas even when the local refresh throws', async () => {
    const announced: string[] = [];

    await expect(
      refreshEverywhere(
        {
          refresh: async () => {
            throw new Error('network down');
          },
        },
        {
          announce: async (topic) => {
            announced.push(topic);
          },
        },
      ),
    ).rejects.toThrow('network down');
    expect(announced).toEqual(['model-classifications']);
  });
});
