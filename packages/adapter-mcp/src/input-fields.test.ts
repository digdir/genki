import { describe, expect, it } from 'vitest';
import {
  inputFieldsSchema,
  textPart,
  type Input,
  type InputField,
  type Principal,
} from '@genai/contracts';
import { createKernel, type Strategy } from '@genai/kernel';
import { createMcpApp, protocolVersion, type CapabilityEntry } from './index.js';

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

const fields: InputField[] = [
  {
    id: 'ministry',
    label: 'Departement',
    kind: 'choice',
    required: true,
    options: ['Kunnskapsdepartementet', 'Klima- og miljødepartementet'],
  },
  { id: 'agency', label: 'Virksomhet', kind: 'organisation' },
];

const entry: CapabilityEntry = {
  id: 'maloppnaelse__default',
  capability: 'form',
  inputSchema: inputFieldsSchema(fields),
  inputFields: fields,
};

const setup = () => {
  const seen: Input[] = [];
  const strategy: Strategy = {
    id: 'form',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (_ctx, input) {
      seen.push(input);
      yield { type: 'kernel.result', data: [textPart('Vurdert.')] };
    },
  };
  const kernel = createKernel({
    strategies: [strategy],
    capabilities: [
      {
        descriptor: {
          id: 'form',
          version: '1',
          tenant,
          title: 'form',
          description: 'form',
          input: {},
          interaction: ['unary'],
          accepts: [],
          produces: [],
          emits: [],
          oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI' },
        },
        strategy: { id: 'form', version: '1' },
        config: {},
        grants: [],
      },
    ],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  const app = createMcpApp({
    kernel,
    resolver: {
      list: async () => [entry],
      resolve: async (_p, name) =>
        name === entry.id
          ? { ok: true, entry }
          : { ok: false, code: 'model_not_found', message: `Model not found: ${name}` },
    },
    auth: { authenticate: async () => kari },
  });
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await app.request('/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': protocolVersion,
        'Mcp-Method': method,
        ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
      },
    });
    return (await response.json()) as { result: Record<string, unknown> };
  };
  return { rpc, seen };
};

describe('service input forms over MCP', () => {
  it('advertises the fields as the tool input schema', async () => {
    const { rpc } = setup();
    const { result } = await rpc('tools/list', {});
    const [tool] = result.tools as {
      inputSchema: { properties: Record<string, unknown>; required: string[] };
    }[];

    expect(tool?.inputSchema.required).toEqual(['ministry']);
    expect(tool?.inputSchema.properties.ministry).toMatchObject({ enum: fields[0]?.options });
    expect(tool?.inputSchema.properties).toHaveProperty('query');
    expect(tool?.inputSchema.properties).not.toHaveProperty('user-query');
  });

  it('passes valid fields to the strategy', async () => {
    const { rpc, seen } = setup();
    const { result } = await rpc('tools/call', {
      name: entry.id,
      arguments: { ministry: 'Kunnskapsdepartementet', agency: 'Udir' },
    });

    expect(result.isError).toBe(false);
    expect(seen[0]?.data).toMatchObject({
      ministry: 'Kunnskapsdepartementet',
      agency: 'Udir',
      query: 'Departement: Kunnskapsdepartementet\nVirksomhet: Udir',
    });
  });

  it('returns a tool error the caller can act on for a wrong option', async () => {
    const { rpc, seen } = setup();
    const { result } = await rpc('tools/call', {
      name: entry.id,
      arguments: { ministry: 'Forsvarsdepartementet' },
    });

    expect(result).toMatchObject({
      isError: true,
      _meta: { code: 'invalid_input' },
      structuredContent: { errors: [{ path: 'ministry' }] },
    });
    expect(seen).toEqual([]);
  });
});
