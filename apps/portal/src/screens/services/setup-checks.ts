import { ApiError, type ApiClient } from '../../api';
import type { PublishProblem } from '../service/publish';

export interface DraftChecks {
  revision: number;
  ready: boolean;
  problems: PublishProblem[];
  hooksSkipped: boolean;
}

export const draftChecks = async (
  api: ApiClient,
  tenant: string,
  id: string,
  signal?: AbortSignal,
): Promise<DraftChecks | null> => {
  try {
    const found = (await api.getJson(
      `/tenants/${encodeURIComponent(tenant)}/services/${encodeURIComponent(id)}/draft/checks`,
      signal,
    )) as Partial<DraftChecks> | undefined;
    if (typeof found?.ready !== 'boolean') return null;
    return {
      revision: typeof found.revision === 'number' ? found.revision : 0,
      ready: found.ready,
      problems: Array.isArray(found.problems) ? found.problems : [],
      hooksSkipped: found.hooksSkipped === true,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
};
