import type { ModelDescription } from '@genai/port-model';

export interface Operator {
  name: string;
  region?: string;
}

export interface ConnectionFacts {
  baseURL?: string;
  gateway?: boolean;
}

interface Named {
  family?: string | undefined;
  deployment?: string | undefined;
  maker?: string | undefined;
  operator?: Operator | undefined;
}

export interface ModelIdentity {
  maker?: string;
  operator?: Operator;
  gateway?: true;
}

const makers: readonly [RegExp, string][] = [
  [/^(gpt|chatgpt|o\d|dall-e|whisper|tts-|text-embedding|sora)/, 'OpenAI'],
  [/^claude/, 'Anthropic'],
  [/^(meta-llama|llama)/, 'Meta'],
  [/^qwen/, 'Alibaba'],
  [/^(mistral|mixtral|magistral|ministral|codestral|devstral|pixtral)/, 'Mistral AI'],
  [/^(gemma|gemini)/, 'Google'],
  [/^deepseek/, 'DeepSeek'],
  [/^phi-?\d/, 'Microsoft'],
  [/^grok/, 'xAI'],
  [/^(borealis|normistral|nb-)/, 'NbAiLab'],
];

const gatewayHosts: Readonly<Record<string, Operator>> = {
  aivar: { name: 'Digdir', region: 'Leikanger' },
  sigma2: { name: 'Sigma2' },
};

const connectionHosts: readonly [RegExp, string][] = [
  [/\.(openai|services\.ai|cognitiveservices|models\.ai)\.azure\.com$/, 'Azure AI Foundry'],
  [/^api\.openai\.com$/, 'OpenAI'],
  [/^api\.anthropic\.com$/, 'Anthropic'],
];

const hostPrefix = (deployment: string) => {
  const at = deployment.indexOf(':');
  const prefix = at > 0 ? deployment.slice(0, at).toLowerCase() : undefined;
  return prefix && Object.hasOwn(gatewayHosts, prefix) ? prefix : undefined;
};

const withoutHost = (deployment: string) =>
  hostPrefix(deployment) ? deployment.slice(deployment.indexOf(':') + 1) : deployment;

const lastSegment = (name: string) => name.slice(name.lastIndexOf('/') + 1);

const acronyms: ReadonlySet<string> = new Set(['gpt', 'oss', 'tts', 'ai', 'llm', 'vl']);

const isSize = (token: string) => /^\d+(\.\d+)?(x\d+)?[bkm]$/i.test(token);
const isShortNumber = (token: string) => /^\d{1,2}$/.test(token);
const isDate = (tokens: string[], i: number) =>
  /^20\d{6}$/.test(tokens[i] ?? '') ||
  (/^20\d{2}$/.test(tokens[i] ?? '') &&
    /^\d{2}$/.test(tokens[i + 1] ?? '') &&
    /^\d{2}$/.test(tokens[i + 2] ?? ''));
const wordAndNumber = /^([a-z]{4,})(\d+(\.\d+)?)$/i;

const word = (token: string): string => {
  const lower = token.toLowerCase();
  if (acronyms.has(lower)) return token.toUpperCase();
  if (isSize(token)) return token.toUpperCase();
  const split = wordAndNumber.exec(token);
  if (split) return `${word(split[1] ?? '')} ${split[2] ?? ''}`;
  return /^[a-z]{2}/.test(token) ? token.charAt(0).toUpperCase() + token.slice(1) : token;
};

/** A name for people from a model or deployment name, such as GPT-6 Luna for gpt-6-luna. */
export const readableModelName = (raw: string) => {
  const tokens = lastSegment(withoutHost(raw.trim()))
    .split(/[-_:\s]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isDate(tokens, i)) {
      if (/^20\d{2}$/.test(tokens[i] ?? '')) i += 2;
      continue;
    }
    const token = tokens[i] ?? '';
    const previous = tokens[i - 1];
    if (isShortNumber(token) && previous !== undefined && isShortNumber(previous)) {
      out[out.length - 1] = `${out[out.length - 1]}.${token}`;
      continue;
    }
    if (previous?.toLowerCase() === 'gpt' && /^\d/.test(token)) {
      out[out.length - 1] = `GPT-${token}`;
      continue;
    }
    out.push(word(token));
  }
  return out.join(' ');
};

export const nameSource = (m: Pick<ModelDescription, 'id' | 'family' | 'deployment'>) =>
  readableModelName(m.family ?? m.deployment ?? '') || m.id;

/** Who made a model, from the names its connection reports, when the catalogue does not say. */
export const makerOf = (m: Named) => {
  if (m.maker) return m.maker;
  const names = [m.family, m.deployment ? withoutHost(m.deployment) : undefined]
    .filter((n): n is string => !!n)
    .flatMap((n) => n.toLowerCase().split('/'));
  for (const name of names)
    for (const [pattern, maker] of makers) if (pattern.test(name)) return maker;
  return undefined;
};

const hostOfURL = (baseURL: string | undefined) => {
  if (!baseURL) return undefined;
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/** Who runs a model and where, and whether it is reached through the AI gateway. */
export const identityOf = (m: Named, connection: ConnectionFacts | undefined): ModelIdentity => {
  const maker = makerOf(m);
  const gateway = connection?.gateway === true;
  const prefix = gateway && m.deployment ? hostPrefix(m.deployment) : undefined;
  const host = prefix ? gatewayHosts[prefix] : undefined;
  const hostname = hostOfURL(connection?.baseURL);
  const fromURL = hostname
    ? connectionHosts.find(([pattern]) => pattern.test(hostname))?.[1]
    : undefined;
  const operator: Operator | undefined = host
    ? { name: host.name, ...(host.region ? { region: host.region } : {}) }
    : (m.operator ?? (fromURL ? { name: fromURL } : undefined));
  return {
    ...(maker ? { maker } : {}),
    ...(operator ? { operator } : {}),
    ...(gateway ? { gateway: true as const } : {}),
  };
};
