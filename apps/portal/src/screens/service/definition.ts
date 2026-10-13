import { ApiError } from '../../api';
import { translator, type T } from '../../i18n';
import { toYaml } from '../../yaml';

export const withoutVersion = (definition: Record<string, unknown>) => {
  const metadata = { ...(definition.metadata as Record<string, unknown> | undefined) };
  delete metadata.version;
  return { ...definition, metadata };
};

export const definitionYaml = (definition: Record<string, unknown>) =>
  toYaml(withoutVersion(definition));

export const problemErrors = (error: unknown, t: T = translator('nb')) =>
  error instanceof ApiError && error.problem?.errors?.length
    ? error.problem.errors
    : [{ path: '', message: error instanceof Error ? error.message : t('service.platformSilent') }];
