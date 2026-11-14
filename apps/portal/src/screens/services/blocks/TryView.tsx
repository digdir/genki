import { Assistant, profileOf, type AssistantApi, type AssistantProfile } from '@genai/ui-assembly';
import '@genai/ui-assembly/styles.css';
import type { AssistantLayout } from '@genai/ui-blocks/builder';
import '@genai/ui-blocks/styles.css';
import { useEffect } from 'react';
import type { ApiClient } from '../../../api';
import { useT } from '../../../i18n';
import { draftChannels } from './channels';
import { createDraftApi } from './draftApi';
import { draftServiceOf, type DraftSource, type RunProblem } from './draftService';
import { previewWidth } from './preview-size';

/** What the try view needs to run the assistant: the person's own login, and the draft. */
export interface TryRun {
  api: ApiClient;
  tenant: string;
  source?: DraftSource | undefined;
}

interface Kept {
  api: AssistantApi;
  source: DraftSource | undefined;
  profile: AssistantProfile | undefined;
  report: (problem: RunProblem | undefined) => void;
}

const kept = new WeakMap<ApiClient, Map<string, Kept>>();

/** One draft API per client, tenant and service, so this visit's threads outlive a remount. */
const draftApiFor = (run: TryRun, service: string, name: string): Kept => {
  const byKey = kept.get(run.api) ?? new Map<string, Kept>();
  kept.set(run.api, byKey);
  const key = `${run.tenant}\n${service}`;
  const found = byKey.get(key);
  if (found) return found;
  const holder: Omit<Kept, 'api'> = {
    source: run.source,
    profile: undefined,
    report: () => undefined,
  };
  const api = createDraftApi({
    api: run.api,
    tenant: run.tenant,
    source: () => holder.source,
    name,
    onProblem: (problem) => holder.report(problem),
    profile: () => holder.profile,
  });
  const entry: Kept = Object.assign(holder, { api });
  byKey.set(key, entry);
  return entry;
};

/** The assistant the layout describes, live on the draft through the portal's playground. */
export const TryView = ({
  layout,
  run,
  onProblem,
}: {
  layout: AssistantLayout;
  run: TryRun;
  onProblem?: ((problem: RunProblem | undefined) => void) | undefined;
}) => {
  const t = useT();
  const service = draftServiceOf(run.source);
  const entry = draftApiFor(run, service, t('playground.pageTitle'));
  entry.source = run.source;
  // The portal has no profile of its own for a draft: the layout's is the one it is drawn with.
  entry.profile = profileOf(layout);
  useEffect(() => {
    entry.report = onProblem ?? (() => undefined);
    return () => {
      entry.report = () => undefined;
    };
  }, [entry, onProblem]);
  return (
    <Assistant
      api={entry.api}
      layout={layout}
      service={service}
      tenant={run.tenant}
      channels={draftChannels}
      frameWidth={previewWidth}
    />
  );
};

export default TryView;
