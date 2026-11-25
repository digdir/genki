import type { ApiClient } from '../../api';
import type { ImportResult } from '../../api/design';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { Loading } from '../../states';
import { DesignPreview } from './DesignPreview';
import { FieldErrors, Problems } from './Problems';

/** What an imported design would draw, through the preview route; nothing is saved. */
export const ImportPreview = ({
  api,
  tenant,
  result,
}: {
  api: ApiClient;
  tenant: string;
  result: ImportResult;
}) => {
  const t = useT();
  const [preview] = useAsync(
    () => api.design.preview(tenant, result.definition, result.files),
    [api, tenant, result],
  );
  if (preview.status === 'loading')
    return <Loading label={t('design.tabPreview')} shape="detail" />;
  if (preview.status === 'error') return <Problems error={preview.error} />;
  if (!preview.data.valid || !preview.data.render)
    return <FieldErrors errors={preview.data.errors ?? []} />;
  return (
    <DesignPreview payload={preview.data.render} fixtures={preview.data.fixtures} tools={false} />
  );
};
