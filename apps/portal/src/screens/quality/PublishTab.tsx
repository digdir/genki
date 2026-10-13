import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { PublishSummary, type QualityGate } from '../../components/PublishSummary';
import { currentUser, qualityGates, qualityUpdates } from '../../data/quality';
import { useT } from '../../i18n';
import { rightLabel } from '../../Shell';
import type { SetFlash } from './shared';

export const PublishTab = ({
  tenantName,
  currentVersion,
  approvers,
  onPublish,
  setFlash,
}: {
  tenantName: string;
  currentVersion: number;
  approvers: string[];
  onPublish: (reason: string) => Promise<void>;
  setFlash: SetFlash;
}) => {
  const t = useT();
  const f = useFormat();
  const [fixed, setFixed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const next = currentVersion + 1;

  const gates: QualityGate[] = qualityGates.map(([name, value, state, why]) => {
    const failing = state === 'fail' && !fixed;
    return {
      name,
      value: state === 'fail' && fixed ? t('quality.fixedGate') : value,
      passed: !failing,
      ...(failing && why ? { explanation: why } : {}),
    };
  });

  const approvedBy = approvers.length ? f.list(approvers) : currentUser;

  return (
    <PublishSummary
      tenantName={tenantName}
      currentVersion={currentVersion}
      nextVersion={next}
      changes={[
        t('quality.changeYear', { approvedBy }),
        t('quality.changeSearch'),
        ...(fixed ? [t('quality.changeLanguage')] : []),
      ]}
      updates={qualityUpdates}
      facts={[
        {
          label: t('quality.factAll'),
          value: t('quality.factAllValue', { version: String(currentVersion) }),
        },
        {
          label: t('quality.factLocked'),
          value: t(fixed ? 'quality.factLockedFixed' : 'quality.factLockedValue', {
            version: String(currentVersion),
          }),
        },
        {
          label: t('quality.factPer1000'),
          value: t('quality.factPer1000Value', { version: String(currentVersion) }),
        },
      ]}
      gates={gates}
      apiCall={{
        action: t('quality.publishVersion', { version: String(next) }),
        method: 'POST',
        path: '/definitions',
        body: { definition: '…', files: {} },
        right: rightLabel(t, 'manage-services'),
        endpoint: 'tj-pub',
      }}
      fixAction={{
        label: t(fixed ? 'quality.rerun' : 'quality.addLanguageLine'),
        onClick: () => {
          setFlash({ text: t('quality.rerunning'), color: 'info' });
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            setFixed(true);
            setFlash({ text: t('quality.rerunDone'), color: 'success' });
          }, 1200);
        },
      }}
      onPublish={({ reason }) => onPublish(reason)}
      onPublishToTest={() => undefined}
    />
  );
};
