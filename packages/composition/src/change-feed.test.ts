import { describe, expect, it } from 'vitest';
import { followChanges, LocalChangeFeed, refreshEverywhere } from './change-feed.js';

const idle = { reload: async () => undefined };

const replica = (feed: LocalChangeFeed) => {
  const seen = { listed: 0, loaded: 0 };
  const discovery = {
    refresh: async () => {
      seen.listed += 1;
      return { failed: [] };
    },
    loadDiscovered: async () => {
      seen.loaded += 1;
    },
  };
  followChanges(feed, {
    settings: idle,
    contentReasons: idle,
    catalog: { refresh: async () => undefined },
    definitions: { sync: async () => undefined },
    models: discovery,
    toolConnections: idle,
  });
  return { discovery, seen };
};

describe('model discovery over the change feed', () => {
  it('a model-classifications change loads the stored listings and lists nothing', async () => {
    const feed = new LocalChangeFeed();
    const node = replica(feed);

    await feed.emit('model-classifications');

    expect(node.seen).toEqual({ listed: 0, loaded: 1 });
  });

  it('an operator refresh lists on one replica and the others load what it stored', async () => {
    const feed = new LocalChangeFeed();
    const own = replica(new LocalChangeFeed());
    const other = replica(feed);

    await refreshEverywhere(own.discovery, { announce: (topic) => feed.emit(topic) });

    expect(own.seen.listed).toBe(1);
    expect(other.seen).toEqual({ listed: 0, loaded: 1 });
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
