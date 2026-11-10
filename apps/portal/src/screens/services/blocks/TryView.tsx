import { Assistant } from '@genai/ui-assembly';
import '@genai/ui-assembly/styles.css';
import type { AssistantLayout } from '@genai/ui-blocks/builder';
import '@genai/ui-blocks/styles.css';
import { useMemo, useRef } from 'react';
import type { ApiClient } from '../../../api';
import { draftChannels } from './channels';
import { createDraftApi } from './draftApi';
import { draftServiceOf, type DraftSource } from './draftService';
import { previewWidth } from './preview-size';

/** What the try view needs to run the assistant: the person's own login, and the draft. */
export interface TryRun {
  api: ApiClient;
  tenant: string;
  source?: DraftSource | undefined;
}

/** The assistant the layout describes, live on the draft through the portal's playground. */
export const TryView = ({ layout, run }: { layout: AssistantLayout; run: TryRun }) => {
  const source = useRef(run.source);
  source.current = run.source;
  const service = draftServiceOf(run.source);
  const api = useMemo(
    () => createDraftApi({ api: run.api, tenant: run.tenant, source: () => source.current }),
    [run.api, run.tenant],
  );
  return (
    <Assistant
      api={api}
      layout={layout}
      service={service}
      tenant={run.tenant}
      channels={draftChannels}
      frameWidth={previewWidth}
    />
  );
};

export default TryView;
