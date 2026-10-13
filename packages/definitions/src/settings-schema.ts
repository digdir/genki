import { jsonSchemaOf } from './json-schema.js';
import type { SettingDefinition } from './settings.js';

const promptKeys = /(prompt|instructions|generationPrompt)$/i;
const modelKeys = /\.(model|defaultModel|testModel|judgeModel)$/;

const widgetOf = (setting: SettingDefinition) => {
  if (setting.sensitivity === 'secret') return { 'x-widget': 'secret' };
  if (modelKeys.test(setting.key))
    return {
      'x-widget': 'model',
      'x-options': { route: '/tenants/{tenant}/catalog?kind=model', value: 'id', label: 'id' },
    };
  if (promptKeys.test(setting.key)) return { 'x-widget': 'prompt' };
  return {};
};

export const settingsSchema = (settings: SettingDefinition[]) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    settings.map((setting) => [
      setting.key,
      {
        ...jsonSchemaOf(setting.schema, { bare: true }),
        default: setting.default,
        description: setting.description,
        'x-settableAt': setting.settableAt,
        ...(setting.settableAt.includes('tenant')
          ? { 'x-right': 'manage-services' }
          : { 'x-operator': true }),
        ...(setting.sensitivity === 'secret' ? { 'x-sensitive': true } : {}),
        ...widgetOf(setting),
      },
    ]),
  ),
});
