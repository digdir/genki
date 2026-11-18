import { Alert, Button, Dialog, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { PlaygroundOptions, PlaygroundSetup } from '../../api/playground';
import { changedFromStart, changeText, versionOf } from '../../data/playground';
import { useT } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { saveInDraft } from './startDraft';

export const SaveToDraft = ({
  api,
  tenant,
  options,
  setup,
  base,
  label,
  primary = false,
}: {
  api: ApiClient | undefined;
  tenant: string | undefined;
  options: PlaygroundOptions;
  setup: PlaygroundSetup;
  base: string | undefined;
  label: string;
  primary?: boolean;
}) => {
  const t = useT();
  const id = useId();
  const canSave = useRights().has('manage-services');
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ id: string; name: string }>();
  const [failed, setFailed] = useState('');
  const found = versionOf(options, setup);
  const changes = changedFromStart(options, setup, base);
  if (!api || !tenant || !found) return null;
  const name = found.service.name;
  const list = changes.map((c) => changeText(options, c, t));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setFailed('');
    try {
      await saveInDraft(
        api,
        tenant,
        setup,
        {
          model: changes.some((c) => c.kind === 'model'),
          instructions: changes.some((c) => c.kind === 'instructions'),
          datasets: changes.some((c) => c.kind === 'dataset'),
        },
        t('playground.saveDraftReason', { list: list.join(', ') }),
      );
      setDone({ id: found.service.id, name });
      setAsking(false);
    } catch (error) {
      setFailed(
        error instanceof ApiError && error.status === 409
          ? t('playground.saveDraftConflict')
          : t('playground.saveDraftFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {changes.length ? (
        <Button
          variant={primary ? 'primary' : 'tertiary'}
          data-size="sm"
          className={primary ? 'playground-draft-primary' : 'playground-draft-link'}
          aria-haspopup="dialog"
          aria-disabled={canSave ? undefined : true}
          onClick={() => {
            if (!canSave) return;
            setDone(undefined);
            setAsking(true);
          }}
        >
          {label}
        </Button>
      ) : null}
      {changes.length && !canSave ? (
        <span className="playground-subtle">{needsRight('manage-services', t)}</span>
      ) : null}
      {done ? (
        <Alert data-color="success" data-size="sm">
          <Paragraph data-size="sm">{t('playground.saveDraftDone', { name: done.name })}</Paragraph>
          <a href={`#/services/${encodeURIComponent(done.id)}/setup`}>
            {t('playground.saveDraftOpen', { name: done.name })}
          </a>
        </Alert>
      ) : null}
      {asking ? (
        <Dialog
          open
          modal
          closeButton={false}
          onClose={() => setAsking(false)}
          aria-labelledby={`${id}-title`}
        >
          <div className="stack-sm">
            <Heading level={2} data-size="xs" id={`${id}-title`}>
              {t('playground.saveDraftTitle', { name })}
            </Heading>
            <Paragraph data-size="sm">{t('playground.saveDraftLead')}</Paragraph>
            <ul>
              {list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <Paragraph data-size="sm">{t('playground.saveDraftNoPublish')}</Paragraph>
            {failed ? (
              <Alert data-color="danger" data-size="sm">
                {failed}
              </Alert>
            ) : null}
            <div className="actions">
              <Button aria-disabled={saving || undefined} onClick={() => void save()}>
                {t('playground.saveDraftConfirm')}
              </Button>
              <Button variant="secondary" onClick={() => setAsking(false)}>
                {t('playground.saveDraftCancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
};
