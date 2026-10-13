import { useSchema, useSchemaList, type UiSchema } from '@genai/schema-forms';
import type { ApiClient } from '../../api';

export const useStrategySchema = (
  api: ApiClient,
  strategyId: string,
): { schema: UiSchema | undefined; loading: boolean } => {
  const list = useSchemaList(api.getJson);
  const href =
    list.status === 'ready'
      ? list.data
          .find((ref) => ref.kind === 'Service')
          ?.uses?.find(
            (use) =>
              use.at.endsWith('strategy.config') &&
              (use.when === undefined || use.when.equals === strategyId),
          )?.href
      : undefined;
  const loaded = useSchema(api.getJson, href);
  const loading = list.status === 'loading' || (href !== undefined && loaded.status === 'loading');
  return { schema: href && loaded.status === 'ready' ? loaded.data : undefined, loading };
};
