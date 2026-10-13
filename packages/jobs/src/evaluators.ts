import type { EvalContext, Evaluator, Observation, Score, TestCase } from '@genai/eval';

const words = (text: string) => text.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];

const sentences = (text: string) =>
  text
    .split(/(?<=[.!?:])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);

export const lix = (text: string) => {
  const all = words(text);
  const count = sentences(text).length;
  if (all.length === 0 || count === 0) return 0;
  const long = all.filter((w) => w.length > 6).length;
  return all.length / count + (long * 100) / all.length;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

const outputText = (o: Observation) =>
  typeof o.fields?.text === 'string' ? o.fields.text : o.answer;

const passiveForms = [
  'behandles',
  'vurderes',
  'innvilges',
  'avslås',
  'sendes',
  'kreves',
  'anses',
  'påklages',
  'fastsettes',
  'iverksettes',
  'utbetales',
  'tilbakebetales',
  'foretas',
  'meddeles',
  'avgjøres',
];

const score = (
  self: Evaluator,
  metric: string,
  value: number,
  details?: Record<string, unknown>,
): Score => ({
  evaluator: self.id,
  version: self.version,
  metric,
  value,
  applicable: true,
  ...(details ? { details } : {}),
});

export const klarsprakChecklist = (): Evaluator => {
  const self: Evaluator = {
    id: 'klarsprak-checklist',
    version: '1',
    kind: 'deterministic',
    evaluate: async (_c: TestCase, o: Observation, _ctx: EvalContext) => {
      const text = outputText(o);
      const all = words(text).map((w) => w.toLowerCase());
      const perSentence = all.length / Math.max(1, sentences(text).length);
      const readability = lix(text);
      const passives = all.filter((w) => passiveForms.includes(w)).length;
      const passiveRate = (passives * 100) / Math.max(1, all.length);
      const direct = all.some((w) => ['du', 'deg', 'din', 'ditt', 'dine'].includes(w));
      const metrics = [
        score(self, 'klarsprak.readability', clamp((60 - readability) / 30), {
          lix: Math.round(readability * 10) / 10,
        }),
        score(self, 'klarsprak.sentence-length', clamp((30 - perSentence) / 15), {
          wordsPerSentence: Math.round(perSentence * 10) / 10,
        }),
        score(self, 'klarsprak.direct-address', direct ? 1 : 0),
        score(self, 'klarsprak.active-voice', clamp(1 - passiveRate / 5), {
          passivesPer100Words: Math.round(passiveRate * 10) / 10,
        }),
      ];
      const overall = metrics.reduce((a, m) => a + (m.value ?? 0), 0) / metrics.length;
      return [...metrics, score(self, 'klarsprak.overall', overall)];
    },
  };
  return self;
};

const ngrams = (text: string, n: number) => {
  const chars = text.replace(/\s+/g, ' ').trim();
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= chars.length; i += 1) {
    const g = chars.slice(i, i + n);
    if (g.trim().length < n && n > 1) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
};

export const chrF = (hypothesis: string, reference: string, maxN = 6, beta = 2) => {
  let precision = 0;
  let recall = 0;
  let orders = 0;
  for (let n = 1; n <= maxN; n += 1) {
    const h = ngrams(hypothesis, n);
    const r = ngrams(reference, n);
    const hTotal = [...h.values()].reduce((a, b) => a + b, 0);
    const rTotal = [...r.values()].reduce((a, b) => a + b, 0);
    if (hTotal === 0 || rTotal === 0) continue;
    let overlap = 0;
    for (const [g, c] of h) overlap += Math.min(c, r.get(g) ?? 0);
    precision += overlap / hTotal;
    recall += overlap / rTotal;
    orders += 1;
  }
  if (orders === 0) return 0;
  precision /= orders;
  recall /= orders;
  if (precision + recall === 0) return 0;
  return ((1 + beta ** 2) * precision * recall) / (beta ** 2 * precision + recall);
};

export const bokmalOnlyWords = [
  'ikke',
  'jeg',
  'hva',
  'hvordan',
  'hvorfor',
  'hvem',
  'hvilke',
  'hvilken',
  'hvis',
  'noen',
  'fra',
  'mye',
  'være',
  'kommer',
  'bare',
  'dere',
  'hjem',
  'ønsker',
  'hos',
];

export const nynorskReference = (): Evaluator => {
  const self: Evaluator = {
    id: 'nynorsk-reference',
    version: '1',
    kind: 'deterministic',
    evaluate: async (c: TestCase, o: Observation) => {
      const text = outputText(o);
      const reference = c.expected.referenceAnswer;
      const found = words(text)
        .map((w) => w.toLowerCase())
        .filter((w) => bokmalOnlyWords.includes(w));
      const markers = score(self, 'nynorsk.no-bokmal-words', clamp(1 - found.length / 10), {
        found,
      });
      if (!reference)
        return [
          markers,
          {
            evaluator: self.id,
            version: self.version,
            metric: 'nynorsk.chrf',
            value: null,
            applicable: false,
            reason: 'the case has no reference',
          },
        ];
      return [markers, score(self, 'nynorsk.chrf', chrF(text, reference))];
    },
  };
  return self;
};
