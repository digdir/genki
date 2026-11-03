import {
  createGate,
  type Gate,
  type GatePayload,
  type GateRefusal,
  type PortContext,
} from '@genai/kernel';
import {
  ModelError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
} from './port.js';

const mapMessage = (m: ChatMessage, map: (text: string) => string): ChatMessage => {
  if (typeof m.content !== 'string') return m;
  if (m.role === 'assistant')
    return {
      ...m,
      content: map(m.content),
      ...(m.toolCalls
        ? { toolCalls: m.toolCalls.map((c) => ({ ...c, arguments: map(c.arguments) })) }
        : {}),
    };
  return { ...m, content: map(m.content) };
};

export const chatPayload: GatePayload<ChatRequest, ChatResult> = {
  contents: (request) => request.messages.map((m) => m.content as unknown),
  mapRequest: (request, map) => ({
    ...request,
    messages: request.messages.map((m) => mapMessage(m, map)),
  }),
  mapResult: (result, map) => ({
    ...result,
    content: map(result.content),
    toolCalls: result.toolCalls.map((c) => ({ ...c, arguments: map(c.arguments) })),
  }),
};

const refusalCodes: Record<GateRefusal, ModelError['code']> = {
  admission: 'unauthorized',
  disabled: 'bad_request',
  'not-shared': 'bad_request',
  residency: 'residency',
  media: 'refused',
};

export const modelRefusal = (refusal: GateRefusal, message: string) =>
  new ModelError(refusalCodes[refusal], message);

/** Puts a model port that did not come from the router, such as a fake, behind a gate. */
export const gatedModel = (
  port: ModelPort,
  ctx: PortContext,
  gate: Gate = createGate(),
): ModelPort => {
  const info = port.info();
  const target = {
    port: 'model',
    operation: 'chat',
    model: { kind: 'model', id: info.id },
    residency: info.residency,
    admission: 'admitted' as const,
    refuse: modelRefusal,
  };
  return {
    info: () => port.info(),
    chat: (request) => gate.call(ctx, target, chatPayload, request, (r) => port.chat(r)),
    chatStream: (request) =>
      gate.stream(ctx, target, chatPayload, request, (r) => port.chatStream(r)),
  };
};
