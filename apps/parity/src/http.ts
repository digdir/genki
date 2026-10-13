import type { Captured, JsonValue, Request, SseFrame, Target } from './types.js';

const keptHeaders = [
  'content-type',
  'cache-control',
  'x-accel-buffering',
  'allow',
  'retry-after',
  'www-authenticate',
  'genai-task',
];

const parseJson = (text: string): JsonValue | string => {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
};

export const parseSse = (text: string): SseFrame[] =>
  text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block): SseFrame => {
      const lines = block.split(/\r?\n/);
      if (lines.every((l) => l.startsWith(':'))) {
        return { kind: 'comment', text: lines.map((l) => l.slice(1).trim()).join('\n') };
      }
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      return { kind: 'data', data: parseJson(data) };
    });

export const send = async (target: Target, request: Request): Promise<Captured> => {
  const headers: Record<string, string> = { ...request.headers };
  if (request.body !== undefined) headers['content-type'] ??= 'application/json';
  if (request.auth !== false && target.apiKey) headers['x-api-key'] = target.apiKey;

  const response = await fetch(new URL(request.path, target.baseUrl), {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });

  const kept: Record<string, string> = {};
  for (const name of keptHeaders) {
    const value = response.headers.get(name);
    if (value !== null) kept[name] = value;
  }
  const text = await response.text();
  const isStream = (kept['content-type'] ?? '').startsWith('text/event-stream');
  return {
    status: response.status,
    headers: kept,
    ...(isStream ? { frames: parseSse(text) } : text.length > 0 ? { body: parseJson(text) } : {}),
  };
};
