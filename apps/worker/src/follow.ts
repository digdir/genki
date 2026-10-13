export interface ChangeSource {
  on(topic: string, listener: () => void | Promise<void>): () => void;
}

export interface Leadership {
  tryAcquire(): Promise<boolean>;
}

export interface FollowOptions {
  sync: () => Promise<{ active: boolean }>;
  feed?: ChangeSource;
  leadership?: Leadership;
  topics?: string[];
  leaderPollMs?: number;
  onError?: (error: unknown) => void;
}

export const followPublished = (options: FollowOptions) => {
  const onError = options.onError ?? (() => undefined);
  let active: boolean | undefined;
  const run = async () => {
    try {
      active = (await options.sync()).active;
    } catch (error) {
      onError(error);
    }
  };
  const off = (options.topics ?? ['definitions', 'config-entries']).map((topic) =>
    options.feed?.on(topic, run),
  );
  const timer = options.leadership
    ? setInterval(() => {
        void (async () => {
          try {
            if ((await options.leadership?.tryAcquire()) !== active) await run();
          } catch (error) {
            onError(error);
          }
        })();
      }, options.leaderPollMs ?? 15_000)
    : undefined;
  timer?.unref();
  return {
    run,
    stop: () => {
      clearInterval(timer);
      for (const stop of off) stop?.();
    },
  };
};
