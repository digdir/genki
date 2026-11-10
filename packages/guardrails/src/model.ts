import type { Masker, PayloadGuard } from '@genai/kernel';
import type { ChatMessage, ChatRequest, ChatResult } from '@genai/port-model';
import type { PiiVault } from './pii.js';

export interface ModelGuard {
  vault?: PiiVault;
  restore?: boolean;
  instruction?: string;
  onServed?: (model: string) => void;
}

const withInstruction = (messages: ChatMessage[], instruction: string): ChatMessage[] => {
  const first = messages[0];
  if (first?.role === 'system')
    return [{ ...first, content: `${first.content}\n\n${instruction}` }, ...messages.slice(1)];
  return [{ role: 'system', content: instruction }, ...messages];
};

const pendingToken = (text: string) => {
  const open = text.lastIndexOf('«');
  return open >= 0 && text.indexOf('»', open) < 0 && text.length - open < 40
    ? text.length - open
    : 0;
};

const maskers = new WeakMap<PiiVault, Map<boolean, Masker>>();

export const vaultMasker = (vault: PiiVault, restore = true): Masker => {
  const known = maskers.get(vault) ?? new Map<boolean, Masker>();
  maskers.set(vault, known);
  const masker = known.get(restore) ?? {
    mask: (text: string) => vault.mask(text),
    ...(restore ? { unmask: (text: string) => vault.unmask(text), pending: pendingToken } : {}),
  };
  known.set(restore, masker);
  return masker;
};

export const modelGuard = (guard: ModelGuard): PayloadGuard => ({
  ...(guard.vault ? { masker: vaultMasker(guard.vault, guard.restore !== false) } : {}),
  request: (call, body) => {
    if (call.port !== 'model') return body;
    const { purpose, ...request } = body as ChatRequest;
    return guard.instruction && purpose === 'answer'
      ? { ...request, messages: withInstruction(request.messages, guard.instruction) }
      : request;
  },
  result: (call, body) => {
    if (call.port === 'model') guard.onServed?.((body as ChatResult).servedModel);
  },
});
