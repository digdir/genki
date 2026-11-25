import {
  Checkbox,
  Fieldset,
  Input,
  Label,
  Paragraph,
  Table,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { blockZones, type BlockZone } from '@genai/contracts/blocks';
import { useEffect, useId, useMemo, useState } from 'react';
import type { FieldProblem } from '../../api/design';
import { useT } from '../../i18n';
import { parseYaml, toYaml } from '../../yaml';
import { templateEvents, templateStates, templateTextKeys, type BlockDraft } from './definitions';
import { zoneKey } from './naming';
import { FieldErrors } from './Problems';

type Texts = { nb: Record<string, string>; en: Record<string, string> };

const filled = (texts: Record<string, string>) =>
  Object.fromEntries(Object.entries(texts).filter(([, value]) => value.trim() !== ''));

/** The draft definition the fields describe, or why the template cannot be read. */
export const editedDeclarative = (
  base: BlockDraft,
  edit: { nb: string; en: string; zones: BlockZone[]; yaml: string; texts: Texts },
): BlockDraft | 'not-yaml' => {
  let template: unknown;
  try {
    template = parseYaml(edit.yaml);
  } catch {
    return 'not-yaml';
  }
  if (!template || typeof template !== 'object' || Array.isArray(template)) return 'not-yaml';
  const title = { ...base.spec.title, nb: edit.nb.trim() };
  if (edit.en.trim()) title.en = edit.en.trim();
  else delete title.en;
  return {
    ...base,
    metadata: { ...base.metadata, name: edit.nb.trim() },
    spec: {
      ...base.spec,
      title,
      zones: blockZones.filter((z) => edit.zones.includes(z)),
      events: templateEvents(template),
      states: templateStates(template, base.spec.states),
      texts: { ...base.spec.texts, nb: filled(edit.texts.nb), en: filled(edit.texts.en) },
      template: template as Record<string, unknown>,
    },
  };
};

/** «Struktur» of an own block without code: names, zones, the template as YAML and its texts. */
export const StructureEditor = ({
  base,
  errors,
  onChange,
}: {
  base: BlockDraft;
  errors: FieldProblem[];
  onChange: (edited: BlockDraft | 'not-yaml') => void;
}) => {
  const t = useT();
  const templateId = useId();
  const [nb, setNb] = useState(base.spec.title.nb ?? '');
  const [en, setEn] = useState(base.spec.title.en ?? '');
  const [zones, setZones] = useState<BlockZone[]>(base.spec.zones);
  const [yaml, setYaml] = useState(() => toYaml(base.spec.template ?? {}));
  const [texts, setTexts] = useState<Texts>({
    nb: { ...base.spec.texts?.nb },
    en: { ...base.spec.texts?.en },
  });
  const [touched, setTouched] = useState(false);
  const edited = useMemo(
    () => editedDeclarative(base, { nb, en, zones, yaml, texts }),
    [base, nb, en, zones, yaml, texts],
  );
  const keys = useMemo(() => {
    const used = edited === 'not-yaml' ? [] : templateTextKeys(edited.spec.template);
    return [...new Set([...Object.keys(texts.nb), ...Object.keys(texts.en), ...used])].sort();
  }, [edited, texts]);

  useEffect(() => {
    if (touched) onChange(edited);
  }, [edited, touched, onChange]);

  const touch =
    <V,>(set: (value: V) => void) =>
    (value: V) => {
      setTouched(true);
      set(value);
    };
  const setText = (language: keyof Texts, key: string, value: string) => {
    setTouched(true);
    setTexts((current) => ({ ...current, [language]: { ...current[language], [key]: value } }));
  };

  return (
    <div className="stack design-content">
      <div className="design-names">
        <Textfield
          label={t('design.nameNb')}
          value={nb}
          onChange={(e) => touch(setNb)(e.target.value)}
        />
        <Textfield
          label={t('design.nameEn')}
          value={en}
          onChange={(e) => touch(setEn)(e.target.value)}
        />
      </div>
      <Fieldset>
        <Fieldset.Legend>{t('design.zonesLegend')}</Fieldset.Legend>
        <div className="design-checks">
          {blockZones.map((zone) => (
            <Checkbox
              key={zone}
              label={t(zoneKey[zone])}
              checked={zones.includes(zone)}
              onChange={() =>
                touch(setZones)(
                  zones.includes(zone) ? zones.filter((z) => z !== zone) : [...zones, zone],
                )
              }
            />
          ))}
        </div>
      </Fieldset>
      <div className="stack-xs">
        <Label htmlFor={templateId}>{t('design.structure')}</Label>
        <Textarea
          id={templateId}
          rows={14}
          className="design-code"
          spellCheck={false}
          value={yaml}
          onChange={(e) => touch(setYaml)(e.target.value)}
        />
        {edited === 'not-yaml' ? (
          <Paragraph data-size="sm" className="design-missing">
            {t('design.structureNotYaml')}
          </Paragraph>
        ) : errors.length > 0 ? (
          <FieldErrors errors={errors} />
        ) : null}
      </div>
      <div className="design-texts" role="region" aria-label={t('design.texts')} tabIndex={0}>
        <Table data-size="sm">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell scope="col">{t('design.colKey')}</Table.HeaderCell>
              <Table.HeaderCell scope="col">{t('design.colNb')}</Table.HeaderCell>
              <Table.HeaderCell scope="col">{t('design.colEn')}</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {keys.map((key) => (
              <Table.Row key={key}>
                <Table.Cell className="design-key">{key}</Table.Cell>
                {(['nb', 'en'] as const).map((language) => (
                  <Table.Cell key={language}>
                    <Input
                      data-size="sm"
                      aria-label={t('design.textIn', {
                        key,
                        language: t(language === 'nb' ? 'design.colNb' : 'design.colEn'),
                      })}
                      value={texts[language][key] ?? ''}
                      onChange={(e) => setText(language, key, e.target.value)}
                    />
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    </div>
  );
};
