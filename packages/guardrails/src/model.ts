import type { ChatChunk, ChatMessage, ChatRequest, ChatResult, ModelPort } from '@genai/port-model';
import type { PiiVault } from './pii.js';

export interface ModelGuard {
  vault?: PiiVault;
  restore?: boolean;
  instruction?: string;
  onServed?: (model: string) => void;
}

const maskMessage = (vault: PiiVault, m: ChatMessage): ChatMessage => {
  if (m.role === 'assistant')
    return {
      ...m,
      content: vault.mask(m.content),
      ...(m.toolCalls
        ? { toolCalls: m.toolCalls.map((c) => ({ ...c, arguments: vault.mask(c.arguments) })) }
        : {}),
    };
  return { ...m, content: vault.mask(m.content) };
};

const withInstruction = (messages: ChatMessage[], instruction: string): ChatMessage[] => {
  const first = messages[0];
  if (first?.role === 'system')
    return [{ ...first, content: `${first.content}\n\n${instruction}` }, ...messages.slice(1)];
  return [{ role: 'system', content: instruction }, ...messages];
};

export const guardModel = (port: ModelPort, guard: ModelGuard): ModelPort => {
  const prepare = ({ purpose, ...request }: ChatRequest): ChatRequest => {
    const masked = guard.vault
      ? request.messages.map((m) => maskMessage(guard.vault as PiiVault, m))
      : request.messages;
    return {
      ...request,
      messages:
        guard.instruction && purpose === 'answer'
          ? withInstruction(masked, guard.instruction)
          : masked,
    };
  };
  const restore = (text: string) =>
    guard.vault && guard.restore !== false ? guard.vault.unmask(text) : text;
  const finish = (result: ChatResult): ChatResult => {
    guard.onServed?.(result.servedModel);
    return {
      ...result,
      content: restore(result.content),
      toolCalls: result.toolCalls.map((c) => ({ ...c, arguments: restore(c.arguments) })),
    };
  };

  return {
    info: () => port.info(),
    chat: async (request) => finish(await port.chat(prepare(request))),
    chatStream: async function* (request): AsyncIterable<ChatChunk> {
      let carry = '';
      for await (const chunk of port.chatStream(prepare(request))) {
        if (chunk.kind === 'done') {
          if (carry) yield { kind: 'delta', text: restore(carry) };
          yield { kind: 'done', result: finish(chunk.result) };
          return;
        }
        const text = carry + chunk.text;
        const open = text.lastIndexOf('«');
        const pending = open >= 0 && text.indexOf('»', open) < 0 && text.length - open < 40;
        carry = pending ? text.slice(open) : '';
        const ready = pending ? text.slice(0, open) : text;
        if (ready) yield { kind: 'delta', text: restore(ready) };
      }
    },
  };
};
