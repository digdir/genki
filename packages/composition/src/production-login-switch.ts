import type { ConfigEntryStore } from './config-store.js';
import { environmentTierOf } from './operation-try.js';

export const productionAnsattporten = 'https://ansattporten.no';

export const productionLoginSwitchKind = 'production-login-switch';
export const productionLoginSwitchId = 'testid-era-revoked';

type Env = Record<string, string | undefined>;

export const isTestOnProductionAnsattporten = (env: Env) =>
  environmentTierOf(env) === 'test' && env.ANSATTPORTEN_ISSUER === productionAnsattporten;

export const productionLoginSwitchOf = async (
  config: Pick<ConfigEntryStore, 'history'>,
  platformTenant: string,
) =>
  (await config.history(productionLoginSwitchKind, platformTenant, productionLoginSwitchId)).at(-1);

export const productionLoginSwitchDone = async (
  config: Pick<ConfigEntryStore, 'history'>,
  platformTenant: string,
) => {
  const marker = await productionLoginSwitchOf(config, platformTenant);
  return (
    marker !== undefined && !marker.deleted && (marker.spec as { state?: string }).state === 'done'
  );
};
