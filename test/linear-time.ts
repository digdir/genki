const fastest = (work: () => void, runs: number) => {
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    work();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

export const timeGrowth = (work: (size: number) => void, size: number, factor = 8, runs = 5) => {
  work(size);
  const small = fastest(() => work(size), runs);
  const large = fastest(() => work(size * factor), runs);
  return large / Math.max(small, 0.05);
};
