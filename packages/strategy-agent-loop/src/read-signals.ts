import type { QueryIntent } from './intent.js';
import {
  clampConfidence,
  json,
  structuredEvaluate,
  validatedEnum,
  type Evaluator,
} from './structured.js';
import type { Chunk, OpenGap } from './workspace.js';

export const readEvaluatorSystemPrompt = [
  'You are the read-time evidence evaluator for a RAG coding/research agent.',
  '',
  'Your job is to inspect only the newly read chunks and decide what they add to the current evidence state.',
  '',
  "Do not answer the user's question.",
  'Do not use prior knowledge.',
  'Do not guess.',
  'Prefer false negatives over false positives.',
  '',
  'You must evaluate:',
  '- which required claims are explicitly supported by the new chunks',
  '- which claims are partially supported',
  '- which claims remain unsupported',
  '- whether the new chunks introduce contradictions',
  "- whether the evidence is on the correct scope for the user's query",
  '- the best local next action hint',
  '',
  'Return JSON only, matching the provided schema exactly.',
  'Allowed status values: support-found, gap-remaining, conflicting, unclear.',
  'Allowed scope_assessment values: aligned, partially-aligned, wrong-scope, ambiguous.',
  'Allowed support values: explicit, partial.',
  'Allowed remaining_gaps.reason values: not-addressed, ambiguous, wrong-scope, contradiction.',
  'Allowed next_action_hint values: read-more, re-search, ask-clarification, finalize.',
].join('\n');

export const readEvaluatorResponseShape = {
  status: 'support-found | gap-remaining | conflicting | unclear',
  scope_assessment: 'aligned | partially-aligned | wrong-scope | ambiguous',
  supported_claims: [
    {
      claim_id: 'claim-id',
      support: 'explicit | partial',
      chunk_ids: ['chunk-id'],
      notes: 'optional short explanation',
    },
  ],
  remaining_gaps: [
    {
      claim_id: 'claim-id',
      reason: 'not-addressed | ambiguous | wrong-scope | contradiction',
      critical: true,
    },
  ],
  contradictions: [
    {
      claim_id: 'claim-id',
      chunk_ids: ['chunk-a', 'chunk-b'],
      summary: 'optional short contradiction summary',
    },
  ],
  next_action_hint: 'read-more | re-search | ask-clarification | finalize',
  confidence: 0.0,
};

const statuses = ['support-found', 'gap-remaining', 'conflicting', 'unclear'] as const;
const scopes = ['aligned', 'partially-aligned', 'wrong-scope', 'ambiguous'] as const;
const supportLevels = ['explicit', 'partial'] as const;
const gapReasons = ['not-addressed', 'ambiguous', 'wrong-scope', 'contradiction'] as const;
const hints = ['read-more', 're-search', 'ask-clarification', 'finalize'] as const;

export interface RequiredClaim {
  claimId: string;
  text: string;
  kind: string;
  critical: boolean;
}

export interface EvidencePlan {
  query: string;
  queryIntent: QueryIntent;
  requiredClaims: RequiredClaim[];
}

export interface ReadSignal {
  status: (typeof statuses)[number];
  scopeAssessment: (typeof scopes)[number];
  supportedClaims: {
    claimId: string;
    supportLevel: (typeof supportLevels)[number];
    chunkIds: string[];
    notes?: string;
  }[];
  partialClaims: ReadSignal['supportedClaims'];
  remainingGaps: { claimId: string; reason: (typeof gapReasons)[number]; critical: boolean }[];
  contradictions: { claimId?: string; chunkIds: string[]; summary?: string }[];
  nextActionHint: (typeof hints)[number];
  confidence: number;
  degraded: boolean;
  degradedReason?: string;
  evaluationMode: 'llm' | 'degraded-fallback';
}

const claim = (claimId: string, text: string, kind: string): RequiredClaim => ({
  claimId,
  text,
  kind,
  critical: true,
});

export const buildEvidencePlan = (query: string, intent: QueryIntent): EvidencePlan => {
  const base = [
    ...(intent.entity
      ? [claim('target-entity', `Evidence is about ${intent.entity}`, 'scope')]
      : []),
    ...(intent.metric
      ? [claim('target-metric', `Evidence mentions metric ${intent.metric}`, 'metric')]
      : []),
    ...(intent['year-or-date']
      ? [claim('target-period', `Evidence matches period ${intent['year-or-date']}`, 'time')]
      : []),
  ];
  const lookup = [
    claim('topic-match', 'Evidence directly matches the topic', 'topic'),
    claim('answer-bearing-evidence', 'Evidence contains answer-bearing details', 'support'),
  ];
  const byType =
    intent['answer-type'] === 'numeric-fact'
      ? [claim('requested-value', 'Evidence includes an explicit value', 'value')]
      : intent['answer-type'] === 'comparison'
        ? [claim('comparison-evidence', 'Evidence supports a comparison', 'comparison')]
        : lookup;
  return { query, queryIntent: intent, requiredClaims: [...base, ...byType] };
};

export const fallbackReadSignal = (
  plan: EvidencePlan | undefined,
  reason = 'local-evaluator-failed',
): ReadSignal => ({
  status: 'unclear',
  scopeAssessment: 'ambiguous',
  supportedClaims: [],
  partialClaims: [],
  remainingGaps: (plan?.requiredClaims ?? []).map((c) => ({
    claimId: c.claimId,
    reason: 'not-addressed',
    critical: c.critical,
  })),
  contradictions: [],
  nextActionHint: 're-search',
  confidence: 0,
  degraded: true,
  degradedReason: reason,
  evaluationMode: 'degraded-fallback',
});

const claimJson = (c: { claimId: string; text?: string; kind?: string; critical: boolean }) => ({
  claim_id: c.claimId,
  text: c.text ?? null,
  kind: c.kind ?? null,
  critical: c.critical,
});

const chunkPayload = (c: Chunk) => ({
  chunk_id: c.chunkId,
  doc_num: c.document ?? null,
  chunk_index: c.position ?? null,
  title: c.title ?? null,
  metadata: c.headers?.length ? JSON.stringify(c.headers) : null,
  content: c.content,
});

export const buildReadEvaluatorPrompt = (
  query: string,
  intent: QueryIntent,
  plan: EvidencePlan | undefined,
  openClaims: (RequiredClaim | OpenGap)[],
  chunks: Chunk[],
): string =>
  `User query:\n${query}` +
  `\n\nQuery intent JSON:\n${json(intent)}` +
  `\n\nEvidence plan JSON:\n${json({ required_claims: (plan?.requiredClaims ?? []).map(claimJson) })}` +
  `\n\nCurrently unresolved claims JSON:\n${json((openClaims.length ? openClaims : (plan?.requiredClaims ?? [])).map(claimJson))}` +
  `\n\nNewly read chunks JSON:\n${json(chunks.map(chunkPayload))}` +
  '\n\nReturn JSON only.\n' +
  `Use exactly this shape:\n${json(readEvaluatorResponseShape)}`;

const str = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    : [];

export const normalizeReadSignal = (
  raw: Record<string, unknown>,
  plan: EvidencePlan | undefined,
): ReadSignal => {
  const known = new Set((plan?.requiredClaims ?? []).map((c) => c.claimId));
  const resolve = (v: unknown) => {
    const id = str(v) ?? '';
    const bare = id.startsWith(':') ? id.slice(1) : id;
    return known.has(bare) ? bare : id;
  };
  const supported = list(raw.supported_claims ?? raw['supported-claims']).map((e) => {
    const notes = str(e.notes ?? e.note)?.trim();
    return {
      claimId: resolve(e.claim_id ?? e['claim-id']),
      supportLevel: validatedEnum(
        e.support ?? e.support_level ?? e['support-level'],
        supportLevels,
        'support',
      ),
      chunkIds: (Array.isArray(e.chunk_ids ?? e['chunk-ids'])
        ? ((e.chunk_ids ?? e['chunk-ids']) as unknown[])
        : []
      ).map(String),
      ...(notes ? { notes } : {}),
    };
  });
  const gaps = list(raw.remaining_gaps ?? raw['remaining-gaps']).map((e) => {
    const claimId = resolve(e.claim_id ?? e['claim-id']);
    const spec = plan?.requiredClaims.find((c) => c.claimId === claimId);
    return {
      claimId,
      reason: validatedEnum(e.reason ?? 'not-addressed', gapReasons, 'reason'),
      critical: Boolean(e.critical ?? e['critical?'] ?? spec?.critical),
    };
  });
  const contradictions = list(raw.contradictions).map((e) => {
    const claimId = e.claim_id ?? e['claim-id'];
    const summary = str(e.summary ?? e.notes)?.trim();
    return {
      ...(claimId === undefined || claimId === null ? {} : { claimId: resolve(claimId) }),
      chunkIds: (Array.isArray(e.chunk_ids ?? e['chunk-ids'])
        ? ((e.chunk_ids ?? e['chunk-ids']) as unknown[])
        : []
      ).map(String),
      ...(summary ? { summary } : {}),
    };
  });
  return {
    status: validatedEnum(raw.status, statuses, 'status'),
    scopeAssessment: validatedEnum(raw.scope_assessment, scopes, 'scope_assessment'),
    supportedClaims: supported,
    partialClaims: supported.filter((c) => c.supportLevel === 'partial'),
    remainingGaps: gaps,
    contradictions,
    nextActionHint: validatedEnum(raw.next_action_hint, hints, 'next_action_hint'),
    confidence: clampConfidence(raw.confidence),
    degraded: false,
    evaluationMode: 'llm',
  };
};

export const evaluateRead = (o: {
  query: string;
  intent: QueryIntent;
  plan: EvidencePlan | undefined;
  openClaims: (RequiredClaim | OpenGap)[];
  chunks: Chunk[];
  llm: Evaluator;
  signal: AbortSignal;
}): Promise<ReadSignal> =>
  structuredEvaluate({
    llm: o.llm,
    system: readEvaluatorSystemPrompt,
    user: buildReadEvaluatorPrompt(o.query, o.intent, o.plan, o.openClaims, o.chunks),
    normalize: (parsed) => normalizeReadSignal(parsed, o.plan),
    fallback: () => fallbackReadSignal(o.plan),
    signal: o.signal,
  });
