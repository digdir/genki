import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { completeService, fieldIdFrom } from './definition-completion.js';
import { bootPlatform, digdir } from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  reader: {
    kind: 'employee',
    issuer: 'test',
    subject: 'reader',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
};

const service = (spec: Record<string, unknown>) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svarer kort',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: 'fake/gpt', residency: 'norway' },
    ...spec,
  },
});

const none = { residencyOf: () => undefined, strategies: [] };

const complete = async (definition: unknown, as = 'kari') => {
  const { send } = await bootPlatform({ people });
  const res = await send(`/tenants/${digdir}/definitions/complete`, as, { body: { definition } });
  return {
    status: res.status,
    body: (await res.json()) as {
      definition: { spec: Record<string, Record<string, unknown>> };
      applied: { path: string; rule: string }[];
    },
  };
};

describe('completing a service definition', () => {
  it('takes the residency from the model catalogue when the definition has none', async () => {
    const { body } = await complete(service({ model: { primary: 'fake/gpt' } }));

    expect(body.definition.spec.model).toEqual({ primary: 'fake/gpt', residency: 'norway' });
    expect(body.applied).toEqual([{ path: 'spec.model.residency', rule: 'residency-from-model' }]);
  });

  it('gives a form field without an id one made from its label, never a reserved or taken one', () => {
    const { definition, applied } = completeService(
      service({
        input: {
          accepts: ['text/plain'],
          fields: [
            { id: 'aar', label: 'År', kind: 'year' },
            { label: 'År', kind: 'year' },
            { label: 'Query', kind: 'text' },
            { label: 'Søkers navn', kind: 'text' },
          ],
        },
      }),
      none,
    );
    const ids = (definition.spec as { input: { fields: { id: string }[] } }).input.fields.map(
      (f) => f.id,
    );

    expect(ids).toEqual(['aar', 'aar_2', 'field', 'sokers_navn']);
    expect(applied.map((a) => a.rule)).toEqual([
      'field-id-from-label',
      'field-id-from-label',
      'field-id-from-label',
    ]);
  });

  it('never makes a form field id the platform reserves', () => {
    expect(fieldIdFrom('user-query', new Set())).toBe('user_query');
    expect(fieldIdFrom('query', new Set())).toBe('field');
    expect(fieldIdFrom('', new Set(['field']))).toBe('field_2');
  });

  it('starts a strategy without config with the starting config of the catalogue', async () => {
    const { body } = await complete(service({ strategy: { id: 'agent-loop', version: 1 } }));

    expect(body.definition.spec.strategy).toEqual({
      id: 'agent-loop',
      version: 1,
      config: { maxIterations: 8 },
    });
  });

  it('asks for human approval when the risk is high', () => {
    const { definition, applied } = completeService(service({ riskClass: 'high' }), none);

    expect((definition.spec as { guardrails: unknown }).guardrails).toEqual({
      'human-approval': true,
    });
    expect(applied).toEqual([
      { path: 'spec.guardrails.human-approval', rule: 'human-approval-for-high-risk' },
    ]);
  });

  it('drops required sources from a service that returns fields, which has no answer to cite', () => {
    const { definition } = completeService(
      service({
        output: { kind: 'fields', fields: [{ name: 'Navn', type: 'string', description: 'Navn' }] },
        guardrails: { 'require-sources': true, language: { mode: 'nb' } },
      }),
      none,
    );

    expect((definition.spec as { guardrails: unknown }).guardrails).toEqual({
      language: { mode: 'nb' },
    });
  });

  it('drops the output parts that belong to another kind, and sources from an output that is not an answer', () => {
    const { definition, applied } = completeService(
      service({
        output: {
          kind: 'document',
          template: 'Svarbrev',
          withSources: true,
          fields: [{ name: 'Navn', type: 'string', description: 'Navn' }],
          columns: [{ key: 'a', name: 'A' }],
          rowKey: 'a',
        },
      }),
      none,
    );

    expect((definition.spec as { output: unknown }).output).toEqual({
      kind: 'document',
      template: 'Svarbrev',
      withSources: false,
    });
    expect(applied.map((a) => a.path)).toEqual([
      'spec.output.fields',
      'spec.output.columns',
      'spec.output.rowKey',
      'spec.output.withSources',
    ]);
  });

  it('describes a result field by its name when the description is empty', () => {
    const { definition, applied } = completeService(
      service({
        output: {
          kind: 'fields',
          fields: [
            { name: 'Omsøkt beløp', type: 'number', description: '' },
            { name: 'Frist', type: 'date', description: 'Siste dag for svar' },
          ],
        },
      }),
      none,
    );

    expect((definition.spec as { output: { fields: unknown } }).output.fields).toEqual([
      { name: 'Omsøkt beløp', type: 'number', description: 'Omsøkt beløp' },
      { name: 'Frist', type: 'date', description: 'Siste dag for svar' },
    ]);
    expect(applied).toEqual([
      { path: 'spec.output.fields.0.description', rule: 'field-description-from-name' },
    ]);
  });

  it('changes nothing in a definition that is already complete', async () => {
    const definition = service({});
    const { status, body } = await complete(definition);

    expect(status).toBe(200);
    expect(body).toEqual({ definition, applied: [] });
  });

  it('needs manage-services and a Service definition', async () => {
    expect((await complete(service({}), 'reader')).status).toBe(403);
    expect((await complete({ kind: 'StepFlow' })).status).toBe(400);
  });
});
