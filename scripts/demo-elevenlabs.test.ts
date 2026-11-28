import { describe, expect, it } from 'vitest';
import { demoVoiceOf, type DemoVoice } from '../packages/contracts/src/demo-voices.ts';
import {
  elevenLabsKeyOf,
  elevenLabsRead,
  elevenLabsRequest,
  keyVaultSecretUrl,
  secretFromKeyVault,
} from './demo-elevenlabs.ts';

const film = demoVoiceOf('elevenlabs-film') as DemoVoice;
const secret = 'https://genki-test-kv.vault.azure.net/secrets/elevenlabs-key';
const key = 'sk_0123456789abcdef0123456789abcdef0123456789abcdef';

const vault = (calls: { url: string; auth?: string | null }[]) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
    });
    return Response.json({ value: key });
  }) as typeof fetch;

describe('the ElevenLabs voice', () => {
  it('reads its key from Key Vault with the recorder token, once per run', async () => {
    const calls: { url: string; auth?: string | null }[] = [];
    const keyOf = elevenLabsKeyOf(
      { DEMO_ELEVENLABS_KEY_SECRET: secret },
      () => Promise.resolve('vault-token'),
      vault(calls),
    );
    expect(await keyOf()).toBe(key);
    expect(await keyOf()).toBe(key);
    expect(calls).toEqual([{ url: `${secret}?api-version=7.4`, auth: 'Bearer vault-token' }]);
  });

  it('reads the key again after a failed Key Vault read instead of keeping the failure for the run', async () => {
    const calls: { url: string; auth?: string | null }[] = [];
    let tokens = 0;
    const keyOf = elevenLabsKeyOf(
      { DEMO_ELEVENLABS_KEY_SECRET: secret },
      () => (tokens++ === 0 ? Promise.reject(new Error('identity down')) : Promise.resolve('t')),
      vault(calls),
    );
    await expect(keyOf()).rejects.toThrow(/identity down/);
    expect(await keyOf()).toBe(key);
  });

  it('never takes the key from the environment, only the name of its Key Vault secret', async () => {
    const keyOf = elevenLabsKeyOf(
      { ELEVENLABS_API_KEY: key, XI_API_KEY: key },
      () => Promise.resolve('t'),
      vault([]),
    );
    await expect(keyOf()).rejects.toThrow(/DEMO_ELEVENLABS_KEY_SECRET/);
  });

  it('sends the vault token only to an https Key Vault secret', () => {
    expect(keyVaultSecretUrl(`${secret}/0123456789abcdef0123456789abcdef`)).toBe(
      `${secret}/0123456789abcdef0123456789abcdef?api-version=7.4`,
    );
    for (const bad of [
      'http://genki-test-kv.vault.azure.net/secrets/k',
      'https://evil.example/secrets/k',
      'https://genki-test-kv.vault.azure.net.evil.example/secrets/k',
      'https://genki-test-kv.vault.azure.net/keys/k',
      'https://genki-test-kv.vault.azure.net/secrets/../keys/k',
      'https://user@genki-test-kv.vault.azure.net/secrets/k',
      'https://genki-test-kv.vault.azure.net:8443/secrets/k',
      'https://genki-test-kv.vault.azure.net/secrets/k?api-version=1',
      'not a url',
    ])
      expect(() => keyVaultSecretUrl(bad), bad).toThrow(/DEMO_ELEVENLABS_KEY_SECRET/);
  });

  it('says what failed without the key or the vault answer', async () => {
    const denied = (async () =>
      new Response(`{"error":"${key}"}`, { status: 403 })) as typeof fetch;
    const error = await secretFromKeyVault(secret, () => Promise.resolve('t'), denied).catch(
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe('Key Vault answered 403 for the ElevenLabs key');
    const refused = (async () => new Response(key, { status: 401 })) as typeof fetch;
    const read = await elevenLabsRead('Hei', film, () => Promise.resolve(key), refused).catch(
      (e: unknown) => e as Error,
    );
    expect(read.message).toBe('ElevenLabs answered 401');
    expect(read.message).not.toContain(key);
  });

  it('asks for the line in the voice and model of the voice list, in Norwegian, with the key as a header', async () => {
    const sent: { url: string; headers: Headers; body: unknown }[] = [];
    const send = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(new Uint8Array([0xff, 0xfb, 3]));
    }) as typeof fetch;
    const audio = await elevenLabsRead('Genn-ki er her.', film, () => Promise.resolve(key), send);
    expect([...audio]).toEqual([0xff, 0xfb, 3]);
    expect(sent[0]?.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/SAa140Q9akujSiZCBSNt?output_format=mp3_44100_128',
    );
    expect(sent[0]?.headers.get('xi-api-key')).toBe(key);
    expect(sent[0]?.body).toMatchObject({
      text: 'Genn-ki er her.',
      model_id: 'eleven_v4',
      language_code: 'no',
    });
    expect(sent[0]?.url).not.toContain(key);
  });

  it('takes only an mp3 of at most 2 MiB back from ElevenLabs', async () => {
    const answer = (body: Uint8Array) => (async () => new Response(body)) as typeof fetch;
    const key = () => Promise.resolve('k');
    await expect(
      elevenLabsRead('Hei', film, key, answer(new TextEncoder().encode('<html>'))),
    ).rejects.toThrow(/other than mp3/);
    await expect(
      elevenLabsRead('Hei', film, key, answer(new Uint8Array(3 * 1024 * 1024).fill(0xff))),
    ).rejects.toThrow(/more than/);
  });

  it('refuses a voice without a plain ElevenLabs voice id, so the id cannot change the address', () => {
    expect(() => elevenLabsRequest('x', { ...film, providerVoice: '../voices' })).toThrow(
      /no ElevenLabs voice id/,
    );
    expect(() => elevenLabsRequest('x', { ...film, providerVoice: undefined })).toThrow();
  });
});
