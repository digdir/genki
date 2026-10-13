import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import type { PlaygroundTestSet } from '../../api/playground';
import { useT, type T } from '../../i18n';

export interface TestCaseDraft {
  testSet: string;
  question: string;
  expected: string;
}

export const testSetLabel = (set: PlaygroundTestSet, owners: Record<string, string>, t: T) => {
  const owner = owners[set.service ?? set.skill ?? ''];
  const label = t('playground.testSetLabel', { name: set.name, count: set.cases });
  return owner ? t('playground.testSetOwned', { owner, label }) : label;
};

export const SaveAsTestCase = ({
  testSets,
  owners,
  initial,
  onSend,
  onCancel,
}: {
  testSets: PlaygroundTestSet[];
  owners: Record<string, string>;
  initial: TestCaseDraft;
  onSend: (draft: TestCaseDraft) => Promise<void>;
  onCancel: () => void;
}) => {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState('');
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (sending) return;
    if (!draft.question.trim() || !draft.expected.trim()) {
      setProblem(t('playground.needBoth'));
      return;
    }
    setSending(true);
    setFailed(false);
    try {
      await onSend(draft);
    } catch {
      setFailed(true);
      setSending(false);
    }
  };
  return (
    <div className="playground-form">
      <Heading level={3} data-size="2xs">
        {t('playground.saveAsTest')}
      </Heading>
      <Paragraph data-size="sm" className="playground-subtle">
        {t('playground.saveIntro')}
      </Paragraph>
      <Field>
        <Label htmlFor={`${id}-set`}>{t('playground.testSet')}</Label>
        <Select
          id={`${id}-set`}
          value={draft.testSet}
          onChange={(e) => setDraft({ ...draft, testSet: e.target.value })}
        >
          {testSets.map((s) => (
            <Select.Option key={s.id} value={s.id}>
              {testSetLabel(s, owners, t)}
            </Select.Option>
          ))}
        </Select>
      </Field>
      <Field>
        <Label htmlFor={`${id}-q`}>{t('playground.question')}</Label>
        <Textarea
          id={`${id}-q`}
          rows={2}
          value={draft.question}
          onChange={(e) => {
            setDraft({ ...draft, question: e.target.value });
            setProblem('');
          }}
        />
      </Field>
      <Field>
        <Label htmlFor={`${id}-exp`}>{t('playground.expectedAnswer')}</Label>
        <Field.Description>{t('playground.expectedHelp')}</Field.Description>
        <Textarea
          id={`${id}-exp`}
          rows={4}
          value={draft.expected}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            setDraft({ ...draft, expected: e.target.value });
            setProblem('');
          }}
        />
        {problem ? <ValidationMessage>{problem}</ValidationMessage> : null}
      </Field>
      {failed ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{t('playground.sendFailed')}</Paragraph>
        </Alert>
      ) : null}
      <div className="playground-actions">
        <Button
          variant="primary"
          data-size="sm"
          aria-disabled={sending ? true : undefined}
          onClick={() => void send()}
        >
          {t('playground.sendProposal')}
        </Button>
        <Button variant="secondary" data-size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
