import {
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import type { AssistantLayout, LayoutProblem, ProfileData } from '@genai/ui-blocks/builder';
import { useId, useState } from 'react';
import { useT, type PlainKey, type T } from '../../../i18n';
import { blockLabel } from './BlocksPanel';
import { layoutJson, readLayout } from './layoutStore';
import { pluralRows } from './profileEdit';

const panelName: Record<'primary' | 'main' | 'secondary', PlainKey> = {
  primary: 'builderBlocks.panelLeft',
  main: 'builderBlocks.panelMain',
  secondary: 'builderBlocks.panelRight',
};

const linkLabels = new Map<string, PlainKey>([
  ['digits', 'builderTexts.linkDigits'],
  ['uuid', 'builderTexts.linkUuid'],
  ['any', 'builderTexts.linkAny'],
]);

/** Each text of a profile by its path, named as «Tekster» names its field and where it stands. */
const textLabels = (profile: ProfileData | undefined, t: T) => {
  const labels = new Map<string, string>();
  const name = (path: string, label: string, ...where: string[]) =>
    labels.set(path, t('builderBlocks.pasteFieldIn', { label, where: where.join(', ') }));
  const assistant = t('builderTexts.assistantTitle');
  name('profile.assistantName', t('builderTexts.name'), assistant);
  name('profile.suggestions', t('builderTexts.suggestions'), assistant);
  profile?.suggestions?.forEach((_, n) =>
    name(`profile.suggestions[${n}]`, t('builderTexts.suggestion', { n: n + 1 }), assistant),
  );
  name('profile.settingsNote', t('builderTexts.settingsNote'), assistant);
  labels.set('profile.corpora', t('builderTexts.collectionsTitle'));
  for (const [key, corpus] of Object.entries(profile?.corpora ?? {})) {
    // A key with a dot or bracket could make another text's path, so its texts keep theirs.
    if (key.includes('.') || key.includes('[')) continue;
    const at = `profile.corpora.${key}`;
    const collection = t('builderTexts.collection', { key });
    labels.set(at, collection);
    name(`${at}.label`, t('builderTexts.label'), collection);
    name(`${at}.description`, t('builderTexts.description'), collection);
    name(`${at}.typeField`, t('builderTexts.typeField'), collection);
    name(`${at}.fields`, t('builderTexts.fieldsTitle'), collection);
    corpus.fields?.forEach((field, n) => {
      const fieldAt = `${at}.fields[${n}]`;
      const named = t('builderTexts.field', { id: field.id });
      name(`${fieldAt}.id`, named, collection);
      name(`${fieldAt}.kind`, named, collection);
      name(`${fieldAt}.label`, t('builderTexts.fieldLabel'), collection, named);
      name(`${fieldAt}.heading`, t('builderTexts.fieldHeading'), collection, named);
    });
    name(`${at}.typePlurals`, t('builderTexts.plurals'), collection);
    pluralRows(corpus).forEach(([type], n) =>
      name(`${at}.typePlurals.${type}`, t('builderTexts.pluralWord', { n: n + 1 }), collection),
    );
    for (const pattern of Object.keys(corpus.documentLinks ?? {})) {
      const label = linkLabels.get(pattern);
      if (label)
        name(`${at}.documentLinks.${pattern}`, t(label), collection, t('builderTexts.linksTitle'));
    }
  }
  return labels;
};

/** One broken rule of a pasted layout, in the portal's words; a text by its field in «Tekster». */
const problemText = (problem: LayoutProblem, t: T, labels: ReadonlyMap<string, string>) => {
  const named = (path: string) => labels.get(path) ?? path;
  switch (problem.rule) {
    case 'unknown-block':
      return t('builderBlocks.pasteUnknownBlock', { block: problem.block });
    case 'profile-too-large':
      return t('builderBlocks.pasteProfileTooLarge', { max: problem.max });
    case 'text-too-long':
      return t('builderBlocks.pasteTextTooLong', { path: named(problem.path), max: problem.max });
    case 'too-many':
      return t('builderBlocks.pasteTooMany', { path: named(problem.path), max: problem.max });
    case 'link-not-https':
      return t('builderBlocks.pasteLinkNotHttps', { path: named(problem.path) });
    case 'unknown-kind':
      return t('builderBlocks.pasteUnknownKind', { path: named(problem.path), kind: problem.kind });
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
    if (read.problem === 'breaks-rules') {
      const labels = textLabels(read.pasted.profile, t);
      setError({
        message: t('builderBlocks.pasteBreaksRules'),
        problems: read.problems.map((p) => problemText(p, t, labels)),
      });
      return;
    }
    setError({
      message: t(
        read.problem === 'not-json' ? 'builderBlocks.pasteNotJson' : 'builderBlocks.pasteNotLayout',
      ),
      problems: [],
    });
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
