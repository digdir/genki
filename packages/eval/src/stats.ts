export const mean = (values: number[]) => {
  if (values.length === 0) throw new Error('mean of no values');
  return values.reduce((a, b) => a + b, 0) / values.length;
};

export const percentile = (sorted: number[], q: number) => {
  if (sorted.length === 0) throw new Error('percentile of no values');
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low] as number;
  return lowValue + ((sorted[high] as number) - lowValue) * (position - low);
};

const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface BootstrapOptions {
  iterations?: number;
  confidence?: number;
  seed?: number;
}

export const bootstrapMean = (
  values: number[],
  options: BootstrapOptions = {},
): [number, number] => {
  const { iterations = 2000, confidence = 0.95, seed = 1 } = options;
  if (values.length === 0) throw new Error('bootstrap of no values');
  const next = random(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++)
      sum += values[Math.floor(next() * values.length)] as number;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return [percentile(means, tail), percentile(means, 1 - tail)];
};

export interface PairedComparison {
  n: number;
  meanBaseline: number;
  meanCandidate: number;
  difference: number;
  ci: [number, number];
}

export const pairedBootstrap = (
  baseline: number[],
  candidate: number[],
  options: BootstrapOptions = {},
): PairedComparison => {
  if (baseline.length !== candidate.length)
    throw new Error('paired samples must have the same length');
  const differences = candidate.map((c, i) => c - (baseline[i] as number));
  return {
    n: differences.length,
    meanBaseline: mean(baseline),
    meanCandidate: mean(candidate),
    difference: mean(differences),
    ci: bootstrapMean(differences, options),
  };
};
