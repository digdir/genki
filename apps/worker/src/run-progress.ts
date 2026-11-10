export type ProgressLog = (msg: string, fields: Record<string, unknown>) => void;

export interface RunProgress {
  /** Returns the function that marks the job ended. */
  started(run: { id: string; dataset: string }): () => void;
  stored(run: string, chunks: number): void;
  stop(): void;
}

interface Tally {
  dataset: string;
  stored: number;
  chunks: number;
  active: number;
}

export const runProgress = (log: ProgressLog, everyMs = 60_000): RunProgress => {
  const runs = new Map<string, Tally>();
  const flush = () => {
    for (const [run, tally] of runs) {
      if (tally.stored > 0 || tally.active > 0)
        log('knowledge run progress', {
          run,
          dataset: tally.dataset,
          stored: tally.stored,
          chunks: tally.chunks,
          active: tally.active,
        });
      if (tally.active === 0) runs.delete(run);
      else Object.assign(tally, { stored: 0, chunks: 0 });
    }
  };
  const timer = setInterval(flush, everyMs);
  timer.unref?.();
  const tallyOf = (run: string, dataset = '') => {
    const found = runs.get(run);
    if (found) return found;
    const tally = { dataset, stored: 0, chunks: 0, active: 0 };
    runs.set(run, tally);
    return tally;
  };
  return {
    started: ({ id, dataset }) => {
      const tally = tallyOf(id, dataset);
      tally.active += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        tally.active -= 1;
      };
    },
    stored: (run, chunks) => {
      const tally = tallyOf(run);
      tally.stored += 1;
      tally.chunks += chunks;
    },
    stop: () => clearInterval(timer),
  };
};
