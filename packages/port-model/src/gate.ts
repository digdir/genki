import {
  chatShape,
  createGate,
  decideShape,
  type Gate,
  type GatePayload,
  type GateRefusal,
  type PortContext,
  type Shape,
} from '@genai/kernel';
import type { DecisionPort, DecisionResult } from './decision.js';
import { ModelError, type ChatResult, type ModelPort } from './port.js';

export const chatPayload = (continuations: readonly Shape[] = []): GatePayload<ChatResult> => ({
  shape: chatShape(continuations),
});

export const decidePayload: GatePayload<DecisionResult> = {
  shape: decideShape,
  usage: (result) => result.usage,
  dropped: (result) => result.dropped,
};

const refusalCodes: Record<GateRefusal, ModelError['code']> = {
  admission: 'unauthorized',
  disabled: 'bad_request',
  'not-shared': 'bad_request',
  residency: 'residency',
  media: 'refused',
  shape: 'bad_request',
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
    chat: (request) => gate.call(ctx, target, chatPayload(), request, (r) => port.chat(r)),
    chatStream: (request) =>
      gate.stream(ctx, target, chatPayload(), request, (r) => port.chatStream(r)),
  };
};

/** Puts a decision port that did not come from the router, such as a fake, behind a gate. */
export const gatedDecision = (
  port: DecisionPort,
  ctx: PortContext,
  gate: Gate = createGate(),
): DecisionPort => {
  const info = port.info();
  const target = {
    port: 'decision',
    operation: 'decide',
    model: { kind: 'model', id: info.id },
    residency: info.residency,
    admission: 'admitted' as const,
    refuse: modelRefusal,
  };
  return {
    info: () => port.info(),
    decide: (request) => gate.call(ctx, target, decidePayload, request, (r) => port.decide(r)),
  };
};
