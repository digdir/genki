import type { BlockEvent, BlockState, BlockZone } from '@genai/contracts/blocks';

export const bundlePath = 'block/bundle.js';
export const sourcePrefix = 'block/source/';

export interface BlockDraft {
  apiVersion: 'genai/v1';
  kind: 'Block';
  metadata: { tenant: string; id: string; name?: string };
  spec: {
    tier: 'built-in' | 'declarative' | 'code';
    builtIn?: string;
    title: { nb?: string; en?: string; nn?: string };
    zones: BlockZone[];
    sharing?: 'private' | 'organisation' | 'everyone';
    events?: BlockEvent[];
    states?: BlockState[];
    props?: { properties?: Record<string, { title?: string }> };
    texts?: Partial<Record<'nb' | 'nn' | 'en', Record<string, string>>>;
    template?: Record<string, unknown>;
    code?: { sha256: string; bytes: number; reads: string[]; height?: number };
  };
}

export const asBlockDraft = (definition: Record<string, unknown>) =>
  definition as unknown as BlockDraft;

/** The first edition of a designelement without code: a card with the person's question. */
export const starterDeclarative = (tenant: string, id: string, name: string): BlockDraft => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant, id, name },
  spec: {
    tier: 'declarative',
    title: { nb: name },
    zones: ['main'],
    sharing: 'organisation',
    events: [],
    states: ['filled'],
    texts: { nb: { question: 'Spørsmålet ditt:' }, en: { question: 'Your question:' } },
    template: {
      version: 1,
      root: {
        type: 'card',
        children: [
          { type: 'paragraph', text: [{ t: 'question' }, ' ', { bind: 'question.text' }] },
        ],
      },
    },
  },
});

export interface Bundle {
  text: string;
  bytes: number;
  sha256: string;
}

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

export const bundleOf = async (text: string): Promise<Bundle> => {
  const data = new TextEncoder().encode(text);
  return { text, bytes: data.length, sha256: hex(await crypto.subtle.digest('SHA-256', data)) };
};

export const codeDefinition = (
  tenant: string,
  id: string,
  name: string,
  bundle: Bundle,
): BlockDraft => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant, id, name },
  spec: {
    tier: 'code',
    title: { nb: name },
    zones: ['main'],
    sharing: 'organisation',
    events: [],
    states: ['filled'],
    code: { sha256: bundle.sha256, bytes: bundle.bytes, reads: [] },
  },
});

/** The event names a template sends, in the order first met. */
export const templateEvents = (template: unknown): BlockEvent[] => {
  const found = new Set<BlockEvent>();
  const stack: unknown[] = [template];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (node && typeof node === 'object') {
      const event = (node as { event?: { name?: unknown } }).event;
      if (event && typeof event.name === 'string') found.add(event.name as BlockEvent);
      stack.push(...Object.values(node));
    }
  }
  return [...found];
};

/** The text keys a template uses; a key with a count is the keys of its plural forms. */
export const templateTextKeys = (template: unknown): string[] => {
  const found = new Set<string>();
  const stack: unknown[] = [template];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (node && typeof node === 'object') {
      const part = node as { t?: unknown; args?: Record<string, unknown> };
      if (typeof part.t === 'string') {
        if (part.args && 'count' in part.args) {
          found.add(`${part.t}.one`);
          found.add(`${part.t}.other`);
        } else found.add(part.t);
      }
      stack.push(...Object.values(node));
    }
  }
  return [...found].sort();
};

/** The states a template draws: «Med svar» and each state it has its own branch for. */
export const templateStates = (template: unknown, declared: readonly BlockState[] = []) => {
  const branches =
    template && typeof template === 'object'
      ? Object.keys((template as { states?: Record<string, unknown> }).states ?? {})
      : [];
  return [...new Set<BlockState>(['filled', ...declared, ...(branches as BlockState[])])];
};
