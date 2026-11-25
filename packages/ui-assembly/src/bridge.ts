import {
  bridgeEventNames,
  bridgeLimits,
  parseFrameMessage,
  themeTokens,
  themeValue,
  type FrameMessage,
  type RenderMessage,
} from '@genai/contracts/block-bridge';
import type { BlockData } from '@genai/contracts/block-fields';
import type { BlockEvent } from '@genai/contracts/blocks';

export interface BlockEventHandlers {
  onAsk?: ((question: string) => void) | undefined;
  onOpenDocument?: ((index: number) => void) | undefined;
  onSetFilter?: ((field: string, values: string[]) => void) | undefined;
  onOpenPage?: ((page: string) => void) | undefined;
}

export interface FrameHello {
  source: unknown;
  origin: string;
  data: unknown;
  ports?: readonly unknown[];
}

export interface BridgePort {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** The private channel a frame's runtime hands over in its first message, from that frame only. */
export const helloPort = (event: FrameHello, frame: unknown): BridgePort | undefined => {
  if (!frame || event.source !== frame || event.origin !== 'null') return undefined;
  if (parseFrameMessage(event.data)?.type !== 'ready') return undefined;
  const port = event.ports?.length === 1 ? event.ports[0] : undefined;
  return port && typeof (port as BridgePort).postMessage === 'function'
    ? (port as BridgePort)
    : undefined;
};

/** Lets through only well-formed messages within their rate and size limits; resizes have their own rate. */
export const frameGate = (options: { events: readonly BlockEvent[]; now?: () => number }) => {
  const allowed = bridgeEventNames(options.events);
  const now = options.now ?? (() => Date.now());
  const windows = {
    resize: { start: Number.NEGATIVE_INFINITY, count: 0 },
    other: { start: Number.NEGATIVE_INFINITY, count: 0 },
  };
  const last = new Map<string, number>();
  return (data: unknown): FrameMessage | undefined => {
    const at = now();
    const isResize =
      typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'resize';
    const bucket = isResize ? windows.resize : windows.other;
    if (at - bucket.start >= 1_000) {
      bucket.start = at;
      bucket.count = 0;
    }
    bucket.count += 1;
    if (bucket.count > bridgeLimits.messagesPerSecond) return undefined;
    const message = parseFrameMessage(data);
    if (!message || message.type === 'ready') return undefined;
    if (bytesOf(JSON.stringify(message)) > bridgeLimits.frameMessageBytes) return undefined;
    if (message.type !== 'event') return message;
    if (!allowed.has(message.name)) return undefined;
    if (message.name === 'notify' || message.name === 'ask') {
      if (at - (last.get(message.name) ?? Number.NEGATIVE_INFINITY) < bridgeLimits.notifyEveryMs)
        return undefined;
      last.set(message.name, at);
    }
    return message;
  };
};

/** Sends an event on to the host, only within the data the block was given. */
export const dispatchEvent = (
  message: Extract<FrameMessage, { type: 'event' }>,
  data: BlockData,
  handlers: BlockEventHandlers,
) => {
  switch (message.name) {
    case 'ask':
      handlers.onAsk?.(message.payload.question);
      return;
    case 'open-document':
      if ((data.sources ?? []).some((s) => s.index === message.payload.source))
        handlers.onOpenDocument?.(message.payload.source);
      return;
    case 'set-filter':
      handlers.onSetFilter?.(message.payload.field, message.payload.values);
      return;
    case 'open-page':
      handlers.onOpenPage?.(message.payload.page);
      return;
    default:
      return;
  }
};

/** The Designsystemet tokens on the frame's element, so the block can follow the host's theme. */
export const themeOf = (element: Element | null): Record<string, string> => {
  if (!element || typeof getComputedStyle !== 'function') return {};
  const style = getComputedStyle(element);
  const theme: Record<string, string> = {};
  for (const token of themeTokens) {
    const value = style.getPropertyValue(token).trim();
    if (value && themeValue.test(value)) theme[token] = value;
  }
  return theme;
};

const sizeOf = (message: RenderMessage) => bytesOf(JSON.stringify(message));

/** A render message within its size limit: lists halved, then the answer's text cut. */
export const fitRender = (message: RenderMessage): RenderMessage => {
  let fitted = message;
  for (let round = 0; round < 12 && sizeOf(fitted) > bridgeLimits.renderMessageBytes; round++) {
    const data = { ...fitted.data };
    if (data.sources?.length) data.sources = data.sources.slice(0, data.sources.length >> 1);
    else if (data.threads?.length) data.threads = data.threads.slice(0, data.threads.length >> 1);
    else if (data.answer?.text)
      data.answer = {
        ...data.answer,
        text: data.answer.text.slice(0, data.answer.text.length >> 1),
      };
    else if (data.question?.text)
      data.question = { text: data.question.text.slice(0, data.question.text.length >> 1) };
    else break;
    fitted = { ...fitted, data };
  }
  return fitted;
};
