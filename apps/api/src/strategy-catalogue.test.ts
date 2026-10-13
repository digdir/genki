import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '@genai/contracts';
import { strategyCatalogue, type StrategyEntry } from './strategy-catalogue.js';
import { bootPlatform, digdir } from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
};

const path = `/tenants/${digdir}/definitions/strategies`;

const listed = async () => {
  const { send } = await bootPlatform({ people });
  const res = await send(path, 'kari');
  return { status: res.status, body: (await res.json()) as { data: StrategyEntry[] } };
};

const portalMock = (file: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'portal', 'src', 'mock', file), 'utf8'),
  ) as unknown;

interface Listed {
  kind: string;
  uses: { kind: string; href: string }[];
}

describe('the strategy catalogue', () => {
  it('lists every strategy a service definition may use, and no platform-internal one', async () => {
    const { status, body } = await listed();

    expect(status).toBe(200);
    expect(body.data.map((s) => s.id).sort()).toEqual(
      ['agent-loop', 'rag-single-shot', 'remote-agent', 'single-call', 'step-flow'].sort(),
    );
  });

  it('names exactly one default strategy for each way of working', async () => {
    const { body } = await listed();
    const defaults = body.data.filter((s) => s.default).map((s) => [s.how, s.id]);

    expect(Object.fromEntries(defaults)).toEqual({
      single: 'single-call',
      agent: 'agent-loop',
      flow: 'step-flow',
    });
    expect(defaults).toHaveLength(3);
  });

  it('gives every text in bokmål and English', async () => {
    const { body } = await listed();
    const texts = body.data.flatMap((s) => [
      s.title,
      s.description,
      ...s.pipeline.flatMap((p) => [p.title, p.description]),
    ]);

    expect(texts.every((x) => x.nb.length > 0 && x.en.length > 0)).toBe(true);
  });

  it('reads from the config schema whether a strategy takes the instructions and examples', async () => {
    const { body } = await listed();
    const takes = Object.fromEntries(body.data.map((s) => [s.id, s.takes]));

    expect(takes['single-call']).toEqual({ instructions: 'required', examples: 'optional' });
    expect(takes['agent-loop']).toEqual({ instructions: 'optional', examples: 'no' });
    expect(takes['step-flow']).toEqual({ instructions: 'no', examples: 'no' });
  });

  it('starts an agent with eight rounds when a service switches to it', async () => {
    const { body } = await listed();

    expect(body.data.find((s) => s.id === 'agent-loop')?.newConfig).toEqual({ maxIterations: 8 });
  });

  it('links each strategy to its config schema under /schemas', async () => {
    const { send } = await bootPlatform({ people });
    const { body } = await listed();
    const single = body.data.find((s) => s.id === 'single-call');

    expect(single?.schema).toBe('/schemas/Strategy.single-call%401');
    expect((await send(single?.schema ?? '', 'kari')).status).toBe(200);
  });

  it('lists a strategy a plug-in adds, with its id as title until it brings texts', () => {
    const entries = strategyCatalogue(
      new Map<string, z.ZodType>([['tolk@2', z.strictObject({ instructions: z.string() })]]),
    );

    expect(entries).toEqual([
      expect.objectContaining({
        id: 'tolk',
        version: 2,
        how: 'single',
        default: false,
        title: { nb: 'tolk', en: 'tolk' },
        takes: { instructions: 'required', examples: 'no' },
      }),
    ]);
  });

  it('refuses a caller who is not signed in', async () => {
    const { send } = await bootPlatform({ people });

    expect((await send(path, 'nobody')).status).toBe(401);
  });

  it('matches the snapshot the portal mock serves', async () => {
    const { body } = await listed();

    expect(portalMock('strategies.json')).toEqual(body);
  });

  it('serves the strategy config schemas the portal mock serves', async () => {
    const { send } = await bootPlatform({ people });
    const listing = (await (await send('/schemas', 'kari')).json()) as { data: Listed[] };
    const service = listing.data.find((e) => e.kind === 'Service') as Listed;
    const uses = service.uses.filter((u) => u.kind.startsWith('Strategy.'));
    const schemas = Object.fromEntries(
      await Promise.all(
        uses.map(async (u) => [u.href, await (await send(u.href, 'kari')).json()] as const),
      ),
    );

    expect(portalMock('strategy-schemas.json')).toEqual({ list: [{ ...service, uses }], schemas });
  });
});
