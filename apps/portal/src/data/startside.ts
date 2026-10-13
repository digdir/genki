import type { PlainKey } from '../i18n';

export const anchors = [
  ['fellestjenester', 'start.navShared'],
  ['eksempler', 'start.navExamples'],
  ['pris', 'start.navPrice'],
  ['data', 'start.navData'],
  ['dokumentasjon', 'start.navDocs'],
] as const satisfies readonly (readonly [string, PlainKey])[];

export const narrowAnchors = [
  ['fellestjenester', 'start.navShared'],
  ['eksempler', 'start.navExamples'],
  ['pris', 'start.navPrice'],
  ['data', 'start.navData'],
  ['kom-i-gang', 'start.navGetStarted'],
  ['dokumentasjon', 'start.navDocs'],
] as const satisfies readonly (readonly [string, PlainKey])[];

export const whatItDoes = [
  ['start.what1Title', 'start.what1Body'],
  ['start.what2Title', 'start.what2Body'],
  ['start.what3Title', 'start.what3Body'],
] as const satisfies readonly (readonly [PlainKey, PlainKey])[];

export const sharedCapabilities = [
  ['start.shared1Title', 'start.shared1Body', 'start.shared1Example'],
  ['start.shared2Title', 'start.shared2Body', 'start.shared2Example'],
  ['start.shared3Title', 'start.shared3Body', 'start.shared3Example'],
  ['start.shared4Title', 'start.shared4Body', 'start.shared4Example'],
  ['start.shared5Title', 'start.shared5Body', 'start.shared5Example'],
  ['start.shared6Title', 'start.shared6Body', 'start.shared6Example'],
] as const satisfies readonly (readonly [PlainKey, PlainKey, PlainKey])[];

export const examples = [
  {
    job: 'start.ex1Job',
    trigger: 'start.ex1Trigger',
    title: 'start.ex1Title',
    body: 'start.ex1Body',
    facts: [
      ['start.exIn', 'start.ex1In'],
      ['start.exOut', 'start.ex1Out'],
      ['start.exRunsIn', 'start.exRunsInValue'],
    ],
  },
  {
    job: 'start.ex2Job',
    trigger: 'start.ex2Trigger',
    title: 'start.ex2Title',
    body: 'start.ex2Body',
    facts: [
      ['start.exIn', 'start.ex2In'],
      ['start.exOut', 'start.ex2Out'],
      ['start.exRunsIn', 'start.exRunsInValue'],
    ],
  },
  {
    job: 'start.ex3Job',
    trigger: 'start.ex3Trigger',
    title: 'start.ex3Title',
    body: 'start.ex3Body',
    facts: [
      ['start.exIn', 'start.ex3In'],
      ['start.exOut', 'start.ex3Out'],
      ['start.exRunsIn', 'start.exRunsInValue'],
      ['start.exRisk', 'start.ex3Risk'],
    ],
  },
] as const satisfies readonly {
  job: PlainKey;
  trigger: PlainKey;
  title: PlainKey;
  body: PlainKey;
  facts: readonly (readonly [PlainKey, PlainKey])[];
}[];

export const terms = [
  'start.term1',
  'start.term2',
  'start.term3',
  'start.term4',
] as const satisfies readonly PlainKey[];

export const gettingStarted = [
  ['start.step1Title', 'start.step1Body'],
  ['start.step2Title', 'start.step2Body'],
  ['start.step3Title', 'start.step3Body'],
  ['start.step4Title', 'start.step4Body'],
] as const satisfies readonly (readonly [PlainKey, PlainKey])[];

export const documentation = [
  ['start.doc1Title', 'start.doc1Body'],
  ['start.doc2Title', 'start.doc2Body'],
  ['start.doc3Title', 'start.doc3Body'],
  ['start.doc4Title', 'start.doc4Body'],
] as const satisfies readonly (readonly [PlainKey, PlainKey])[];
