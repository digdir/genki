import { Assistant, profileOf, type AssistantApi, type AssistantProfile } from '@genai/ui-assembly';
import '@genai/ui-assembly/styles.css';
import type { AssistantLayout } from '@genai/ui-blocks/builder';
import '@genai/ui-blocks/styles.css';
import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../../api';
import { useT } from '../../../i18n';
import { draftChannels } from './channels';
import { createDraftApi } from './draftApi';
import { draftServiceOf, type DraftSource, type RunProblem } from './draftService';
import { previewWidth } from './preview-size';
import { drawnProfile } from './profileEdit';

/** What the try view needs to run the assistant: the person's own login, and the draft. */
export interface TryRun {
  api: ApiClient;
  tenant: string;
  source?: DraftSource | undefined;
}

/** Why the thread's answer failed, or without a thread why the draft was refused; or nothing. */
export type ReportProblem = (problem: RunProblem | undefined, thread?: string) => void;

interface Kept {
  api: AssistantApi;
  source: DraftSource | undefined;
  profile: AssistantProfile | undefined;
  report: ReportProblem;
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
    onProblem: (problem, thread) => holder.report(problem, thread),
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
  onThreadChange,
}: {
  layout: AssistantLayout;
  run: TryRun;
  onProblem?: ReportProblem | undefined;
  /** The thread on screen: its id, or `undefined` for a new one. */
  onThreadChange?: ((thread: string | undefined) => void) | undefined;
}) => {
  const t = useT();
  const service = draftServiceOf(run.source);
  const entry = draftApiFor(run, service, t('playground.pageTitle'));
  entry.source = run.source;
  // What the person typed, drawn: an empty text draws nothing.
  const drawn = useMemo(
    () => (layout.profile ? { ...layout, profile: drawnProfile(layout.profile) } : layout),
    [layout],
  );
  // The portal has no profile of its own for a draft: the layout's is the one it is drawn with.
  entry.profile = profileOf(drawn);
  // The assistant reads a collection's fields and names once per api: a change of them is read
  // again when the typing settles, on the same draft API and so the same threads.
  const corpora = JSON.stringify(drawn.profile?.corpora ?? null);
  const [settled, setSettled] = useState(corpora);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(corpora), 400);
    return () => clearTimeout(timer);
  }, [corpora]);
  // `settled` makes it another api for the assistant.
  const api = useMemo(() => ({ ...entry.api }), [entry, settled]);
  useEffect(() => {
    entry.report = onProblem ?? (() => undefined);
    return () => {
      entry.report = () => undefined;
    };
  }, [entry, onProblem]);
  return (
    <Assistant
      api={api}
      layout={drawn}
      service={service}
      tenant={run.tenant}
      channels={draftChannels}
      frameWidth={previewWidth}
      onThreadChange={onThreadChange}
    />
  );
};

export default TryView;
