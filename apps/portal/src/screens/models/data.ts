import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { entriesOf } from '../../models';
import { settled } from '../buildingblocks/common';

export const useModelEntries = (api: ApiClient, tenant: string) =>
  useAsync(
    async (signal) => {
      const [models, blocks] = await Promise.all([
        api.models.catalog(signal),
        settled(api.buildingBlocks.list(tenant, { kind: 'model' }, signal)),
      ]);
      const facts = blocks.ok
        ? blocks.data.data.map((b) => ({ id: b.id, status: b.status, usedBy: b.usedBy }))
        : [];
      return { entries: entriesOf(models, facts), usageKnown: blocks.ok };
    },
    [api, tenant],
    { keepPreviousFor: tenant },
  );
