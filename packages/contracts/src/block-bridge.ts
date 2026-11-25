import type { BlockData } from './block-fields.js';
import type { BlockEvent, BlockState } from './blocks.js';

export const bridgeLimits = {
  frameMessageBytes: 8 * 1024,
  renderMessageBytes: 64 * 1024,
  messagesPerSecond: 20,
  notifyEveryMs: 1_000,
  readyWithinMs: 5_000,
  maxHeight: 2_000,
  defaultHeight: 120,
  question: 2_000,
  notify: 200,
  filterField: 64,
  filterValues: 50,
  filterValue: 200,
  page: 64,
} as const;

export const themeValue = /^[#(),.%\sa-zA-Z0-9-]{1,64}$/;

export const themeTokens = [
  '--ds-color-neutral-background-default',
  '--ds-color-neutral-background-tinted',
  '--ds-color-neutral-surface-default',
  '--ds-color-neutral-surface-tinted',
  '--ds-color-neutral-border-default',
  '--ds-color-neutral-border-subtle',
  '--ds-color-neutral-text-default',
  '--ds-color-neutral-text-subtle',
  '--ds-color-accent-background-default',
  '--ds-color-accent-surface-default',
  '--ds-color-accent-surface-tinted',
  '--ds-color-accent-border-default',
  '--ds-color-accent-base-default',
  '--ds-color-accent-base-contrast-default',
  '--ds-color-accent-text-default',
  '--ds-color-accent-text-subtle',
  '--ds-color-danger-text-default',
  '--ds-color-success-text-default',
  '--ds-color-warning-text-default',
  '--ds-color-info-text-default',
  '--ds-color-focus-inner',
  '--ds-color-focus-outer',
  '--ds-border-radius-sm',
  '--ds-border-radius-md',
  '--ds-border-radius-lg',
  '--ds-border-width-default',
  '--ds-size-1',
  '--ds-size-2',
  '--ds-size-3',
  '--ds-size-4',
  '--ds-size-6',
  '--ds-size-8',
  '--ds-font-family',
  '--ds-body-sm-font-size',
  '--ds-body-md-font-size',
  '--ds-body-lg-font-size',
  '--ds-heading-xs-font-size',
  '--ds-heading-sm-font-size',
  '--ds-heading-md-font-size',
  '--ds-shadow-sm',
] as const;

export interface RenderMessage {
  genki: 1;
  type: 'render';
  state: BlockState;
  locale: 'nb' | 'nn' | 'en';
  colorScheme: 'light' | 'dark';
  theme: Record<string, string>;
  props: Record<string, boolean | string>;
  texts: Record<string, string>;
  data: BlockData;
}

export type BridgeEvent =
  | { name: 'ask'; payload: { question: string } }
  | { name: 'open-document'; payload: { source: number } }
  | { name: 'set-filter'; payload: { field: string; values: string[] } }
  | { name: 'open-page'; payload: { page: string } }
  | { name: 'notify'; payload: { text: string } };

export type FrameMessage =
  | { genki: 1; type: 'ready' }
  | { genki: 1; type: 'resize'; height: number }
  | ({ genki: 1; type: 'event' } & BridgeEvent);

type Tree = Record<string, unknown>;

const isPlain = (value: unknown): value is Tree =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const onlyKeys = (value: Tree, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

const payloadOf = (name: unknown, payload: unknown): BridgeEvent | undefined => {
  if (!isPlain(payload)) return undefined;
  switch (name) {
    case 'ask':
      return onlyKeys(payload, ['question']) &&
        text(payload.question, bridgeLimits.question) &&
        payload.question.trim().length > 0
        ? { name, payload: { question: payload.question } }
        : undefined;
    case 'open-document':
      return onlyKeys(payload, ['source']) &&
        Number.isInteger(payload.source) &&
        (payload.source as number) >= 0
        ? { name, payload: { source: payload.source as number } }
        : undefined;
    case 'set-filter': {
      const { field, values } = payload;
      return onlyKeys(payload, ['field', 'values']) &&
        text(field, bridgeLimits.filterField) &&
        Array.isArray(values) &&
        values.length <= bridgeLimits.filterValues &&
        values.every((v) => text(v, bridgeLimits.filterValue))
        ? { name, payload: { field, values: [...(values as string[])] } }
        : undefined;
    }
    case 'open-page':
      return onlyKeys(payload, ['page']) && text(payload.page, bridgeLimits.page)
        ? { name, payload: { page: payload.page } }
        : undefined;
    case 'notify':
      return onlyKeys(payload, ['text']) && text(payload.text, bridgeLimits.notify)
        ? { name, payload: { text: payload.text } }
        : undefined;
    default:
      return undefined;
  }
};

/** A message from a block's frame in the bridge's shape, or undefined for anything else. */
export const parseFrameMessage = (value: unknown): FrameMessage | undefined => {
  if (!isPlain(value) || value.genki !== 1) return undefined;
  if (value.type === 'ready')
    return onlyKeys(value, ['genki', 'type']) ? { genki: 1, type: 'ready' } : undefined;
  if (value.type === 'resize') {
    const { height } = value;
    return onlyKeys(value, ['genki', 'type', 'height']) &&
      Number.isInteger(height) &&
      (height as number) >= 0 &&
      (height as number) <= bridgeLimits.maxHeight
      ? { genki: 1, type: 'resize', height: height as number }
      : undefined;
  }
  if (value.type !== 'event' || !onlyKeys(value, ['genki', 'type', 'name', 'payload']))
    return undefined;
  const event = payloadOf(value.name, value.payload);
  return event && { genki: 1, type: 'event', ...event };
};

export const bridgeEventNames = (events: readonly BlockEvent[]) =>
  new Set(events.filter((e) => e !== 'resize'));
