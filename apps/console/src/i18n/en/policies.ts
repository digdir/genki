import type { Translation } from '@genai/i18n';
import type { policies as source } from '../nb/policies';

export const policies = {
  title: 'Quality requirements and safeguards',
  introTenant:
    "The organisation's own requirements and rules, alongside those the platform applies to everyone. Required rules are only set in the platform view.",
  introPlatform:
    'Requirements and rules that apply across organisations. Organisations cannot turn off a required rule.',
  tabGates: 'Quality requirements',
  tabGuardrails: 'Safeguard rules',
  chooseTenant: 'Choose an organisation',
  atLeast: 'at least {threshold}',
  noRegression: 'no regression',
  kindRegex: 'Pattern',
  kindDenylist: 'Word list',
  kindLlmJudge: 'AI judgement',
  kindMcpCheck: 'External check (MCP)',
  defaultsTitle: 'Platform defaults',
  defaultsIntro:
    'The settings all services inherit. Organisations can override some of them in their services.',
  defaultsReplaced: 'This page has been replaced',
  defaultsText:
    'The platform defaults are now edited in Settings, in the same grid the organisations see. Defaults per risk level are shown there as one setting with a value per level and a floor.',
  defaultsOpen: 'Open Settings',
} satisfies Translation<typeof source>;
