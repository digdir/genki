import { Field, Label, Select } from '@digdir/designsystemet-react';
import { useT, type PlainKey } from '../../i18n';
import type { ProjectsApi, ProjectSource } from '../../projects-api';
import type { ServiceOption } from '../../types';
import { plausibleYears } from '../../years';

export interface ProjectsProps {
  api: ProjectsApi;
  tenant: string;
  path: string;
  services: ServiceOption[];
  userName: string;
  onFlash: (text: string) => void;
}

export const go = (path: string) => {
  window.location.hash = path;
};

export const serviceIdOf = (modelId: string) =>
  modelId.slice(modelId.lastIndexOf('/') + 1).replace(/__[^_]+$/, '');

export const serviceTitle = (services: ServiceOption[], id: string) =>
  services.find((s) => serviceIdOf(s.id) === id)?.name ?? id;

export const fieldLabels: Record<string, PlainKey> = {
  type: 'projects.fieldType',
  concerned_years: 'projects.fieldYears',
  orgs_short: 'projects.fieldOrg',
};

export const saneYears = <V extends { value: string }>(
  values: V[],
  thisYear = new Date().getFullYear(),
) => plausibleYears(values, new Date(thisYear, 6, 1));

const optionValues = <V extends { value: string }>(field: string, values: V[]) =>
  field === 'concerned_years' ? saneYears(values) : values;

export const SelectionFields = ({
  sources,
  dataset,
  filters,
  onChange,
}: {
  sources: ProjectSource[];
  dataset: string;
  filters: Record<string, string[]>;
  onChange: (dataset: string, filters: Record<string, string[]>) => void;
}) => {
  const t = useT();
  const source = sources.find((s) => s.id === dataset);
  return (
    <div className="field-grid">
      <Field data-size="sm">
        <Label htmlFor="utvalg-datasett">{t('projects.dataset')}</Label>
        <Select id="utvalg-datasett" value={dataset} onChange={(e) => onChange(e.target.value, {})}>
          {sources.map((s) => (
            <Select.Option key={s.id} value={s.id}>
              {s.name}
            </Select.Option>
          ))}
        </Select>
      </Field>
      {source?.filters.map((f) => (
        <Field data-size="sm" key={f.field}>
          <Label htmlFor={`utvalg-${f.field}`}>
            {fieldLabels[f.field] ? t(fieldLabels[f.field] as PlainKey) : f.field}
          </Label>
          <Select
            id={`utvalg-${f.field}`}
            value={filters[f.field]?.[0] ?? ''}
            onChange={(e) => {
              const next = Object.fromEntries(
                Object.entries(filters).filter(([k]) => k !== f.field),
              );
              onChange(dataset, e.target.value ? { ...next, [f.field]: [e.target.value] } : next);
            }}
          >
            <Select.Option value="">{t('projects.all')}</Select.Option>
            {optionValues(f.field, f.values).map((v) => (
              <Select.Option key={v.value} value={v.value}>
                {v.value}
              </Select.Option>
            ))}
          </Select>
        </Field>
      ))}
    </div>
  );
};
