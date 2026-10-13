import {
  check,
  checkEqual,
  manifest,
  skipped,
  type ContractSuite,
  type PluginRegistration,
} from '@genai/plugins';
import { builtinHooks } from './builtins.js';
import { hookPoints, type HookCall, type HookVerdict } from './hook.js';

export const hookContractVersion = 'hook@1';

export interface HookContractSubject {
  invoke(call: HookCall, signal: AbortSignal): Promise<HookVerdict>;
  examples: { allow: HookCall; refuse?: HookCall };
}

const checkVerdict = (verdict: HookVerdict, what: string) => {
  check(typeof verdict === 'object' && verdict !== null, `${what}: the verdict is an object`);
  check(
    verdict.decision === undefined || ['allow', 'refuse'].includes(verdict.decision),
    `${what}: decision is allow or refuse`,
  );
  check(
    verdict.annotations === undefined ||
      (typeof verdict.annotations === 'object' && !Array.isArray(verdict.annotations)),
    `${what}: annotations are an object`,
  );
};

export const hookContract: ContractSuite<HookContractSubject> = {
  contract: hookContractVersion,
  checks: [
    {
      name: 'an ordinary call is allowed with a well-formed verdict',
      run: async (s, signal) => {
        const verdict = await s.invoke(s.examples.allow, signal);
        checkVerdict(verdict, 'allow example');
        check(verdict.decision !== 'refuse', 'the ordinary call is not refused');
      },
    },
    {
      name: 'a call the hook stops is refused with a reason',
      run: async (s, signal) => {
        if (!s.examples.refuse) return skipped;
        const verdict = await s.invoke(s.examples.refuse, signal);
        checkVerdict(verdict, 'refuse example');
        checkEqual(verdict.decision, 'refuse', 'decision');
        check(typeof verdict.reason === 'string' && verdict.reason.length > 0, 'a reason is given');
      },
    },
    {
      name: 'every hook point gets a well-formed verdict',
      run: async (s, signal) => {
        for (const point of hookPoints)
          checkVerdict(await s.invoke({ ...s.examples.allow, point }, signal), point);
      },
    },
  ],
};

export const builtinHookPlugins = (): PluginRegistration[] =>
  builtinHooks.map(
    (hook) =>
      ({
        manifest: manifest({
          kind: 'hook',
          id: `hook.${hook.id}`,
          version: '1',
          contract: hookContractVersion,
          title: hook.title,
          description: hook.description,
          capabilities: hook.examples.refuse
            ? ['observe', 'annotate', 'enforce']
            : ['observe', 'annotate'],
        }),
        suite: hookContract,
        target: async () => ({
          subject: {
            invoke: async (call: HookCall) =>
              hook.run(hook.config.parse(hook.examples.config), call),
            examples: {
              allow: hook.examples.allow,
              ...(hook.examples.refuse ? { refuse: hook.examples.refuse } : {}),
            },
          },
        }),
      }) as PluginRegistration,
  );
