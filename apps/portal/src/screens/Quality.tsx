import { Alert, Link } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { FeedbackDetail } from '../data/quality';
import { usePortalFormat } from '../format';
import { useAsync } from '../hooks';
import type { ServiceScreenProps } from '../screen';
import { ErrorState, Loading } from '../states';
import { TenantGates } from './config/TenantGates';
import { FeedbackTab, feedbackFrom } from './quality/FeedbackTab';
import { LiveTestSets } from './quality/LiveTestSets';
import { QualityPage, qualityAddress } from './quality/QualityPage';
import { problemTitle, type Flash, type SetFlash } from './quality/shared';
import './quality.css';

type View =
  | { kind: 'page' }
  | { kind: 'testsets'; set?: string; run?: string }
  | { kind: 'feedback' }
  | { kind: 'gates' };

const oldTabs: Record<string, View['kind']> = {
  testsets: 'testsets',
  ts: 'testsets',
  feedback: 'feedback',
  fb: 'feedback',
  gates: 'gates',
};

const viewFrom = (query: URLSearchParams): View => {
  const set = query.get('set');
  if (set) {
    const run = query.get('run');
    return { kind: 'testsets', set, ...(run ? { run } : {}) };
  }
  const kind = query.get('view') ?? oldTabs[query.get('tab') ?? ''];
  return kind === 'testsets' || kind === 'feedback' || kind === 'gates'
    ? { kind }
    : { kind: 'page' };
};

const AllFeedback = ({
  api,
  tenant,
  id,
  setFlash,
}: {
  api: ServiceScreenProps['api'];
  tenant: string;
  id: string;
  setFlash: SetFlash;
}) => {
  const { t, f } = usePortalFormat();
  const [added, setAdded] = useState<Record<string, string>>({});
  const [state, retry] = useAsync(
    async (signal) => feedbackFrom(await api.listFeedback(tenant, id, signal), true, f),
    [api, tenant, id, f],
  );
  if (state.status === 'loading') return <Loading label={t('qualityPage.feedbackLoading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  return (
    <FeedbackTab
      feedback={state.data}
      added={added}
      onAdded={(fb, c) => setAdded((a) => ({ ...a, [fb]: c }))}
      onAddCase={() => ''}
      onShowProposal={() => undefined}
      onPropose={async (fb: FeedbackDetail, input: string, expected: string) => {
        try {
          await api.quality.proposeCandidate(
            tenant,
            {
              service: id,
              input,
              expected,
              origin: 'feedback',
              ...(fb.run ? { task: fb.run } : {}),
            },
            t('quality.proposeReason'),
          );
          return true;
        } catch (error) {
          setFlash({ text: problemTitle(error, t), color: 'danger' });
          return false;
        }
      }}
      setFlash={setFlash}
    />
  );
};

export const Quality = ({ api, tenant, route, id }: ServiceScreenProps) => {
  const { t } = usePortalFormat();
  const address = route.query.toString();
  const view = viewFrom(route.query);
  const [scoped, setScoped] = useState<{ address: string; flash: Flash }>();
  const setFlash: SetFlash = (next) => setScoped(next ? { address, flash: next } : undefined);
  const flash = scoped?.address === address ? scoped.flash : undefined;

  return (
    <div className="quality">
      {view.kind === 'page' ? null : (
        <Link href={qualityAddress(id)} className="quality-back">
          {t('qualityPage.back')}
        </Link>
      )}
      <div aria-live="polite" className="quality-flash">
        {flash ? (
          <Alert data-color={flash.color} data-size="sm">
            {flash.text}
          </Alert>
        ) : null}
      </div>
      {view.kind === 'page' ? (
        <QualityPage api={api} tenant={tenant} serviceId={id} setFlash={setFlash} />
      ) : view.kind === 'testsets' ? (
        <LiveTestSets
          key={address}
          api={api}
          tenant={tenant}
          serviceId={id}
          setFlash={setFlash}
          {...(view.set ? { initialSet: view.set } : {})}
          {...(view.run ? { openRun: view.run } : {})}
        />
      ) : view.kind === 'feedback' ? (
        <AllFeedback api={api} tenant={tenant} id={id} setFlash={setFlash} />
      ) : (
        <TenantGates api={api} tenant={tenant} />
      )}
    </div>
  );
};
