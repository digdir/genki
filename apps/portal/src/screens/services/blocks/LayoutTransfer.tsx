import {
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import type { AssistantLayout, LayoutProblem } from '@genai/ui-blocks/builder';
import { useId, useState } from 'react';
import { useT, type PlainKey, type T } from '../../../i18n';
import { blockLabel } from './BlocksPanel';
import { layoutJson, readLayout } from './layoutStore';

const panelName: Record<'primary' | 'main' | 'secondary', PlainKey> = {
  primary: 'builderBlocks.panelLeft',
  main: 'builderBlocks.panelMain',
  secondary: 'builderBlocks.panelRight',
};

/** One broken rule of a pasted layout, in the portal's words. */
const problemText = (problem: LayoutProblem, t: T) => {
  switch (problem.rule) {
    case 'unknown-block':
      return t('builderBlocks.pasteUnknownBlock', { block: problem.block });
    case 'profile-too-large':
      return t('builderBlocks.pasteProfileTooLarge', { max: problem.max });
    case 'text-too-long':
      return t('builderBlocks.pasteTextTooLong', { path: problem.path, max: problem.max });
    case 'too-many':
      return t('builderBlocks.pasteTooMany', { path: problem.path, max: problem.max });
    case 'link-not-https':
      return t('builderBlocks.pasteLinkNotHttps', { path: problem.path });
    case 'unknown-kind':
      return t('builderBlocks.pasteUnknownKind', { path: problem.path, kind: problem.kind });
  }
  const block = t(blockLabel(problem.block));
  switch (problem.rule) {
    case 'zone-not-allowed':
      return t('builderBlocks.pasteWrongPanel', {
        block,
        panel: t(panelName[problem.zone]).toLocaleLowerCase(),
      });
    case 'placed-twice':
      return t('builderBlocks.pastePlacedTwice', { block });
    case 'not-built':
      return t('builderBlocks.pasteNotBuilt', { block });
    case 'missing-partner':
      return t('builderBlocks.pasteMissingPartner', {
        block,
        partner: t(blockLabel(problem.partner)),
      });
    case 'needs-unmet':
      return t('builderBlocks.pasteNeedsUnmet', { block });
  }
};

/**
 * «Kopier oppsettet» and «Lim inn oppsett»: the layout as JSON, to carry it to another browser or
 * a host, since the portal keeps it only in this browser for now.
 */
export const LayoutTransfer = ({
  layout,
  onPaste,
}: {
  layout: AssistantLayout;
  onPaste: (layout: AssistantLayout) => void;
}) => {
  const t = useT();
  const ids = { heading: useId(), paste: useId(), copied: useId() };
  const [copy, setCopy] = useState<'copied' | 'failed'>();
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<{ message: string; problems: readonly string[] }>();
  const [pasted, setPasted] = useState(false);
  const json = layoutJson(layout);

  const copyLayout = async () => {
    setPasted(false);
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(json);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  const paste = () => {
    const read = readLayout(text);
    if ('layout' in read) {
      onPaste(read.layout);
      setPasting(false);
      setText('');
      setError(undefined);
      setPasted(true);
      return;
    }
    setError(
      read.problem === 'breaks-rules'
        ? {
            message: t('builderBlocks.pasteBreaksRules'),
            problems: read.problems.map((p) => problemText(p, t)),
          }
        : {
            message: t(
              read.problem === 'not-json'
                ? 'builderBlocks.pasteNotJson'
                : 'builderBlocks.pasteNotLayout',
            ),
            problems: [],
          },
    );
  };

  return (
    <section className="blocks-transfer stack-sm" aria-labelledby={ids.heading}>
      <Heading level={3} data-size="2xs" id={ids.heading}>
        {t('builderBlocks.transferTitle')}
      </Heading>
      <Paragraph data-size="sm" className="meta">
        {t('builderBlocks.transferHelp')}
      </Paragraph>
      <div className="blocks-transfer-actions">
        <Button variant="secondary" data-size="sm" onClick={() => void copyLayout()}>
          {t('builderBlocks.copyLayout')}
        </Button>
        <Button
          variant="secondary"
          data-size="sm"
          aria-expanded={pasting}
          aria-controls={pasting ? ids.paste : undefined}
          onClick={() => {
            setPasting((open) => !open);
            setCopy(undefined);
            setPasted(false);
            setError(undefined);
          }}
        >
          {t('builderBlocks.pasteLayout')}
        </Button>
      </div>
      <p role="status" className="meta">
        {copy === 'copied'
          ? t('builderBlocks.copied')
          : copy === 'failed'
            ? t('builderBlocks.copyFailed')
            : pasted
              ? t('builderBlocks.pasted')
              : ''}
      </p>
      {copy === 'failed' ? (
        <Field>
          <Label htmlFor={ids.copied}>{t('builderBlocks.layoutJson')}</Label>
          <Textarea id={ids.copied} rows={6} readOnly value={json} />
        </Field>
      ) : null}
      {pasting ? (
        <div className="stack-sm" id={ids.paste}>
          <Field>
            <Label htmlFor={`${ids.paste}-text`}>{t('builderBlocks.pasteLabel')}</Label>
            <Textarea
              id={`${ids.paste}-text`}
              rows={6}
              value={text}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setError(undefined);
              }}
            />
            {error ? (
              <ValidationMessage>{[error.message, ...error.problems].join(' ')}</ValidationMessage>
            ) : null}
          </Field>
          <div className="blocks-transfer-actions">
            <Button data-size="sm" onClick={paste}>
              {t('builderBlocks.pasteUse')}
            </Button>
            <Button
              variant="tertiary"
              data-size="sm"
              onClick={() => {
                setPasting(false);
                setText('');
                setError(undefined);
              }}
            >
              {t('builderBlocks.pasteCancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
};
