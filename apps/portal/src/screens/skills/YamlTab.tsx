import { Button, Field, Label, Textarea, ValidationMessage } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { SkillDefinition } from '../../api/skills';
import { blankSpec } from '../../data/skills';
import { useT, type T } from '../../i18n';
import { parseYaml, toYaml, YamlError } from '../../yaml';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

class ShapeError extends Error {}

const shapeProblem = (t: T, problem: string) =>
  new ShapeError(t('skills.yamlLine', { line: 1, problem }));

export const skillFromYaml = (text: string, current: SkillDefinition, t: T): SkillDefinition => {
  const parsed = parseYaml(text);
  if (!isObject(parsed)) throw shapeProblem(t, t('skills.yamlNotObject'));
  if (parsed.kind !== 'Skill') throw shapeProblem(t, t('skills.yamlKind'));
  if (!isObject(parsed.spec)) throw shapeProblem(t, t('skills.yamlNoSpec'));
  const metadata = isObject(parsed.metadata) ? parsed.metadata : {};
  const spec = parsed.spec;
  const testset = isObject(spec.testset) ? spec.testset : {};
  return {
    ...current,
    metadata: {
      ...current.metadata,
      ...(typeof metadata.name === 'string' ? { name: metadata.name } : {}),
    },
    spec: {
      ...blankSpec(),
      ...(spec as Partial<SkillDefinition['spec']>),
      testset: {
        ...(typeof testset.passThreshold === 'number'
          ? { passThreshold: testset.passThreshold }
          : {}),
        cases: Array.isArray(testset.cases)
          ? (testset.cases as SkillDefinition['spec']['testset']['cases'])
          : [],
      },
    },
  };
};

export const YamlTab = ({
  definition,
  canEdit,
  onApply,
}: {
  definition: SkillDefinition;
  canEdit: boolean;
  onApply: (next: SkillDefinition) => void;
}) => {
  const t = useT();
  const generated = toYaml(definition);
  const [edit, setEdit] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const text = edit ?? generated;
  const clean = edit === null || edit === generated;

  const apply = () => {
    if (clean) return;
    try {
      onApply(skillFromYaml(text, definition, t));
      setEdit(null);
      setNote(t('skills.yamlApplied'));
    } catch (e) {
      setError(
        e instanceof YamlError || e instanceof ShapeError ? e.message : t('skills.yamlUnreadable'),
      );
    }
  };

  return (
    <div className="stack-sm">
      <Field>
        <Label htmlFor="skill-yaml">{t('skills.yamlLabel')}</Label>
        <Field.Description>{t('skills.yamlHelp')}</Field.Description>
        <Textarea
          id="skill-yaml"
          className="skill-yaml"
          rows={28}
          spellCheck={false}
          value={text}
          readOnly={!canEdit}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setEdit(e.target.value);
            setNote('');
            setError('');
          }}
        />
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </Field>
      {canEdit ? (
        <div className="actions">
          <Button
            variant="primary"
            data-size="sm"
            aria-disabled={clean || undefined}
            onClick={apply}
          >
            {t('skills.yamlApply')}
          </Button>
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={clean || undefined}
            onClick={() => {
              if (clean) return;
              setEdit(null);
              setError('');
              setNote(t('skills.yamlDiscarded'));
            }}
          >
            {t('skills.discard')}
          </Button>
          <span aria-live="polite" className="meta">
            {note}
          </span>
        </div>
      ) : null}
    </div>
  );
};
