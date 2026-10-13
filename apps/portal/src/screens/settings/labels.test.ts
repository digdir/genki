import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import { formatValue, mergeRows, settingErrorText } from './model';
import { settingLabels } from './labels';
import { norm, settingDesc, settingLabel } from './text';

const t = translator('nb');
const f = createFormat('nb');

describe('setting labels', () => {
  it('names the default model for new services in Norwegian', () => {
    const { rows } = mergeRows(
      [
        {
          key: 'services.defaultModel',
          description: 'Default model for new services.',
          category: 'Model',
          axis: 'service',
          sensitivity: 'normal',
          default: 'foundry-openai/gpt-4.1-mini',
          settableAt: ['platform'],
        },
      ],
      undefined,
      '999888777',
      true,
    );
    const row = rows.find((r) => r.apiKey === 'services.defaultModel');
    expect(row?.label).toBe('Standardmodell for nye tjenester');
    expect(row?.cat).toBe('Modell');
  });

  it('names the written standard and its choices in Norwegian', () => {
    const { rows } = mergeRows(
      [
        {
          key: 'answers.writtenStandard',
          description: 'Written standard for answers.',
          category: 'answers',
          axis: 'service',
          sensitivity: 'normal',
          default: 'user',
          settableAt: ['platform', 'tenant', 'service', 'call'],
          schema: { type: 'string', enum: ['user', 'bokmal', 'nynorsk'] },
        },
      ],
      undefined,
      '999888777',
      true,
    );
    const row = rows.find((r) => r.apiKey === 'answers.writtenStandard');
    expect(row?.label).toBe('Målform i svar');
    expect(row?.opts).toEqual([
      ['user', 'Samme som spørsmålet'],
      ['bokmal', 'Bokmål'],
      ['nynorsk', 'Nynorsk'],
    ]);
  });

  it('lists only categories that have settings and shows an empty model choice as automatic', () => {
    const { rows, categories } = mergeRows(
      [
        {
          key: 'assistant.model',
          description: 'Model for the assistant.',
          category: 'assistant',
          axis: 'service',
          sensitivity: 'normal',
          default: '',
          settableAt: ['platform', 'tenant'],
        },
      ],
      undefined,
      '999888777',
      true,
    );
    expect(categories).toEqual(['Assistent']);
    const row = rows.find((r) => r.apiKey === 'assistant.model');
    expect(row && formatValue(row, '', t, f)).toBe('Velges automatisk');
  });

  it('turns the API reasons for a refused value into Norwegian', () => {
    expect(settingErrorText('Too big: expected number to be <=365', t)).toBe(
      'Verdien kan ikke være over 365.',
    );
    expect(
      settingErrorText(
        'Too small: expected number to be >=1; cannot be set at the service layer',
        t,
      ),
    ).toBe('Verdien må være minst 1. Innstillingen kan ikke settes her.');
    expect(settingErrorText('Invalid option: expected one of "user"|"bokmal"', t)).toBe(
      'Velg en av de tillatte verdiene.',
    );
    expect(settingErrorText('unknown setting x.y', t)).toBe('Innstillingen finnes ikke.');
  });
});

describe('setting text in English', () => {
  const en = translator('en');
  const fen = createFormat('en');
  const row = mergeRows(
    [
      {
        key: 'answers.writtenStandard',
        description: 'Written standard for answers.',
        category: 'answers',
        axis: 'service',
        sensitivity: 'normal',
        default: 'user',
        settableAt: ['platform', 'tenant', 'service', 'call'],
        schema: { type: 'string', enum: ['user', 'bokmal', 'nynorsk'] },
      },
    ],
    undefined,
    '999888777',
    true,
  ).rows.find((r) => r.apiKey === 'answers.writtenStandard');

  it('names the setting and its choices', () => {
    expect(row && settingLabel(en, row)).toBe('Written standard in answers');
    expect(row && formatValue(row, 'user', en, fen)).toBe('Same as the question');
  });

  it('turns the API reasons for a refused value into English', () => {
    expect(settingErrorText('Too big: expected number to be <=365', en)).toBe(
      'The value cannot be over 365.',
    );
    expect(settingErrorText('unknown setting x.y', en)).toBe('The setting does not exist.');
  });
});

describe('setting descriptions', () => {
  it('describes every platform setting in bokmål and English instead of the English API text', () => {
    const keys = Object.keys(settingLabels);
    expect(keys.length).toBeGreaterThanOrEqual(41);
    for (const locale of ['nb', 'en'] as const) {
      const missing = keys.filter((k) => !translator(locale).has(`settingDefs.${norm(k)}_desc`));
      expect(missing, locale).toEqual([]);
    }
    const row = mergeRows(
      [
        {
          key: 'planner.prompt',
          description: 'Replacement planner prompt; empty uses the built-in prompt.',
          category: 'planner',
          axis: 'service',
          sensitivity: 'normal',
          default: null,
          settableAt: ['platform'],
        },
      ],
      undefined,
      '999888777',
      true,
    ).rows.find((r) => r.apiKey === 'planner.prompt');
    expect(row && settingDesc(t, row)).toBe(
      'Ledetekst som erstatter den innebygde for planleggeren. Tomt bruker den innebygde.',
    );
  });
});
