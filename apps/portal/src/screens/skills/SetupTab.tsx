import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Select,
  Spinner,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState, type ReactNode } from 'react';
import type { SkillDefinition, SkillSpec, SkillToolOption } from '../../api/skills';
import { useFormat } from '@genai/i18n/react';
import { useT } from '../../i18n';
import { fileSize, refName, refVersion, toolName, type ProposalSection } from '../../data/skills';
import { ChangeCard } from './ChangeCard';
import type { AssistantNotice, EditorCard, RejectedEditorCard } from './model';
import { RejectedCard } from './RejectedCard';

const fileIcon = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
  </svg>
);

interface Props {
  definition: SkillDefinition;
  canEdit: boolean;
  tools: SkillToolOption[];
  cards: EditorCard[];
  rejected: RejectedEditorCard[];
  notice: AssistantNotice | null;
  busy: ProposalSection | 'fix' | '';
  sizes: Record<string, number>;
  onName: (name: string) => void;
  onSpec: (fn: (spec: SkillSpec) => SkillSpec) => void;
  onAsk: (section: ProposalSection) => void;
  onUndo: (card: EditorCard) => void;
  onFile: (file: File) => void;
}

const AskButton = ({
  busy,
  mine,
  onClick,
}: {
  busy: boolean;
  mine: boolean;
  onClick: () => void;
}) => {
  const t = useT();
  return (
    <>
      <Button
        variant="secondary"
        data-size="sm"
        aria-disabled={busy || undefined}
        onClick={() => !busy && onClick()}
      >
        {t('skills.askAssistant')}
      </Button>
      {mine ? (
        <span role="status" className="busy-note">
          <Spinner aria-hidden data-size="xs" />
          {t('skills.assistantWriting')}
        </span>
      ) : null}
    </>
  );
};

const Section = ({ labelledBy, children }: { labelledBy: string; children: ReactNode }) => (
  <section aria-labelledby={labelledBy} className="skill-section">
    {children}
  </section>
);

export const SetupTab = ({
  definition,
  canEdit,
  tools,
  cards,
  rejected,
  notice,
  busy,
  sizes,
  onName,
  onSpec,
  onAsk,
  onUndo,
  onFile,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const spec = definition.spec;
  const [catalogOpen, setCatalogOpen] = useState(false);
  const isBusy = busy !== '';
  const cardsFor = (section: ProposalSection) => (
    <>
      {cards
        .filter((c) => c.section === section)
        .map((c) => (
          <ChangeCard
            key={c.id}
            title={c.title}
            detail={c.detail}
            before={c.before}
            after={c.after}
            afterLabel={c.afterLabel}
            undone={c.undone}
            canUndo={canEdit}
            onUndo={() => onUndo(c)}
          />
        ))}
      {rejected
        .filter((c) => c.section === section)
        .map((c) => (
          <RejectedCard key={c.id} card={c} />
        ))}
      {notice?.section === section ? (
        <Alert data-color={notice.color} data-size="sm" role="alert">
          {notice.text}
        </Alert>
      ) : null}
    </>
  );
  const catalog = tools.filter((tool) => !spec.tools.some((ref) => refName(ref) === tool.id));

  return (
    <div className="stack-md">
      <Textfield
        className="skill-name-field"
        label={t('skills.fieldName')}
        value={definition.metadata.name ?? ''}
        readOnly={!canEdit}
        onChange={(e) => onName(e.target.value)}
      />

      <Section labelledBy="skill-description-label">
        <Textfield
          id="skill-description"
          label={<span id="skill-description-label">{t('skills.fieldDescription')}</span>}
          description={t('skills.fieldDescriptionHelp')}
          multiline
          rows={3}
          value={spec.description}
          readOnly={!canEdit}
          onChange={(e) => {
            const value = e.target.value;
            onSpec((s) => ({ ...s, description: value }));
          }}
        />
        {cardsFor('description')}
        {canEdit ? (
          <div className="row-wrap">
            <AskButton
              busy={isBusy}
              mine={busy === 'description'}
              onClick={() => onAsk('description')}
            />
          </div>
        ) : null}
      </Section>

      <Section labelledBy="skill-instructions-label">
        <Textfield
          id="skill-instructions"
          className="skill-instructions"
          label={<span id="skill-instructions-label">{t('skills.fieldInstructions')}</span>}
          description={t('skills.fieldInstructionsHelp')}
          multiline
          rows={14}
          spellCheck={false}
          value={spec.instructions}
          readOnly={!canEdit}
          onChange={(e) => {
            const value = e.target.value;
            onSpec((s) => ({ ...s, instructions: value }));
          }}
        />
        {cardsFor('instructions')}
        {canEdit ? (
          <div className="row-wrap">
            <AskButton
              busy={isBusy}
              mine={busy === 'instructions' || busy === 'fix'}
              onClick={() => onAsk('instructions')}
            />
          </div>
        ) : null}
      </Section>

      <Section labelledBy="skill-examples-h">
        <div className="skill-section-head">
          <Heading level={2} data-size="2xs" id="skill-examples-h">
            {t('skills.examplesTitle')}
          </Heading>
          <span className="small subtle">{t('skills.examplesHelp')}</span>
        </div>
        {spec.examples.length === 0 ? (
          <p className="skill-none">{t('skills.examplesNone')}</p>
        ) : null}
        {spec.examples.map((x, i) => (
          <fieldset key={i} className="skill-example">
            <legend>{t('skills.exampleLegend', { n: i + 1 })}</legend>
            <Textfield
              label={t('skills.exampleIn')}
              data-size="sm"
              multiline
              rows={2}
              value={x.input}
              readOnly={!canEdit}
              onChange={(e) => {
                const value = e.target.value;
                onSpec((s) => ({
                  ...s,
                  examples: s.examples.map((y, j) => (j === i ? { ...y, input: value } : y)),
                }));
              }}
            />
            <Textfield
              label={t('skills.exampleOut')}
              data-size="sm"
              multiline
              rows={2}
              value={x.expectedOutput}
              readOnly={!canEdit}
              onChange={(e) => {
                const value = e.target.value;
                onSpec((s) => ({
                  ...s,
                  examples: s.examples.map((y, j) =>
                    j === i ? { ...y, expectedOutput: value } : y,
                  ),
                }));
              }}
            />
            {canEdit ? (
              <Button
                variant="tertiary"
                data-size="sm"
                className="skill-remove"
                aria-label={t('skills.exampleRemove', { n: i + 1 })}
                onClick={() =>
                  onSpec((s) => ({ ...s, examples: s.examples.filter((_, j) => j !== i) }))
                }
              >
                {t('skills.remove')}
              </Button>
            ) : null}
          </fieldset>
        ))}
        {cardsFor('examples')}
        {canEdit ? (
          <div className="row-wrap">
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() =>
                onSpec((s) => ({
                  ...s,
                  examples: [...s.examples, { input: '', expectedOutput: '' }],
                }))
              }
            >
              {t('skills.exampleAdd')}
            </Button>
            <AskButton busy={isBusy} mine={busy === 'examples'} onClick={() => onAsk('examples')} />
          </div>
        ) : null}
      </Section>

      <Section labelledBy="skill-tools-h">
        <div className="skill-section-head">
          <Heading level={2} data-size="2xs" id="skill-tools-h">
            {t('skills.toolsTitle')}
          </Heading>
          <span className="small subtle">{t('skills.toolsHelp')}</span>
        </div>
        {spec.tools.length === 0 ? <p className="skill-none">{t('skills.toolsNone')}</p> : null}
        <ul className="plain-list skill-rows">
          {spec.tools.map((ref) => {
            const id = refName(ref);
            const name = toolName(tools, id);
            const current = refVersion(ref);
            const versions = tools.find((tool) => tool.id === id)?.versions ?? [];
            const options = versions.includes(current) ? versions : [current, ...versions];
            const selectId = `skill-tool-${id}`;
            return (
              <li key={ref} className="skill-tool-row">
                <span className="skill-tool-name">{name}</span>
                <Field className="skill-tool-version">
                  <Label htmlFor={selectId} data-size="sm">
                    {t('skills.toolVersion')}
                  </Label>
                  <Select
                    id={selectId}
                    data-size="sm"
                    value={current}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const value = e.target.value;
                      onSpec((s) => ({
                        ...s,
                        tools: s.tools.map((r) => (refName(r) === id ? `${id}@${value}` : r)),
                      }));
                    }}
                  >
                    {options.map((v) => (
                      <Select.Option key={v} value={v}>
                        {v}
                      </Select.Option>
                    ))}
                  </Select>
                </Field>
                {canEdit ? (
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    aria-label={t('skills.toolRemove', { name })}
                    onClick={() =>
                      onSpec((s) => ({ ...s, tools: s.tools.filter((r) => refName(r) !== id) }))
                    }
                  >
                    {t('skills.remove')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canEdit ? (
          <Button
            variant="secondary"
            data-size="sm"
            className="self-start"
            aria-expanded={catalogOpen}
            onClick={() => setCatalogOpen((o) => !o)}
          >
            {t('skills.catalogAdd')}
          </Button>
        ) : null}
        {canEdit && catalogOpen ? (
          <ul className="plain-list skill-catalog">
            {catalog.map((tool) => (
              <li key={tool.id}>
                <span>
                  {tool.name}{' '}
                  <span className="subtle">
                    · {t('skills.catalogVersion', { version: tool.versions[0] ?? '' })}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  data-size="sm"
                  aria-label={t('skills.catalogAddTool', { name: tool.name })}
                  onClick={() =>
                    onSpec((s) => ({
                      ...s,
                      tools: [...s.tools, `${tool.id}@${tool.versions[0] ?? '1'}`],
                    }))
                  }
                >
                  {t('skills.add')}
                </Button>
              </li>
            ))}
            {catalog.length === 0 ? <li>{t('skills.catalogEmpty')}</li> : null}
          </ul>
        ) : null}
      </Section>

      <Section labelledBy="skill-files-h">
        <div className="skill-section-head">
          <Heading level={2} data-size="2xs" id="skill-files-h">
            {t('skills.filesTitle')}
          </Heading>
          <span className="small subtle">{t('skills.filesHelp')}</span>
        </div>
        {spec.attachments.length === 0 ? (
          <p className="skill-none">{t('skills.filesNone')}</p>
        ) : null}
        <ul className="plain-list skill-files">
          {spec.attachments.map((file) => (
            <li key={file.blob}>
              {fileIcon}
              <span className="skill-file-name">
                {file.name}
                {sizes[file.blob] !== undefined ? (
                  <span className="subtle"> · {fileSize(f, sizes[file.blob] ?? 0)}</span>
                ) : null}
              </span>
              {canEdit ? (
                <Button
                  variant="tertiary"
                  data-size="sm"
                  aria-label={t('skills.fileRemove', { name: file.name })}
                  onClick={() =>
                    onSpec((s) => ({
                      ...s,
                      attachments: s.attachments.filter((a) => a.blob !== file.blob),
                    }))
                  }
                >
                  {t('skills.remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {canEdit ? (
          <label
            className="ds-button file-button self-start"
            data-variant="secondary"
            data-size="sm"
          >
            <input
              type="file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onFile(file);
              }}
            />
            {t('skills.fileAdd')}
          </label>
        ) : null}
      </Section>
    </div>
  );
};
