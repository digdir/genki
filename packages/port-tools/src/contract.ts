import type { PortContext, PortProvider } from '@genai/kernel';
import { check, checkEqual, checkFailsWith, type ContractSuite } from '@genai/plugins';
import { z } from 'zod';
import { ToolRegistry, toolRef, type ToolPort } from './index.js';

export const toolSourceContractVersion = 'tool-source@1';

export interface ToolSourceContractSubject {
  provider: PortProvider<ToolPort>;
  tenant: string;
  tool: { name: string; version: string; input: unknown };
  calls?(): number;
}

const contextFor = (tenant: string, signal: AbortSignal): PortContext => ({
  tenant,
  principal: { kind: 'employee', issuer: 'contract', subject: 'kari', tenant },
  task: 'contract',
  signal,
  meter: async () => undefined,
});

const open = (s: ToolSourceContractSubject, signal: AbortSignal, name = s.tool.name) =>
  s.provider.open(toolRef(name, s.tool.version, s.tenant), contextFor(s.tenant, signal));

export const toolSourceContract: ContractSuite<ToolSourceContractSubject> = {
  contract: toolSourceContractVersion,
  checks: [
    {
      name: 'the definition names the tool, its version and an object input schema',
      run: async (s, signal) => {
        const definition = open(s, signal).definition();
        checkEqual(definition.name, s.tool.name, 'name');
        checkEqual(definition.version, s.tool.version, 'version');
        check(definition.description.length > 0, 'the tool is described');
        checkEqual((definition.input as { type?: unknown }).type, 'object', 'input schema type');
      },
    },
    {
      name: 'a valid call returns content parts and no error',
      run: async (s, signal) => {
        const result = await open(s, signal).call(s.tool.input);
        check(result.isError !== true, 'the result is not an error');
        check(result.parts.length > 0, 'the result has parts');
        for (const part of result.parts) check(part.mime.length > 0, 'each part names its type');
      },
    },
    {
      name: 'input that is not an object comes back as an error result, without calling the tool',
      run: async (s, signal) => {
        const before = s.calls?.();
        const result = await open(s, signal).call('ikke et objekt');
        checkEqual(result.isError, true, 'isError');
        if (before !== undefined) checkEqual(s.calls?.(), before, 'tool calls');
      },
    },
    {
      name: 'an unknown tool fails as not_found',
      run: async (s, signal) => {
        await checkFailsWith(() => open(s, signal, 'finnes-ikke.verktoy'), 'not_found', 'open');
      },
    },
    {
      name: 'an aborted signal fails as cancelled',
      run: async (s) => {
        const controller = new AbortController();
        controller.abort();
        await checkFailsWith(
          () => open(s, controller.signal).call(s.tool.input),
          'cancelled',
          'aborted call',
        );
      },
    },
  ],
};

export const builtinToolsContractTarget = async () => {
  let calls = 0;
  const registry = new ToolRegistry().register({
    name: 'kontrakt.ekko',
    version: '1',
    description: 'Gir tilbake teksten den får',
    input: z.strictObject({ tekst: z.string() }),
    run: async (input) => {
      calls += 1;
      return { parts: [{ mime: 'text/plain', body: { kind: 'text', text: input.tekst } }] };
    },
  });
  const subject: ToolSourceContractSubject = {
    provider: registry,
    tenant: '991825827',
    tool: { name: 'kontrakt.ekko', version: '1', input: { tekst: 'hei' } },
    calls: () => calls,
  };
  return { subject };
};
