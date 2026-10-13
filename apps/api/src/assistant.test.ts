import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import type { AssistantTurn } from './assistant.js';
import { resolveCatalog } from './catalogs.js';
import { localeMiddleware } from './i18n/index.js';
import { publishPlatformServices } from './platform-services.js';
import { createPlatform } from './composition.js';
import { proposalKind, type CatalogProposal } from './proposals.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant,
    authorizedFor: [{ org: tenant }],
  } as Principal,
  nora: {
    kind: 'employee',
    issuer: 'test',
    subject: 'nora',
    tenant,
    authorizedFor: [{ org: tenant, actions: ['use-services', 'manage-services'] }],
  } as Principal,
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant,
    authorizedFor: [{ org: tenant, actions: ['use-services'] }],
  } as Principal,
};

interface ToolCallReply {
  name: string;
  args: unknown;
}

interface Reply {
  text?: string;
  calls?: ToolCallReply[];
  tokens?: [number, number];
  fail?: boolean;
}

const usage = ([input, output]: [number, number]) => ({
  prompt_tokens: input,
  completion_tokens: output,
  total_tokens: input + output,
});

const completion = (reply: Reply): FakeReply => ({
  status: 200,
  json: {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply.text ?? null,
          ...(reply.calls?.length
            ? {
                tool_calls: reply.calls.map((c, i) => ({
                  id: `call${i}`,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        },
        finish_reason: reply.calls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: usage(reply.tokens ?? [10, 5]),
  },
});

const chunk = (delta: unknown, finish: string | null = null) => ({
  data: {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  },
});

const streamed = (reply: Reply): FakeReply => ({
  status: 200,
  sse: [
    ...(reply.text
      ? (reply.text.match(/[\s\S]{1,10}/g) ?? []).map((t) => chunk({ content: t }))
      : []),
    ...(reply.calls ?? []).map((c, i) =>
      chunk({
        tool_calls: [
          {
            index: i,
            id: `call${i}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          },
        ],
      }),
    ),
    chunk({}, reply.calls?.length ? 'tool_calls' : 'stop'),
    {
      data: {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'gpt-test',
        choices: [],
        usage: usage(reply.tokens ?? [10, 5]),
      },
    },
    { data: '[DONE]' },
  ],
});

const boot = async (replies: Reply[]) => {
  let chats = 0;
  const requests: { role: string; content: string }[][] = [];
  const model = await fakeHttp((body) => {
    if (!body.messages)
      return {
        status: 200,
        json: { data: [{ id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' }] },
      };
    requests.push(body.messages as { role: string; content: string }[]);
    const reply = replies[chats] ?? { text: 'Ferdig.' };
    chats += 1;
    if (reply.fail) return { status: 400, json: { error: { message: 'nede' } } };
    return body.stream ? streamed(reply) : completion(reply);
  });
  const search = await fakeHttp(() => ({ status: 200, json: {} }));
  servers.push(model, search);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: search.url,
  };
  const settings = new SettingsRegistry(platformSettings);
  const platform = await createPlatform({
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog,
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    settings,
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = people[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
  await publishPlatformServices(platform.definitions, config);
  const app = new Hono();
  app.use('*', localeMiddleware);
  platform.mount(
    app,
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      extensions: platform.extensions,
    }),
  );
  const turn = async (
    body: Record<string, unknown>,
    who = 'kari',
    target = 'services/soknadsuttrekk',
    language?: string,
  ) => {
    const res = await app.request(`/tenants/${tenant}/${target}/assistant/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${who}`,
        ...(body.stream ? { accept: 'text/event-stream' } : {}),
        ...(language ? { 'accept-language': language } : {}),
      },
      body: JSON.stringify({ draft: { definition: draft() }, ...body }),
    });
    return res;
  };
  const chatCount = () => chats;
  return { app, platform, settings, turn, chatCount, requests };
};

const draft = () => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'soknadsuttrekk', name: 'Søknadsuttrekk' },
  spec: {
    purpose: 'Hent ut opplysninger fra søknader om tilskudd',
    riskClass: 'limited',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: {
      id: 'single-call',
      version: 1,
      config: { instructions: 'Hent ut beløpet.', temperature: 0.2 },
    },
    model: { primary: 'foundry-openai/gpt-4o-2m-tps', residency: 'global' },
  },
});

const lowerTemperature = {
  name: 'propose_change',
  args: {
    title: 'Lavere temperatur',
    detail: 'Gir mer stabile svar',
    patch: [{ op: 'replace', path: '/spec/strategy/config/temperature', value: 0 }],
  },
};

const json = async (res: Response) => (await res.json()) as AssistantTurn;

const sseEvents = (text: string) =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const name = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? 'null';
      return { name, data: JSON.parse(data) as Record<string, unknown> };
    });

describe('the builder assistant API', () => {
  it('a turn returns proposals that are never applied and reports the token usage', async () => {
    const { turn } = await boot([
      { calls: [lowerTemperature], tokens: [100, 20] },
      { text: 'Jeg foreslår lavere temperatur.', tokens: [120, 10] },
    ]);

    const res = await turn({ message: 'Svarene varierer for mye' });
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'completed',
      message: 'Jeg foreslår lavere temperatur.',
      proposals: [
        {
          level: 1,
          kind: 'change',
          appliedToDraft: false,
          validation: { ok: true },
          after: { spec: { strategy: { config: { temperature: 0 } } } },
        },
      ],
      usage: { tokens: 250, budgetLeftToday: 200_000 - 250, dailyBudget: 200_000 },
    });
    expect(body.turnId).toEqual(expect.any(String));
  });

  it('assistant turns are left out of Kjøringer, Forbruk and the service quota', async () => {
    const { app, turn } = await boot([{ text: 'Ingen endring trengs.', tokens: [300, 40] }]);
    expect((await turn({ message: 'Ser oppsettet greit ut?' })).status).toBe(200);

    const get = async (path: string) =>
      (await app.request(path, { headers: { authorization: 'Bearer kari' } })).json();
    const usage = (await get(`/tenants/${tenant}/usage`)) as {
      totals: { inputTokens: number };
    };
    const tasks = (await get(`/tenants/${tenant}/tasks`)) as { data: unknown[] };

    expect(usage.totals.inputTokens).toBe(0);
    expect(tasks.data).toEqual([]);
  });

  it('a turn stops at the rest of the daily budget, and later turns do not call the model', async () => {
    const { settings, turn, chatCount } = await boot([{ text: 'Hei.', tokens: [30, 10] }]);
    expect(settings.setTenant(tenant, 'assistant.dailyTokens', 25)).toMatchObject({ ok: true });

    const first = await json(await turn({ message: 'Hjelp meg' }));
    const calls = chatCount();
    const second = await json(await turn({ message: 'Hjelp meg igjen' }));

    expect(first).toMatchObject({
      status: 'budget_exhausted',
      usage: { tokens: 40, budgetLeftToday: 0 },
    });
    expect(second).toMatchObject({
      status: 'budget_exhausted',
      proposals: [],
      usage: { tokens: 0, budgetLeftToday: 0, dailyBudget: 25 },
    });
    expect(second.message).toContain('fornyes kl. 00.00');
    expect(chatCount()).toBe(calls);
  });

  it('a disabled assistant returns refused', async () => {
    const { settings, turn, chatCount } = await boot([{ text: 'Hei.' }]);
    expect(settings.setTenant(tenant, 'assistant.enabled', false)).toMatchObject({ ok: true });

    const body = await json(await turn({ message: 'Hjelp meg' }));

    expect(body).toMatchObject({ status: 'refused', proposals: [] });
    expect(body.message).toContain('Innstillinger');
    expect(chatCount()).toBe(0);
  });

  it('a model error returns unavailable', async () => {
    const { turn } = await boot([{ fail: true }]);

    const body = await json(await turn({ message: 'Hjelp meg' }));

    expect(body).toMatchObject({ status: 'unavailable', proposals: [] });
  });

  it('SSE emits delta, paragraph, proposal and done in order', async () => {
    const { turn } = await boot([
      { text: 'Svarene varierer.\n\nJeg foreslår en endring.', calls: [lowerTemperature] },
      { text: 'Ferdig.' },
    ]);

    const res = await turn({ message: 'Svarene varierer for mye', stream: true });
    const events = sseEvents(await res.text());
    const names = events.map((e) => e.name);
    const done = events.at(-1)?.data.turn as AssistantTurn | undefined;

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(names.indexOf('delta')).toBe(0);
    expect(names.indexOf('paragraph')).toBeGreaterThan(names.indexOf('delta'));
    expect(names.indexOf('proposal')).toBeGreaterThan(names.indexOf('paragraph'));
    expect(names.at(-1)).toBe('done');
    expect(events.filter((e) => e.name === 'paragraph').map((e) => e.data.text)).toEqual([
      'Svarene varierer.',
      'Jeg foreslår en endring.',
      'Ferdig.',
    ]);
    expect(done).toMatchObject({
      status: 'completed',
      proposals: [{ level: 1, appliedToDraft: false }],
    });
    expect(events.find((e) => e.name === 'proposal')?.data).toMatchObject({
      level: 1,
      appliedToDraft: false,
    });
  });

  it('stores proposals above level 1 with a case id for platform changes', async () => {
    const { platform, turn } = await boot([
      {
        calls: [
          {
            name: 'propose_platform_change',
            args: { title: 'Les Excel-ark', summary: 'Støtte for å lese Excel-ark direkte' },
          },
        ],
      },
      { text: 'Jeg har sendt forslaget til Digdir.' },
    ]);

    const body = await json(await turn({ message: 'Kan dere lese Excel?' }));
    const stored = await platform.configEntries.latest({ kind: proposalKind, scope: tenant });

    expect(body.proposals[0]).toMatchObject({
      level: 4,
      appliedToDraft: false,
      storedProposalId: stored[0]?.id,
      platformChange: { caseId: `KI-${new Date().getFullYear()}-0001`, status: 'sent' },
    });
    expect(stored[0]?.spec as CatalogProposal).toMatchObject({
      level: 4,
      state: 'pending',
      forService: { id: 'soknadsuttrekk', name: 'Søknadsuttrekk' },
    });
  });

  it('a proposal the person cannot approve names the right it needs, in bokmål and English', async () => {
    const block = {
      calls: [
        {
          name: 'propose_building_block',
          args: { title: 'Risikoscore', endpoint: 'https://risiko.example.no/mcp' },
        },
      ],
    };
    const { turn } = await boot([block, { text: 'Ferdig.' }, block, { text: 'Done.' }]);

    const nb = await json(await turn({ message: 'Risiko' }, 'nora', undefined, 'nb'));
    const en = await json(await turn({ message: 'Risk' }, 'nora', undefined, 'en'));

    expect(nb.proposals[0]?.approval).toEqual({
      right: 'register-building-blocks',
      label: 'Registrere byggeklosser',
      message: 'Må godkjennes av noen med rettigheten «Registrere byggeklosser».',
    });
    expect(en.proposals[0]?.approval).toEqual({
      right: 'register-building-blocks',
      label: 'Register building blocks',
      message: 'Needs approval from someone with the right "Register building blocks".',
    });
  });

  it('a person with the right to approve sees no approval note', async () => {
    const { turn } = await boot([
      {
        calls: [
          {
            name: 'propose_building_block',
            args: { title: 'Risikoscore', endpoint: 'https://risiko.example.no/mcp' },
          },
        ],
      },
      { text: 'Ferdig.' },
    ]);

    const body = await json(await turn({ message: 'Risiko' }));

    expect(body.proposals[0]?.approval).toBeUndefined();
  });

  it('keeps the conversation across turns, with answers under their questions', async () => {
    const { turn, requests } = await boot([
      {
        text: 'Jeg trenger å vite mer.',
        calls: [
          {
            name: 'ask',
            args: {
              questions: [
                {
                  label: 'Hvilke saker skal tas med?',
                  options: ['Alle saker', 'Bare avsluttede saker'],
                },
              ],
            },
          },
        ],
      },
      { text: 'Da tar jeg bare med avsluttede saker.' },
      { text: 'Tabellen heter saker.' },
    ]);

    const first = await json(await turn({ message: 'Koble på saksarkivet i PostgreSQL' }));
    const second = await json(
      await turn({ message: '1. Bare avsluttede saker', answers: { q1: 'Bare avsluttede saker' } }),
    );
    await turn({ message: 'Hva heter tabellen?', previousTurn: second.turnId });

    const contents = (messages: { content: string }[] = []) => messages.map((m) => m.content);
    expect(first.questions?.[0]?.id).toBe('q1');
    expect(contents(requests[1])).toContain('Koble på saksarkivet i PostgreSQL');
    expect(contents(requests[1]).join('\n')).toContain(
      'Spurte: «Hvilke saker skal tas med?» (valg: Alle saker, Bare avsluttede saker)',
    );
    expect(requests[1]?.at(-1)?.content).toContain(
      '- Hvilke saker skal tas med?: Bare avsluttede saker',
    );
    const third = contents(requests[2]).join('\n');
    expect(third).toContain('Koble på saksarkivet i PostgreSQL');
    expect(third).toContain('Svar på «Hvilke saker skal tas med?»: Bare avsluttede saker');
    expect(third).toContain('Da tar jeg bare med avsluttede saker.');
    expect(second).not.toHaveProperty('transcript');
  });

  it('a user without Administrere tjenester cannot use the assistant', async () => {
    const { turn, chatCount } = await boot([{ text: 'Hei.' }]);

    const res = await turn({ message: 'Hjelp meg' }, 'erik');

    expect(res.status).toBe(403);
    expect(chatCount()).toBe(0);
  });

  it('the skills route proposes level 1 patches against the skill draft', async () => {
    const { turn } = await boot([
      {
        calls: [
          {
            name: 'propose_change',
            args: {
              title: 'Bedre beskrivelse',
              patch: [
                { op: 'replace', path: '/spec/description', value: 'Finner beløp i søknader.' },
              ],
            },
          },
        ],
      },
      { text: 'Her er et forslag.' },
    ]);
    const skill = {
      apiVersion: 'genai/v1',
      kind: 'Skill',
      metadata: { tenant, id: 'belop' },
      spec: { description: 'Beløp', instructions: 'Finn beløpet.' },
    };

    const body = await json(
      await turn(
        {
          message: 'Skriv en bedre beskrivelse',
          draft: { definition: skill },
          intent: 'suggest-description',
        },
        'kari',
        'skills/belop',
      ),
    );

    expect(body).toMatchObject({
      status: 'completed',
      proposals: [
        {
          level: 1,
          appliedToDraft: false,
          after: { kind: 'Skill', spec: { description: 'Finner beløp i søknader.' } },
        },
      ],
    });
  });

  it('proposes a new variant from a recipe the organisation has published, with its settings', async () => {
    const { turn, platform, requests } = await boot([
      {
        calls: [
          {
            name: 'propose_variant',
            args: {
              title: 'Ny variant «Årsrapporter først»',
              detail: 'Søker i Årsrapport, så Evaluering, og svarer kort.',
              variant: {
                id: 'arsrapporter-forst',
                title: { nb: 'Årsrapporter først', en: 'Annual reports first' },
              },
              recipe: 'ordered-sources-answer@1',
              settings: { documentTypes: ['Årsrapport', 'Evaluering'], answerLength: 'short' },
            },
          },
        ],
      },
      { text: 'Her er varianten.' },
    ]);
    const published = await platform.definitions.publish(
      yaml(join('flows', 'ordered-sources-answer.yaml')),
      'kari',
      'Oppskrift',
      {},
    );
    expect(published.ok).toBe(true);

    const body = await json(
      await turn({
        message: 'Lag en variant som sjekker årsrapportene først, så evalueringene, og svarer kort',
      }),
    );

    expect(requests[0]?.[0]?.content).toContain('"ref": "ordered-sources-answer@1"');
    expect(body.proposals).toMatchObject([
      {
        level: 1,
        section: 'variants',
        appliedToDraft: false,
        validation: { ok: true },
        after: {
          spec: {
            variants: [
              'default',
              {
                id: 'arsrapporter-forst',
                strategy: {
                  id: 'step-flow',
                  config: {
                    flow: 'ordered-sources-answer@1',
                    settings: { documentTypes: ['Årsrapport', 'Evaluering'] },
                  },
                },
              },
            ],
          },
        },
      },
    ]);
  });

  it('the step flow route proposes level 1 patches against the step flow draft', async () => {
    const { turn } = await boot([
      {
        calls: [
          {
            name: 'propose_change',
            args: {
              title: 'Bedre formål',
              patch: [{ op: 'replace', path: '/spec/purpose', value: 'Søk og svar kort' }],
            },
          },
        ],
      },
      { text: 'Her er et forslag.' },
    ]);
    const flow = {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant, id: 'sok' },
      spec: { purpose: 'Søk', steps: [{ id: 'finn', block: 'retrieve@1', input: {} }] },
    };

    const body = await json(
      await turn(
        { message: 'Skriv et bedre formål', draft: { definition: flow } },
        'kari',
        'step-flows/sok',
      ),
    );

    expect(body).toMatchObject({
      status: 'completed',
      proposals: [{ level: 1, after: { kind: 'StepFlow', spec: { purpose: 'Søk og svar kort' } } }],
    });
  });
});
