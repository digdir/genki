import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Textarea,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient, PublishedRunResult } from '../../api';
import { Attachments } from '../../components/Attachments';
import { useT } from '../../i18n';

interface Props {
  api: ApiClient;
  model: string;
  version: number | undefined;
}

export const PublishedTest = ({ api, model, version }: Props) => {
  const t = useT();
  const [text, setText] = useState('');
  const [textErr, setTextErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishedRunResult>();
  const [failed, setFailed] = useState('');

  const run = async () => {
    if (busy) return;
    if (!text.trim()) {
      setTextErr(t('serviceTest.queryRequired'));
      return;
    }
    setBusy(true);
    setResult(undefined);
    setFailed('');
    try {
      setResult(await api.runPublished(model, text.trim()));
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack-sm published-test" aria-labelledby="published-test-h">
      <Heading level={2} data-size="xs" id="published-test-h">
        {t('serviceTest.publishedTitle')}
      </Heading>
      {version === undefined ? (
        <Alert data-color="warning" data-size="sm">
          {t('serviceTest.publishedMissing')}
        </Alert>
      ) : (
        <>
          <Alert data-color="info" data-size="sm">
            {t('serviceTest.publishedNote', { version })}
          </Alert>
          <Field>
            <Label htmlFor="published-test-text">{t('serviceTest.question')}</Label>
            <Textarea
              id="published-test-text"
              rows={3}
              value={text}
              aria-invalid={textErr ? true : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setTextErr('');
              }}
            />
            {textErr ? <Field.Description role="alert">{textErr}</Field.Description> : null}
          </Field>
          <Button
            variant="primary"
            data-size="sm"
            className="align-start"
            loading={busy}
            onClick={() => void run()}
          >
            {t('serviceTest.publishedRun', { version })}
          </Button>
        </>
      )}
      <div aria-live="polite" className="stack-sm">
        {result ? (
          <div className="test-run-result stack-xs">
            <span className="strong">{t('serviceTest.answer')}</span>
            {result.answer.trim() ? <p className="pre-wrap">{result.answer}</p> : null}
            <Attachments items={result.attachments} load={api.media} />
            {result.task ? (
              <a href={`#/log/${encodeURIComponent(result.task)}`} className="meta">
                {t('serviceTest.seeRun')}
              </a>
            ) : null}
          </div>
        ) : null}
        {failed ? (
          <Alert data-color="danger" data-size="sm">
            <Paragraph data-size="sm">
              {t('serviceTest.publishedFailed', { detail: failed })}
            </Paragraph>
          </Alert>
        ) : null}
      </div>
      {version === undefined ? null : <p className="meta">{t('serviceTest.draftNoOperations')}</p>}
    </section>
  );
};
