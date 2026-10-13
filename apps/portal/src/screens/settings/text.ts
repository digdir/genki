import type { SettingRow } from '../../data/settings';
import type { T } from '../../i18n';

export const norm = (text: string) =>
  text
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'Ae')
    .replace(/[øØ]/g, 'o')
    .replace(/[åÅ]/g, 'a')
    .replace(/[^A-Za-z0-9]+/g, '_');

const defined = (t: T, key: string, fallback: string) => {
  const full = `settingDefs.${key}`;
  return t.has(full) ? t.template(full) : fallback;
};

export const settingLabel = (t: T, s: SettingRow) => defined(t, `${norm(s.id)}_label`, s.label);
export const settingDesc = (t: T, s: SettingRow) => defined(t, `${norm(s.id)}_desc`, s.desc);
export const settingRule = (t: T, s: SettingRow) =>
  s.rule === undefined ? undefined : defined(t, `${norm(s.id)}_rule`, s.rule);
export const settingMinRisk = (t: T, s: SettingRow) =>
  s.minRisk === undefined ? undefined : defined(t, `${norm(s.id)}_minRisk`, s.minRisk);
export const categoryText = (t: T, category: string) =>
  defined(t, `cat_${norm(category)}`, category);
export const unitText = (t: T, unit: string) => defined(t, `unit_${norm(unit)}`, unit);
export const piiText = (t: T, category: string) => defined(t, `pii_${norm(category)}`, category);
