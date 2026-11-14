import {
  Alert,
  Button,
  Details,
  Divider,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Select,
  Switch,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import {
  profileLimits,
  profileProblems,
  type AssistantLayout,
  type DocumentIdPattern,
  type ProfileCorpus,
  type ProfileData,
  type ProfileField,
  type ProfileProblem,
} from '@genai/ui-blocks/builder';
import { Fragment, useId, useState, type ReactNode } from 'react';
import { useT, type T } from '../../../i18n';
import { asKnowledgeAssistant } from './kaProfile';
import {
  corpusLink,
  corpusText,
  fieldsIn,
  pluralRows,
  problemsByPath,
  withCorpus,
  withField,
  withPlurals,
  withSuggestions,
  withText,
  type Collection,
} from './profileEdit';

/** One broken limit, in the words of the field it concerns. */
const problemText = (problem: ProfileProblem, t: T) => {
  switch (problem.rule) {
    case 'text-too-long':
      return t('builderTexts.tooLong', { max: problem.max });
    case 'too-many':
      return t('builderTexts.tooMany', { max: problem.max });
    case 'link-not-https':
      return t('builderTexts.notHttps', { id: '{id}' });
    case 'unknown-kind':
      return t('builderTexts.unknownKind', { kind: problem.kind });
    case 'profile-too-large':
      return t('builderTexts.tooLarge', { max: problem.max });
  }
};

const linkPatterns: { pattern: DocumentIdPattern; key: 'linkDigits' | 'linkUuid' | 'linkAny' }[] = [
  { pattern: 'digits', key: 'linkDigits' },
  { pattern: 'uuid', key: 'linkUuid' },
  { pattern: 'any', key: 'linkAny' },
];

/** A year typed into a field: a whole number, or nothing when the field is empty or not one. */
const yearOf = (text: string) => {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) ? value : undefined;
};

/**
 * «Tekster»: the words the layout's profile gives the assistant, edited beside the blocks. Each
 * limit the profile breaks is said under the field it concerns.
 */
export const TextsPanel = ({
  layout,
  collections,
  onChange,
}: {
  layout: AssistantLayout;
  /** The collections the draft searches, with their filter fields. */
  collections: readonly Collection[];
  onChange: (profile: ProfileData | undefined) => void;
}) => {
  const t = useT();
  const id = useId();
  const profile = layout.profile;
  const [filled, setFilled] = useState(false);
  const problems = problemsByPath(profile ? profileProblems(profile) : []);
  const errorAt = (path: string): ReactNode => {
    const found = problems.get(path);
    return found ? found.map((p) => problemText(p, t)).join(' ') : undefined;
  };
  const change = (next: ProfileData | undefined) => {
    setFilled(false);
    onChange(next);
  };
  const suggestions = profile?.suggestions ?? [];
  const known = new Set(collections.map((c) => c.key));
  const others = Object.keys(profile?.corpora ?? {}).filter((key) => !known.has(key));

  return (
    <div className="blocks-panel blocks-texts stack-sm">
      <Paragraph data-size="sm">{t('builderTexts.intro')}</Paragraph>
      {problems.has('profile') ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{errorAt('profile')}</Paragraph>
        </Alert>
      ) : null}
      {layout.template === 'knowledge-assistant-next' ? (
        <div className="stack-sm">
          <Paragraph data-size="sm" className="meta">
            {t('builderTexts.fillAsKaHelp')}
          </Paragraph>
          <div>
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() => {
                onChange(asKnowledgeAssistant(profile));
                setFilled(true);
              }}
            >
              {t('builderTexts.fillAsKa')}
            </Button>
          </div>
        </div>
      ) : null}
      <p role="status" className="meta">
        {filled ? t('builderTexts.filledAsKa') : ''}
      </p>

      <Divider />
      <Heading level={2} data-size="2xs">
        {t('builderTexts.assistantTitle')}
      </Heading>
      <Textfield
        data-size="sm"
        label={t('builderTexts.name')}
        description={t('builderTexts.nameHelp')}
        value={profile?.assistantName ?? ''}
        error={errorAt('profile.assistantName')}
        onChange={(e) => change(withText(profile, 'assistantName', e.target.value))}
      />
      <Fieldset data-size="sm">
        <Fieldset.Legend>{t('builderTexts.suggestions')}</Fieldset.Legend>
        <Fieldset.Description>
          {t('builderTexts.suggestionsHelp', { max: profileLimits.questions })}
        </Fieldset.Description>
        {suggestions.map((text, at) => (
          <div className="blocks-texts-row" key={at}>
            <Textfield
              data-size="sm"
              label={t('builderTexts.suggestion', { n: at + 1 })}
              value={text}
              error={errorAt(`profile.suggestions[${at}]`)}
              onChange={(e) =>
                change(
                  withSuggestions(
                    profile,
                    suggestions.map((s, i) => (i === at ? e.target.value : s)),
                  ),
                )
              }
            />
            <Button
              variant="tertiary"
              data-size="sm"
              onClick={() =>
                change(
                  withSuggestions(
                    profile,
                    suggestions.filter((_, i) => i !== at),
                  ),
                )
              }
            >
              {t('builderTexts.removeSuggestion', { n: at + 1 })}
            </Button>
          </div>
        ))}
        {errorAt('profile.suggestions') ? (
          <ValidationMessage data-size="sm">{errorAt('profile.suggestions')}</ValidationMessage>
        ) : null}
        <div>
          <Button
            variant="secondary"
            data-size="sm"
            disabled={suggestions.length >= profileLimits.questions}
            onClick={() => change(withSuggestions(profile, [...suggestions, '']))}
          >
            {t('builderTexts.addSuggestion')}
          </Button>
        </div>
      </Fieldset>
      <Textfield
        data-size="sm"
        multiline
        rows={2}
        label={t('builderTexts.settingsNote')}
        description={t('builderTexts.settingsNoteHelp')}
        value={profile?.settingsNote ?? ''}
        error={errorAt('profile.settingsNote')}
        onChange={(e) => change(withText(profile, 'settingsNote', e.target.value))}
      />

      <Divider />
      <Heading level={2} data-size="2xs">
        {t('builderTexts.collectionsTitle')}
      </Heading>
      {collections.length === 0 ? (
        <Paragraph data-size="sm" className="meta">
          {t('builderTexts.noCollections')}
        </Paragraph>
      ) : null}
      {collections.map((collection) => (
        <CollectionTexts
          key={collection.key}
          collection={collection}
          corpus={
            profile?.corpora && Object.hasOwn(profile.corpora, collection.key)
              ? profile.corpora[collection.key]
              : undefined
          }
          errorAt={errorAt}
          onChange={(edit) => change(withCorpus(profile, collection.key, edit))}
          idPrefix={`${id}-${collection.key}`}
        />
      ))}
      {others.length > 0 ? (
        <Fieldset data-size="sm">
          <Fieldset.Legend>{t('builderTexts.otherCollections')}</Fieldset.Legend>
          {others.map((key) => (
            <div key={key}>
              <Button
                variant="tertiary"
                data-size="sm"
                onClick={() => change(withCorpus(profile, key, () => undefined))}
              >
                {t('builderTexts.removeCollection', { key })}
              </Button>
            </div>
          ))}
        </Fieldset>
      ) : null}
    </div>
  );
};

const CollectionTexts = ({
  collection,
  corpus,
  errorAt,
  onChange,
  idPrefix,
}: {
  collection: Collection;
  corpus: ProfileCorpus | undefined;
  errorAt: (path: string) => ReactNode;
  onChange: (edit: (corpus: ProfileCorpus) => ProfileCorpus | undefined) => void;
  idPrefix: string;
}) => {
  const t = useT();
  const at = `profile.corpora.${collection.key}`;
  const fields = fieldsIn(corpus, collection.fields);
  const plurals = pluralRows(corpus);
  // The row whose type was refused, since another row has it.
  const [taken, setTaken] = useState<number>();
  const typeFieldId = `${idPrefix}-type-field`;
  return (
    <Details data-color="neutral" className="blocks-options">
      <Details.Summary>{t('builderTexts.collection', { key: collection.key })}</Details.Summary>
      <Details.Content className="stack-sm">
        <Textfield
          data-size="sm"
          label={t('builderTexts.label')}
          description={t('builderTexts.labelHelp')}
          value={corpus?.label ?? ''}
          error={errorAt(`${at}.label`)}
          onChange={(e) => onChange((c) => corpusText(c, 'label', e.target.value))}
        />
        <Textfield
          data-size="sm"
          label={t('builderTexts.description')}
          value={corpus?.description ?? ''}
          error={errorAt(`${at}.description`)}
          onChange={(e) => onChange((c) => corpusText(c, 'description', e.target.value))}
        />

        <Heading level={3} data-size="2xs">
          {t('builderTexts.fieldsTitle')}
        </Heading>
        {collection.fields.length === 0 ? (
          <Paragraph data-size="sm" className="meta">
            {t('builderTexts.noFields')}
          </Paragraph>
        ) : null}
        {errorAt(`${at}.fields`) ? (
          <ValidationMessage data-size="sm">{errorAt(`${at}.fields`)}</ValidationMessage>
        ) : null}
        {collection.fields.map((declared) => {
          const index = fields.findIndex((f) => f.id === declared.field);
          const field = index < 0 ? undefined : fields[index];
          const fieldAt = `${at}.fields[${index}]`;
          const edit = (change: (f: ProfileField) => ProfileField | undefined) =>
            onChange((c) => withField(c, collection.fields, declared.field, change));
          return (
            <FieldTexts
              key={declared.field}
              id={declared.field}
              field={field}
              errorAt={(suffix) => (field ? errorAt(`${fieldAt}.${suffix}`) : undefined)}
              onChange={edit}
            />
          );
        })}

        <Field data-size="sm">
          <Label htmlFor={typeFieldId}>{t('builderTexts.typeField')}</Label>
          <Paragraph data-size="sm" className="meta">
            {t('builderTexts.typeFieldHelp')}
          </Paragraph>
          <Select
            id={typeFieldId}
            value={corpus?.typeField ?? ''}
            onChange={(e) => onChange((c) => corpusText(c, 'typeField', e.target.value))}
          >
            <Select.Option value="">{t('builderTexts.typeFieldNone')}</Select.Option>
            {[
              ...new Set([
                ...collection.fields.map((f) => f.field),
                ...(corpus?.typeField ? [corpus.typeField] : []),
              ]),
            ].map((name) => (
              <Select.Option key={name} value={name}>
                {name}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Fieldset data-size="sm">
          <Fieldset.Legend>{t('builderTexts.plurals')}</Fieldset.Legend>
          {plurals.map(([type, plural], n) => (
            <div className="blocks-texts-row" key={n}>
              <Textfield
                data-size="sm"
                label={t('builderTexts.pluralType', { n: n + 1 })}
                value={type}
                error={taken === n ? t('builderTexts.pluralTaken') : undefined}
                onChange={(e) => {
                  const value = e.target.value;
                  // The plurals are one per type: a type another row has would merge the two.
                  if (plurals.some(([other], i) => i !== n && other === value)) {
                    setTaken(n);
                    return;
                  }
                  setTaken(undefined);
                  onChange((c) =>
                    withPlurals(
                      c,
                      plurals.map((row, i) => (i === n ? [value, row[1]] : row)),
                    ),
                  );
                }}
              />
              <Textfield
                data-size="sm"
                label={t('builderTexts.pluralWord', { n: n + 1 })}
                value={plural}
                error={errorAt(`${at}.typePlurals.${type}`)}
                onChange={(e) =>
                  onChange((c) =>
                    withPlurals(
                      c,
                      plurals.map((row, i) => (i === n ? [row[0], e.target.value] : row)),
                    ),
                  )
                }
              />
              <Button
                variant="tertiary"
                data-size="sm"
                onClick={() =>
                  onChange((c) =>
                    withPlurals(
                      c,
                      plurals.filter((_, i) => i !== n),
                    ),
                  )
                }
              >
                {t('builderTexts.removePlural', { n: n + 1 })}
              </Button>
            </div>
          ))}
          {errorAt(`${at}.typePlurals`) ? (
            <ValidationMessage data-size="sm">{errorAt(`${at}.typePlurals`)}</ValidationMessage>
          ) : null}
          <div>
            <Button
              variant="secondary"
              data-size="sm"
              disabled={plurals.some(([type]) => type === '')}
              onClick={() => onChange((c) => withPlurals(c, [...plurals, ['', '']]))}
            >
              {t('builderTexts.addPlural')}
            </Button>
          </div>
        </Fieldset>

        <Fieldset data-size="sm">
          <Fieldset.Legend>{t('builderTexts.linksTitle')}</Fieldset.Legend>
          <Fieldset.Description>{t('builderTexts.linksHelp', { id: '{id}' })}</Fieldset.Description>
          {linkPatterns.map(({ pattern, key }) => (
            <Textfield
              key={pattern}
              data-size="sm"
              type="url"
              label={t(`builderTexts.${key}`)}
              value={corpus?.documentLinks?.[pattern] ?? ''}
              error={errorAt(`${at}.documentLinks.${pattern}`)}
              onChange={(e) => onChange((c) => corpusLink(c, pattern, e.target.value))}
            />
          ))}
        </Fieldset>
      </Details.Content>
    </Details>
  );
};

const FieldTexts = ({
  id,
  field,
  errorAt,
  onChange,
}: {
  id: string;
  /** The field as the profile has it; none when it is left out of the filter. */
  field: ProfileField | undefined;
  errorAt: (suffix: string) => ReactNode;
  onChange: (change: (field: ProfileField) => ProfileField | undefined) => void;
}) => {
  const t = useT();
  const years = field?.years;
  const order =
    years?.first !== undefined && years.last !== undefined && years.first > years.last
      ? t('builderTexts.yearsOrder')
      : undefined;
  const yearAt = (key: 'first' | 'last', text: string) =>
    onChange((f) => {
      const next = { ...f.years, [key]: yearOf(text) };
      const set = Object.values(next).some((v) => v !== undefined);
      return { ...f, years: set ? next : undefined };
    });
  return (
    <Fieldset data-size="sm">
      <Fieldset.Legend>{t('builderTexts.field', { id })}</Fieldset.Legend>
      <Switch
        position="end"
        label={t('builderTexts.fieldInFilter')}
        checked={field !== undefined}
        onChange={() => onChange((f) => (field ? undefined : f))}
      />
      {field ? (
        <Fragment>
          <Textfield
            data-size="sm"
            label={t('builderTexts.fieldLabel')}
            description={t('builderTexts.fieldLabelHelp', { id })}
            placeholder={id}
            value={field.label === id ? '' : field.label}
            error={errorAt('label')}
            onChange={(e) => onChange((f) => ({ ...f, label: e.target.value || id }))}
          />
          <Textfield
            data-size="sm"
            label={t('builderTexts.fieldHeading')}
            description={t('builderTexts.fieldHeadingHelp')}
            value={field.heading ?? ''}
            error={errorAt('heading')}
            onChange={(e) =>
              onChange((f) => ({
                ...f,
                heading: e.target.value.trim() ? e.target.value : undefined,
              }))
            }
          />
          <Switch
            position="end"
            label={t('builderTexts.fieldYear')}
            description={t('builderTexts.fieldYearHelp')}
            checked={field.kind === 'year'}
            onChange={() =>
              onChange((f) =>
                f.kind === 'year'
                  ? { ...f, kind: undefined, years: undefined }
                  : { ...f, kind: 'year' },
              )
            }
          />
          {field.kind === 'year' ? (
            <div className="blocks-texts-row">
              <Textfield
                data-size="sm"
                type="number"
                inputMode="numeric"
                label={t('builderTexts.firstYear')}
                description={t('builderTexts.firstYearHelp')}
                value={years?.first ?? ''}
                error={order}
                onChange={(e) => yearAt('first', e.target.value)}
              />
              <Textfield
                data-size="sm"
                type="number"
                inputMode="numeric"
                label={t('builderTexts.lastYear')}
                description={t('builderTexts.lastYearHelp')}
                value={years?.last ?? ''}
                onChange={(e) => yearAt('last', e.target.value)}
              />
            </div>
          ) : null}
        </Fragment>
      ) : null}
    </Fieldset>
  );
};
