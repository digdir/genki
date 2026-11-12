import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import { createVault, piiCategories } from '@genai/guardrails';
import type {
  Capability,
  CapabilityRegistry,
  EnvironmentTier,
  Kernel,
  PayloadGuard,
  PolicyDecisionPoint,
  Strategy,
} from '@genai/kernel';
import type { WireExchange } from '@genai/operations';
import type { OperationPort } from '@genai/port-model';
import { withModelAdmission } from './lockdown.js';

export { environmentTiers, type EnvironmentTier } from '@genai/kernel';

/** The tier is test only where the deployment says `GENAI_ENV=test`, as genki-test does; anything else is production. */
export const environmentTierOf = (env: Record<string, string | undefined>): EnvironmentTier =>
  env.GENAI_ENV === 'test' ? 'test' : 'production';

export const operationTryStrategyId = 'platform.operation.try';
const capabilityPrefix = 'platform/operation-try/';

export type OperationTryRefusal = 'not-test' | 'not-synthetic' | 'not-operator';

export class OperationTryError extends Error {
  constructor(
    readonly refusal: OperationTryRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'OperationTryError';
  }
}

const tryPrincipal = (operator: Principal, tenant: string, admitted: boolean): Principal => {
  const principal: Principal = {
    kind: 'agency-system',
    issuer: 'platform',
    subject: 'operation-try',
    tenant,
    actor: operator,
  };
  return admitted ? withModelAdmission(principal) : principal;
};

const isTryPrincipal = (principal: Principal) =>
  principal.issuer === 'platform' &&
  principal.subject === 'operation-try' &&
  principal.actor?.kind === 'operator';

/** Masks every PII category in every text field and never restores it. */
export const maskEverything = (): PayloadGuard => {
  const vault = createVault(piiCategories);
  return { masker: { mask: (text) => vault.mask(text) } };
};

interface TryConfig {
  descriptor: string;
  model: string;
}

/** The digest a try keeps of its exchange, so a fixture recorded later can be held to it. */
export const exchangeDigest = (exchange: WireExchange) =>
  createHash('sha256').update(JSON.stringify(exchange)).digest('hex');

export interface TryRecord {
  descriptor: string;
  model: string;
  result: unknown;
  exchange: { sha256: string } | null;
}

export const isTryCapability = (id: string) => id.startsWith(capabilityPrefix);

/** Exchanges seen by a try, handed from the strategy to the runner by capability id. */
export type TryExchanges = Map<string, WireExchange>;

export const operationTryStrategy = (
  tier: EnvironmentTier,
  exchanges?: TryExchanges,
): Strategy<TryConfig> => ({
  id: operationTryStrategyId,
  version: '1',
  requires: { kernel: 1, ports: ['operation'], features: [] },
  run: async function* (ctx, input, config) {
    if (tier !== 'test')
      throw new OperationTryError('not-test', 'a descriptor in review is tried only in test');
    if (!isTryPrincipal(ctx.principal))
      throw new OperationTryError('not-operator', 'only an operator may try a descriptor');
    const data = (input.data ?? {}) as { input?: unknown; synthetic?: unknown };
    if (data.synthetic !== true)
      throw new OperationTryError('not-synthetic', 'the raw tier takes synthetic data only');
    const port = await ctx.use<OperationPort>(
      'operation',
      { kind: 'model', id: config.model },
      { guards: [maskEverything()] },
    );
    let exchange: WireExchange | undefined;
    const result = await port.call(config.descriptor, data.input, {
      observe: (e) => {
        exchange = e;
      },
    });
    if (exchange) exchanges?.set(ctx.capability.id, exchange);
    const record: TryRecord = {
      descriptor: config.descriptor,
      model: config.model,
      result,
      exchange: exchange ? { sha256: exchangeDigest(exchange) } : null,
    };
    yield {
      type: 'kernel.result',
      data: [{ mime: 'application/json', body: { kind: 'json', json: record as never } }],
    };
  },
});

/** Only the raw tier's own principal invokes a try or opens the `operation` port, and it does nothing else. */
export const operationTryPolicy = (inner: PolicyDecisionPoint): PolicyDecisionPoint => ({
  decide: async (principal, action, resource) => {
    const raw =
      action === 'use:operation' ||
      (action === 'invoke' && resource.id.startsWith(capabilityPrefix));
    if (raw)
      return isTryPrincipal(principal)
        ? { allow: true }
        : { allow: false, reason: 'only an operator may try a descriptor, through the raw tier' };
    if (isTryPrincipal(principal))
      return { allow: false, reason: 'the raw tier only tries descriptors' };
    return inner.decide(principal, action, resource);
  },
});

export interface OperationTry {
  descriptor: string;
  model: string;
  input: unknown;
  synthetic: boolean;
}

export type OperationTryOutcome =
  | { task: string; ok: true; result: unknown; exchange?: WireExchange }
  | { task?: string; ok: false; error: unknown };

export interface OperationTryDeps {
  kernel: () => Kernel;
  registry: CapabilityRegistry;
  platformTenant: string;
  tier: EnvironmentTier;
  admits?: (principal: Principal) => boolean;
  exchanges?: TryExchanges;
}

/** Runs one raw descriptor call as a kernel task of its own, granted only the chosen model. */
export const operationTryRunner =
  (deps: OperationTryDeps) =>
  async (operator: Principal, request: OperationTry): Promise<OperationTryOutcome> => {
    const id = `${capabilityPrefix}${randomUUID()}`;
    const capability: Capability<TryConfig> = {
      descriptor: {
        id,
        version: '1',
        tenant: deps.platformTenant,
        availableTo: [deps.platformTenant],
        title: `Try ${request.descriptor}`,
        description: 'A raw descriptor call on synthetic data, in test only',
        input: {},
        interaction: ['unary'],
        accepts: ['application/json'],
        produces: ['application/json'],
        emits: [],
        oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: '' },
      },
      strategy: { id: operationTryStrategyId, version: '1' },
      config: { descriptor: request.descriptor, model: request.model },
      grants: [{ port: 'operation', ref: { kind: 'model', id: request.model } }],
    };
    const principal = tryPrincipal(
      operator,
      deps.platformTenant,
      deps.admits ? deps.admits(operator) : true,
    );
    deps.registry.replace(() => false, [capability as Capability]);
    try {
      const run = await deps
        .kernel()
        .invoke(principal, id, { data: { input: request.input, synthetic: request.synthetic } });
      try {
        const parts = await run.result;
        const body = parts[0]?.body;
        const record = (body?.kind === 'json' ? body.json : undefined) as TryRecord | undefined;
        const exchange = deps.exchanges?.get(id);
        return {
          task: run.task,
          ok: true,
          result: record?.result,
          ...(exchange ? { exchange } : {}),
        };
      } catch (error) {
        return { task: run.task, ok: false, error };
      }
    } catch (error) {
      return { ok: false, error };
    } finally {
      deps.exchanges?.delete(id);
      deps.registry.replace((c) => c.descriptor.id === id, []);
    }
  };
