// The ElevenLabs voice: its key comes from Key Vault on the recorder's identity and lives only in memory.
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { DemoVoice } from '../packages/contracts/src/demo-voices.ts';
import { maxClipBytes, mp3Clip } from './demo-voice.ts';

const vaultResource = 'https://vault.azure.net';

export const keyVaultSecretUrl = (reference: string, setting = 'DEMO_ELEVENLABS_KEY_SECRET') => {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new Error(`${setting} must be a Key Vault secret URL`);
  }
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]{3,24}\.vault\.azure\.net$/.test(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/secrets\/[A-Za-z0-9-]{1,127}(\/[0-9a-f]{32})?$/.test(url.pathname)
  )
    throw new Error(`${setting} must be https://<vault>.vault.azure.net/secrets/<name>`);
  return `${url.origin}${url.pathname}?api-version=7.4`;
};

export const vaultToken = async (env: NodeJS.ProcessEnv, send: typeof fetch = fetch) => {
  if (env.IDENTITY_ENDPOINT) {
    const url = new URL(env.IDENTITY_ENDPOINT);
    url.searchParams.set('resource', vaultResource);
    url.searchParams.set('api-version', '2019-08-01');
    if (env.AZURE_CLIENT_ID) url.searchParams.set('client_id', env.AZURE_CLIENT_ID);
    const res = await send(url, { headers: { 'x-identity-header': env.IDENTITY_HEADER ?? '' } });
    if (!res.ok) throw new Error(`The managed identity answered ${res.status}`);
    return z.object({ access_token: z.string().min(1).max(8192) }).parse(await res.json())
      .access_token;
  }
  return execFileSync(
    'az',
    [
      'account',
      'get-access-token',
      '--resource',
      vaultResource,
      '--query',
      'accessToken',
      '-o',
      'tsv',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
};

export const secretFromKeyVault = async (
  reference: string,
  token: () => Promise<string>,
  send: typeof fetch = fetch,
  names: { setting: string; what: string } = {
    setting: 'DEMO_ELEVENLABS_KEY_SECRET',
    what: 'the ElevenLabs key',
  },
) => {
  const url = keyVaultSecretUrl(reference, names.setting);
  const res = await send(url, {
    headers: { authorization: `Bearer ${await token()}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Key Vault answered ${res.status} for ${names.what}`);
  const read = z.object({ value: z.string().max(512) }).safeParse(await res.json());
  if (!read.success || !read.data.value.trim())
    throw new Error(`${names.what[0]?.toUpperCase()}${names.what.slice(1)} in Key Vault is empty`);
  return read.data.value.trim();
};

export const elevenLabsKeyOf = (
  env: NodeJS.ProcessEnv,
  token: () => Promise<string> = () => vaultToken(env),
  send: typeof fetch = fetch,
) => {
  let key: Promise<string> | undefined;
  return () => {
    const reference = env.DEMO_ELEVENLABS_KEY_SECRET;
    if (!reference)
      return Promise.reject(
        new Error('Set DEMO_ELEVENLABS_KEY_SECRET to the Key Vault secret with the ElevenLabs key'),
      );
    return (key ??= secretFromKeyVault(reference, token, send).catch((error: unknown) => {
      key = undefined;
      throw error;
    }));
  };
};

const languageCodes: Record<DemoVoice['language'], string> = {
  'nb-NO': 'no',
  'en-GB': 'en',
  'en-US': 'en',
};

export const elevenLabsRequest = (text: string, voice: DemoVoice) => {
  if (!voice.providerVoice || !/^[A-Za-z0-9]{1,64}$/.test(voice.providerVoice))
    throw new Error(`The voice ${voice.id} has no ElevenLabs voice id`);
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voice.providerVoice}?output_format=mp3_44100_128`,
    body: {
      text,
      model_id: voice.model ?? 'eleven_multilingual_v2',
      language_code: languageCodes[voice.language],
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      },
    },
  };
};

export const elevenLabsRead = async (
  text: string,
  voice: DemoVoice,
  key: () => Promise<string>,
  send: typeof fetch = fetch,
) => {
  const { url, body } = elevenLabsRequest(text, voice);
  const res = await send(url, {
    method: 'POST',
    headers: { 'xi-api-key': await key(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > maxClipBytes)
    throw new Error(`ElevenLabs answered with more than ${maxClipBytes} bytes`);
  return mp3Clip(Buffer.from(await res.arrayBuffer()), 'ElevenLabs');
};
