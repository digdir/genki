import {
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
import { useT, type PlainKey } from '../../i18n';
import { fileSize, refName, refVersion, toolName, type ProposalSection } from '../../data/skills';
import type { AskState } from './model';
import { RejectedCard } from './RejectedCard';

interface Props {
  definition: SkillDefinition;
  canEdit: boolean;
  tools: SkillToolOption[];
  asks: Partial<Record<ProposalSection, AskState>>;
  busy: ProposalSection | 'fix' | '';
  sizes: Record<string, number>;
  onName: (name: string) => void;
  onSpec: (fn: (spec: SkillSpec) => SkillSpec) => void;
  onAsk: (section: ProposalSection) => void;
  onUse: (section: ProposalSection) => void;
  onFile: (file: File) => void;
}

const askLabels: Record<ProposalSection, [PlainKey, PlainKey]> = {
  description: ['skills.askWhen', 'skills.useInDescription'],
  instructions: ['skills.askInstructionsGood', 'skills.useInInstructions'],
  examples: ['skills.askExamplesMissing', 'skills.useExamples'],
};

const Ask = ({
  section,
  state,
  busy,
  onAsk,
  onUse,
}: {
  section: ProposalSection;
  state: AskState | undefined;
  busy: ProposalSection | 'fix' | '';
  onAsk: (section: ProposalSection) => void;
  onUse: (section: ProposalSection) => void;
}) => {
  const t = useT();
  const [askKey, useKey] = askLabels[section];
  const open = !!state?.open;
  const panelId = `skill-ask-${section}`;
  return (
    <>
      <Button
        variant="secondary"
        data-size="sm"
        className="self-start"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-disabled={(!open && busy !== '') || undefined}
        onClick={() => onAsk(section)}
      >
        {t(askKey)}
      </Button>
      {open ? (
        <div id={panelId} className="skill-suggestion">
          <span className="skill-suggestion-from">{t('skills.suggestionFrom')}</span>
          {busy === section ? (
            <span role="status" className="busy-note">
              <Spinner aria-hidden data-size="xs" />
              {t('skills.assistantWriting')}
            </span>
          ) : null}
          {state.applied.map(({ card }) => (
            <span key={card.id} className="skill-suggestion-text">
              {card.after}
            </span>
          ))}
          {state.rejected.map((c) => (
            <RejectedCard key={c.id} card={c} />
          ))}
          {state.notice ? (
            <span role="alert" className="skill-suggestion-text">
              {state.notice.text}
            </span>
          ) : null}
          <div className="actions">
            {state.applied.length ? (
              <Button variant="primary" data-size="sm" onClick={() => onUse(section)}>
                {t(useKey)}
              </Button>
            ) : null}
            <Button variant="secondary" data-size="sm" onClick={() => onAsk(section)}>
              {t('skills.close')}
            </Button>
          </div>
        </div>
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
  asks,
  busy,
  sizes,
  onName,
  onSpec,
  onAsk,
  onUse,
  onFile,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const spec = definition.spec;
  const [catalogOpen, setCatalogOpen] = useState(false);
  const ask = (section: ProposalSection) =>
    canEdit ? (
      <Ask section={section} state={asks[section]} busy={busy} onAsk={onAsk} onUse={onUse} />
    ) : null;
  const catalog = tools.filter((tool) => !spec.tools.some((ref) => refName(ref) === tool.id));

  return (
    <div className="skill-setup">
      <Section labelledBy="skill-what-h">
        <Heading level={2} data-size="xs" id="skill-what-h">
          {t('skills.setupWhatTitle')}
        </Heading>
        <Textfield
          label={t('skills.fieldName')}
          value={definition.metadata.name ?? ''}
          readOnly={!canEdit}
          onChange={(e) => onName(e.target.value)}
        />
        <Textfield
          label={t('skills.fieldDescriptionShort')}
          description={t('skills.fieldDescriptionShortHelp')}
          multiline
          rows={2}
          value={spec.description}
          readOnly={!canEdit}
          onChange={(e) => {
            const value = e.target.value;
            onSpec((s) => ({ ...s, description: value }));
          }}
        />
        {ask('description')}
      </Section>

      <Section labelledBy="skill-instructions-h">
        <Heading level={2} data-size="xs" id="skill-instructions-h">
          {t('skills.fieldInstructions')}
        </Heading>
        <Textfield
          className="skill-instructions"
          label={t('skills.fieldInstructionsModel')}
          description={t('skills.fieldInstructionsModelHelp')}
          multiline
          rows={7}
          value={spec.instructions}
          readOnly={!canEdit}
          onChange={(e) => {
            const value = e.target.value;
            onSpec((s) => ({ ...s, instructions: value }));
          }}
        />
        <span className="small subtle">
          {t('skills.charCount', { count: spec.instructions.length })}
        </span>
        {ask('instructions')}
      </Section>

      <Section labelledBy="skill-examples-h">
        <Heading level={2} data-size="xs" id="skill-examples-h">
          {t('skills.examplesTitle')}
        </Heading>
        <p className="skill-help">{t('skills.examplesHelp')}</p>
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
        {canEdit ? (
          <Button
            variant="secondary"
            data-size="sm"
            className="self-start"
            onClick={() =>
              onSpec((s) => ({
                ...s,
                examples: [...s.examples, { input: '', expectedOutput: '' }],
              }))
            }
          >
            {t('skills.exampleAdd')}
          </Button>
        ) : null}
        {ask('examples')}
      </Section>

      <Section labelledBy="skill-tools-h">
        <Heading level={2} data-size="xs" id="skill-tools-h">
          {t('skills.toolsTitle')}
        </Heading>
        <p className="skill-help">{t('skills.toolsHelp')}</p>
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
        <Heading level={2} data-size="xs" id="skill-files-h">
          {t('skills.filesSectionTitle')}
        </Heading>
        <p className="skill-help">{t('skills.filesSectionHelp')}</p>
        {spec.attachments.length === 0 ? (
          <p className="skill-none">{t('skills.filesNone')}</p>
        ) : null}
        <ul className="plain-list skill-files">
          {spec.attachments.map((file) => (
            <li key={file.blob}>
              <span>
                <span className="skill-file-name">{file.name}</span>
                {sizes[file.blob] !== undefined ? (
                  <span className="small subtle"> {fileSize(f, sizes[file.blob] ?? 0)}</span>
                ) : null}
              </span>
              {canEdit ? (
                <Button
                  variant="tertiary"
                  data-size="sm"
                  className="skill-link-button"
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
              multiple
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                for (const file of files) onFile(file);
              }}
            />
            {t('skills.filesAdd')}
          </label>
        ) : null}
      </Section>
    </div>
  );
};
