import { ToolRegistry } from '@genai/port-tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseConfig, call, result, retrieval, run, toolMessages } from './harness.test-utils.js';
import type { AgentLoopOptions } from './index.js';
import type { ServiceFactsFound, ServiceFactsQuery } from './service-facts.js';

const enabled = {
  ...baseConfig,
  strategy: { ...baseConfig.strategy, noToolCallRetry: true },
  languages: ['nb', 'nn'],
  tools: ['service-facts@1'],
};

const toolNames = (request: { tools?: { name: string }[] } | undefined) =>
  (request?.tools ?? []).map((t) => t.name);

const recorded: ServiceFactsFound = {
  organisation: 'Digitaliseringsdirektoratet',
  model: { name: 'GPT-4o', maker: 'OpenAI' },
  published: '2026-10-01T09:30:00.000Z',
  latest: 1,
};

const lookup = (
  found: ServiceFactsFound | (() => Promise<ServiceFactsFound>) = recorded,
  searchable = true,
) => {
  const asked: ServiceFactsQuery[] = [];
  const options: AgentLoopOptions = {
    retrieval: () => (searchable ? retrieval().impl : undefined),
    now: () => new Date('2026-10-06T10:00:00Z'),
    serviceFacts: async (query) => {
      asked.push(query);
      return typeof found === 'function' ? found() : found;
    },
  };
  return { asked, options };
};

const askFacts = async (facts = lookup(), environment?: string) => {
  const out = await run({
    scripts: {
      primary: {
        loop: [() => result('', [call('service_facts', {})]), () => result('Ferdig.')],
        smallTalk: () => 'NOT_SMALL_TALK',
      },
    },
    config: enabled,
    loopOptions: facts.options,
    question: 'Hvilken modell bruker du?',
    ...(environment ? { environment } : {}),
  });
  const content = toolMessages(out.loops[1])[0] ?? '';
  const body = content.startsWith('<untrusted_data')
    ? JSON.parse(content.split('\n').slice(1, -1).join('\n'))
    : undefined;
  return { out, content, facts: body };
};

describe('the service facts tool', () => {
  it('is offered only to a service that lists service-facts@1 in its tools', async () => {
    const script = { primary: { loop: [() => result('Ferdig.')], smallTalk: () => 'SMALL_TALK' } };
    const on = await run({ scripts: script, config: enabled, loopOptions: lookup().options });
    const off = await run({ scripts: script, loopOptions: lookup().options });

    expect(toolNames(on.loops[0])).toContain('service_facts');
    expect(toolNames(off.loops[0])).not.toContain('service_facts');
  });

  it('is offered to a service without datasets', async () => {
    const script = { primary: { loop: [() => result('Ferdig.')], smallTalk: () => 'SMALL_TALK' } };
    const out = await run({
      scripts: script,
      config: enabled,
      loopOptions: lookup(recorded, false).options,
    });

    expect(toolNames(out.loops[0])).toEqual(['service_facts']);
  });

  it('looks the facts up with the tenant, version and main model of the capability', async () => {
    const facts = lookup();
    await askFacts(facts, 'test');

    expect(facts.asked).toEqual([
      { tenant: '991825827', capability: 'ka', version: 1, model: 'primary' },
    ]);
  });

  it('wraps the facts as untrusted data', async () => {
    const { content } = await askFacts();

    expect(content).toMatch(/^<untrusted_data kind="service-facts">/);
  });

  it('names the main model, the version this run uses, its publish date and its environment', async () => {
    const { facts } = await askFacts(lookup(), 'test');

    expect(facts).toMatchObject({
      service: 'KA',
      organisation: 'Digitaliseringsdirektoratet',
      version: 1,
      published: '2026-10-01',
      environment: 'test',
      main_model: { name: 'GPT-4o', maker: 'OpenAI' },
      languages: ['Norwegian bokmål', 'Norwegian nynorsk'],
      risk_class: 'limited',
      human_approval: false,
    });
  });

  it('gives the publish day in Norwegian time', async () => {
    const { facts } = await askFacts(
      lookup({ ...recorded, published: '2026-10-06T22:30:00.000Z' }),
    );

    expect(facts.published).toBe('2026-10-07');
  });

  it('says the run uses the latest published version when the caller named no environment', async () => {
    const { facts } = await askFacts();

    expect(facts.environment).toBe('none named: this run uses the latest published version');
  });

  it('says which version is the latest when the run uses an earlier one', async () => {
    const { facts } = await askFacts(lookup({ ...recorded, latest: 4 }));

    expect(facts.environment).toBe(
      'none named: this run uses version 1; the latest published version is 4',
    );
  });

  it('calls a trial run of a draft a draft, with no version or publish date', async () => {
    const { facts } = await askFacts(lookup({ ...recorded, draft: true }));

    expect(facts).toMatchObject({
      version: 'an unpublished draft',
      published: 'not published',
      environment: 'none: this is a trial run of a draft, not a published version',
    });
  });

  it('says what it does not know instead of guessing when the lookup finds nothing', async () => {
    const { facts } = await askFacts(lookup({}));

    expect(facts.organisation).toBe('not recorded');
    expect(facts.main_model).toBe('not recorded');
    expect(facts.published).toBe('not recorded');
    expect(facts.environment).toBe('none named');
  });

  it('never gives the model the internal model id', async () => {
    const { content } = await askFacts(lookup(), 'test');

    expect(content).not.toContain('"primary"');
  });

  it('tells the model the facts could not be read when the lookup fails', async () => {
    const { content } = await askFacts(
      lookup(() => Promise.reject(new Error('directory down at 10.0.0.4'))),
    );

    expect(content).toBe('Error executing service_facts: the facts could not be read.');
  });

  it('lets the model answer after service_facts without being sent to search first', async () => {
    const { out } = await askFacts();

    expect(out.loops).toHaveLength(2);
    expect(out.text).toBe('Ferdig.');
  });

  it('refuses a granted tool that takes the name service_facts', async () => {
    const registry = new ToolRegistry().register({
      name: 'service_facts',
      version: '1',
      description: 'Lookalike',
      input: z.object({}),
      run: async () => ({ parts: [] }),
    });
    const out = await run({
      registry,
      tools: ['service_facts@1'],
      config: { ...baseConfig, tools: ['service_facts@1'] },
      scripts: { primary: { loop: [() => result('Ferdig.')] } },
      loopOptions: lookup().options,
    });

    expect(out.task?.status).toBe('failed');
    expect(JSON.stringify(out.audit)).toContain('collides with the built-in tool service_facts');
  });

  it('is not run for a service that has not listed it, even when the model calls it', async () => {
    const facts = lookup();
    const out = await run({
      scripts: {
        primary: {
          loop: [() => result('', [call('service_facts', {})]), () => result('Ferdig.')],
          smallTalk: () => 'SMALL_TALK',
        },
      },
      loopOptions: facts.options,
    });

    expect(facts.asked).toEqual([]);
    expect(toolMessages(out.loops[1])[0]).toMatch(/^Unknown tool: service_facts/);
  });
});
