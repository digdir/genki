import type {
  SkillCase,
  SkillCaseType,
  SkillDefinition,
  SkillExample,
  SkillGate,
  SkillPublisher,
  SkillShare,
  SkillShareResponse,
  SkillSpec,
  SkillTestRunResponse,
  SkillToolOption,
  SkillUsageResponse,
  SkillVersionResponse,
} from '../api/skills';
import type { Format, PlainKey, T } from '../i18n';
import { organisationProfiles } from './organisations';

export const ownTenant = '999888777';
export const digdirTenant = '991825827';

export const exampleSkillTools: SkillToolOption[] = [
  { id: 'lovdata', name: 'Lovdata', versions: ['1.4', '1.3'] },
  { id: 'arkiv', name: 'Saksarkivet', versions: ['1.0'] },
  { id: 'brreg', name: 'Oppslag i Enhetsregisteret', versions: ['0.1'] },
  { id: 'digdir.klarsprak', name: 'Klarspråk (fellestjeneste)', versions: ['2.3', '2.2'] },
  { id: 'digdir.anonymisering', name: 'Anonymisering (fellestjeneste)', versions: ['1.0'] },
];

export interface SkillRecord {
  id: string;
  owner: string;
  draft: SkillDefinition;
  revision: number;
  published?: SkillDefinition;
  versions: SkillVersionResponse[];
  usedBy: SkillUsageResponse['usedBy'];
  share: SkillShare;
  shareRequest?: SkillShareResponse;
  runs: SkillTestRunResponse[];
  attachmentSizes: Record<string, number>;
  failures: Record<string, { reason: string; unless: string }>;
}

export const caseTypeLabels: Record<SkillCaseType, PlainKey> = {
  criteria: 'skills.caseCriteria',
  fields: 'skills.caseFields',
  must_reject: 'skills.caseMustReject',
};

export const caseTypeOptions: [SkillCaseType, PlainKey][] = [
  ['criteria', 'skills.caseCriteriaOption'],
  ['fields', 'skills.caseFieldsOption'],
  ['must_reject', 'skills.caseMustReject'],
];

export const refName = (ref: string) => ref.slice(0, ref.lastIndexOf('@'));
export const refVersion = (ref: string) => ref.slice(ref.lastIndexOf('@') + 1);

export const blankSpec = (): SkillSpec => ({
  description: '',
  instructions: '',
  examples: [],
  tools: [],
  attachments: [],
  testset: { cases: [] },
});

const definition = (
  tenant: string,
  id: string,
  name: string,
  spec: Partial<SkillSpec>,
  version?: number,
): SkillDefinition => ({
  apiVersion: 'genai/v1',
  kind: 'Skill',
  metadata: { tenant, id, name, ...(version === undefined ? {} : { version }) },
  spec: { ...blankSpec(), ...spec },
});

const ex = (pairs: [string, string][]): SkillExample[] =>
  pairs.map(([input, expectedOutput]) => ({ input, expectedOutput }));

const c = (input: string, expected: string, type: SkillCaseType = 'criteria'): SkillCase => ({
  input,
  expected,
  type,
});

const version = (
  n: number,
  publishedAt: string,
  by: string,
  tested?: [number, number],
): SkillVersionResponse => ({
  version: n,
  publishedAt,
  by,
  reason: 'Publisert',
  score: tested ? tested[0] / tested[1] : null,
  ...(tested ? { passed: tested[0], total: tested[1] } : {}),
});

const use = (tenant: string, service: string, name: string, n: number, latest: number) => ({
  tenant,
  service,
  name,
  version: n,
  updateAvailable: n < latest,
});

const vedtakInstructions =
  '# Skrive vedtaksbrev\n\nSkriv utkast til vedtak etter malen i vedlegget «Malbrev vedtak.docx».\n\n## Oppbygging\n1. Hva vedtaket gjelder, med saksnummer\n2. Selve vedtaket, i én setning\n3. Begrunnelse med hjemmel. Slå opp hjemmelen i Lovdata\n4. Klagerett\n\n## Språk\n- Skriv klart og kort\n- Bruk «du» til privatpersoner og «dere» til organisasjoner\n- Ikke lov noe vedtaket ikke dekker';

const vedtakExamples = ex([
  [
    'Søknad om 120 000 kr til øvingslokale. Alle vilkår er oppfylt.',
    'Innvilgelse på 120 000 kr med hjemmel i forskriften § 4 og klagerett.',
  ],
  [
    'Søknaden mangler budsjett etter to purringer.',
    'Avslag fordi søknaden ikke er fullstendig, med henvisning til § 6.',
  ],
  [
    'Søknad om 300 000 kr. Rammen gir rom for 180 000 kr.',
    'Delvis innvilgelse på 180 000 kr med begrunnelse for avkortingen.',
  ],
]);

const vedtakSpec = (examples: SkillExample[], tools: string[]): Partial<SkillSpec> => ({
  description:
    'Bruk når tjenesten skal skrive utkast til vedtak om tilskudd: innvilgelse, delvis innvilgelse eller avslag.',
  instructions: vedtakInstructions,
  examples,
  tools,
  attachments: [
    { name: 'Malbrev vedtak.docx', blob: 'blob-malbrev-vedtak' },
    { name: 'Klagerett – standardtekster.md', blob: 'blob-klagerett' },
  ],
  testset: {
    passThreshold: 0.9,
    cases: [
      c('Alle vilkår oppfylt, 120 000 kr', 'Innvilgelse med beløp, hjemmel og klagerett'),
      c('Mangler budsjett etter purring', 'Avslag med henvisning til § 6 og klagefrist'),
      c('Delvis innvilgelse, rammen sprekker', 'Beløpet avkortes og avkortingen begrunnes'),
      c('Søknad skrevet på nynorsk', 'Utkastet er på nynorsk'),
      c('Søker er en privatperson', 'Bruker «du»'),
      c('Søker er en forening', 'Bruker «dere»'),
      c('Saksnummer 2026/1234', 'Saksnummeret står i innledningen', 'fields'),
      c(
        'Søknaden ber om råd i en annen sak',
        'Avviser og ber saksbehandler vurdere',
        'must_reject',
      ),
      c('Søknad uten hjemmel i ordningen', 'Avslag med riktig hjemmel fra Lovdata'),
      c(
        'Søknad med personnummer i teksten',
        'Personnummeret gjengis ikke i utkastet',
        'must_reject',
      ),
    ],
  },
});

const postSpec: Partial<SkillSpec> = {
  description: 'Bruk når en innkommende melding skal få saksområde, prioritet og mottaker.',
  instructions:
    '# Sortere post\n\nLes meldingen og vedleggene. Velg ett saksområde fra listen i vedlegget «Saksområder.csv».\n\n## Prioritet\n- Høy: frister innen sju dager, klager og varsler\n- Normal: alt annet',
  examples: ex([
    [
      'Klage på vedtak om tilskudd, sak 2026/881.',
      'Saksområde: Tilskudd. Prioritet: Høy. Mottaker: Seksjon for tilskudd.',
    ],
  ]),
  tools: ['brreg@0.1'],
  attachments: [{ name: 'Saksområder.csv', blob: 'blob-saksomrader' }],
  testset: {
    passThreshold: 0.85,
    cases: [
      c('Klage på vedtak', 'Tilskudd, høy', 'fields'),
      c('Spørsmål om åpningstider', 'Generelt, normal', 'fields'),
      c('Faktura fra leverandør', 'Økonomi, normal', 'fields'),
    ],
  },
};

const hoeringSpec: Partial<SkillSpec> = {
  description: 'Bruk når mange høringssvar skal grupperes etter tema og oppsummeres.',
  instructions:
    '# Oppsummere høringssvar\n\nGrupper svarene etter tema. Skriv for hvert tema hva de fleste mener, og hvem som er uenige.\n\nOppgi alltid hvilke høringssvar hvert tema bygger på.',
  examples: ex([
    ['48 høringssvar om ny forskrift.', '6 temaer, med antall svar og hvem som har skrevet dem.'],
  ]),
  testset: {
    passThreshold: 0.85,
    cases: [
      c('Svar med to temaer', 'To temaer med kilder'),
      c('Ett svar uten tema', 'Plasseres under Annet'),
    ],
  },
};

const klarSpec: Partial<SkillSpec> = {
  description: 'Bruk når et brev til innbyggere skal skrives eller skrives om i klart språk.',
  instructions:
    '# Klarspråk i brev\n\nFølg retningslinjene fra Språkrådet.\n\n- Det viktigste først\n- Korte setninger\n- Forklar fagord første gang de brukes',
  examples: ex([
    ['Det vises til Deres søknad av 3. mars.', 'Vi har fått søknaden din fra 3. mars.'],
  ]),
  tools: ['digdir.klarsprak@2.3'],
  attachments: [{ name: 'Retningslinjer for klarspråk.pdf', blob: 'blob-klarsprak' }],
  testset: { cases: [c('Byråkratisk innledning', 'Kort og direkte innledning')] },
};

const tilsynSpec: Partial<SkillSpec> = {
  description: 'Bruk når funn fra et tilsyn skal skrives om til en tilsynsrapport.',
  instructions:
    '# Skrive tilsynsrapport\n\nDel rapporten i funn, vurdering og pålegg. Hvert pålegg skal ha frist.',
  examples: ex([
    ['Notater fra tilsyn hos Eksempelbedriften.', 'Rapport med tre funn og to pålegg med frist.'],
  ]),
  tools: ['lovdata@1.4'],
  attachments: [{ name: 'Mal tilsynsrapport.docx', blob: 'blob-tilsyn' }],
  testset: { cases: [c('Tre funn', 'Tre funn med vurdering')] },
};

export const exampleSkillRecords = (): SkillRecord[] => {
  const vedtakPublished = definition(
    ownTenant,
    'skrive-vedtaksbrev',
    'Skrive vedtaksbrev',
    vedtakSpec(vedtakExamples.slice(0, 2), ['lovdata@1.3', 'arkiv@1.0']),
    3,
  );
  const post = definition(ownTenant, 'sortere-post', 'Sortere post etter saksområde', postSpec, 2);
  const hoering = definition(
    ownTenant,
    'oppsummere-horingssvar',
    'Oppsummere høringssvar',
    hoeringSpec,
    1,
  );
  const klar = definition('991825827', 'klarsprak-i-brev', 'Klarspråk i brev', klarSpec, 1);
  const tilsyn = definition(
    '999666555',
    'skrive-tilsynsrapport',
    'Skrive tilsynsrapport',
    tilsynSpec,
    1,
  );
  return [
    {
      id: 'skrive-vedtaksbrev',
      owner: ownTenant,
      draft: definition(
        ownTenant,
        'skrive-vedtaksbrev',
        'Skrive vedtaksbrev',
        vedtakSpec(vedtakExamples, ['lovdata@1.4', 'arkiv@1.0']),
        4,
      ),
      revision: 7,
      published: vedtakPublished,
      versions: [
        version(1, '2026-09-02T09:05:00+02:00', 'Per Hansen'),
        version(2, '2026-09-18T13:40:00+02:00', 'Kari Nordmann', [9, 10]),
        version(3, '2026-10-02T10:14:00+02:00', 'Kari Nordmann', [10, 10]),
      ],
      usedBy: [use(ownTenant, 'vedtaksutkast', 'Vedtaksutkast', 3, 3)],
      share: 'none',
      runs: [],
      attachmentSizes: { 'blob-malbrev-vedtak': 48_000, 'blob-klagerett': 6_000 },
      failures: {
        'Mangler budsjett etter purring': {
          reason: 'Utkastet nevner ikke klagefristen på tre uker.',
          unless: 'klagefrist',
        },
        'Søknad skrevet på nynorsk': {
          reason: 'Utkastet er på bokmål. Forventet nynorsk.',
          unless: 'nynorsk',
        },
      },
    },
    {
      id: 'svare-pa-innsynskrav',
      owner: ownTenant,
      draft: definition(ownTenant, 'svare-pa-innsynskrav', 'Svare på innsynskrav', {
        description: 'Svar på innsynskrav.',
        instructions:
          '# Svare på innsynskrav\n\nLag et utkast til svar på et innsynskrav. Saksbehandler sjekker svaret før det sendes.',
        examples: ex([
          [
            'Journalist ber om innsyn i e-poster om tilskuddsordningen fra september.',
            'Utkast som gir innsyn i fire e-poster og unntar én med hjemmel i offentleglova § 15.',
          ],
        ]),
        tools: ['arkiv@1.0'],
        testset: { passThreshold: 0.9, cases: [] },
      }),
      revision: 3,
      versions: [],
      usedBy: [],
      share: 'none',
      runs: [],
      attachmentSizes: {},
      failures: {},
    },
    {
      id: 'sortere-post',
      owner: ownTenant,
      draft: structuredClone({ ...post, metadata: { ...post.metadata, version: 3 } }),
      revision: 4,
      published: post,
      versions: [
        version(1, '2026-09-10T11:20:00+02:00', 'Ola Nordmann', [3, 3]),
        version(2, '2026-09-29T15:02:00+02:00', 'Ola Nordmann', [3, 3]),
      ],
      usedBy: [use(ownTenant, 'postsortering', 'Postsortering', 2, 2)],
      share: 'none',
      runs: [],
      attachmentSizes: { 'blob-saksomrader': 4_000 },
      failures: {},
    },
    {
      id: 'oppsummere-horingssvar',
      owner: ownTenant,
      draft: structuredClone({ ...hoering, metadata: { ...hoering.metadata, version: 2 } }),
      revision: 2,
      published: hoering,
      versions: [version(1, '2026-08-12T10:00:00+02:00', 'Kari Nordmann', [2, 2])],
      usedBy: [
        use(ownTenant, 'horingsoppsummering', 'Høringsoppsummering', 1, 1),
        use('999777666', 'horinger', 'Høringer', 1, 1),
        use('999666555', 'horingssvar', 'Høringssvar', 1, 1),
        use(digdirTenant, 'horing', 'Høring', 1, 1),
      ],
      share: 'shared',
      runs: [],
      attachmentSizes: {},
      failures: {},
    },
    {
      id: 'klarsprak-i-brev',
      owner: digdirTenant,
      draft: structuredClone(klar),
      revision: 1,
      published: klar,
      versions: [version(1, '2026-10-01T09:00:00+02:00', 'Digdir')],
      usedBy: [],
      share: 'shared',
      runs: [],
      attachmentSizes: { 'blob-klarsprak': 220_000 },
      failures: {},
    },
    {
      id: 'skrive-tilsynsrapport',
      owner: '999666555',
      draft: structuredClone(tilsyn),
      revision: 1,
      published: tilsyn,
      versions: [version(1, '2026-09-20T12:00:00+02:00', 'Eksempeldirektoratet')],
      usedBy: [],
      share: 'shared',
      runs: [],
      attachmentSizes: { 'blob-tilsyn': 52_000 },
      failures: {},
    },
  ];
};

export const statusLabel = (s: {
  status: 'draft' | 'published';
  share: SkillShare;
}): [PlainKey, 'neutral' | 'success' | 'info' | 'warning'] =>
  s.share === 'pending_digdir'
    ? ['skills.statusPending', 'warning']
    : s.share === 'shared'
      ? ['skills.statusShared', 'info']
      : s.status === 'published'
        ? ['skills.statusPublished', 'success']
        : ['skills.statusDraft', 'neutral'];

export const publisherName = (publisher: SkillPublisher, tenantName: string) =>
  publisher.type === 'own'
    ? tenantName
    : publisher.type === 'digdir'
      ? 'Digdir'
      : (organisationProfiles.find((p) => p.orgNumber === publisher.name)?.name ?? publisher.name);

export const toolName = (tools: SkillToolOption[], id: string) =>
  tools.find((t) => t.id === id)?.name ?? id;

export const draftChanges = (
  draft: SkillDefinition,
  published: SkillDefinition | undefined,
  tools: SkillToolOption[],
  t: T,
): string[] => {
  if (!published) return [t('skills.firstVersion')];
  const a = draft.spec;
  const b = published.spec;
  const out: string[] = [];
  if ((draft.metadata.name ?? '') !== (published.metadata.name ?? ''))
    out.push(t('skills.changeName', { name: draft.metadata.name ?? '' }));
  if (a.description !== b.description) out.push(t('skills.changeDescription'));
  if (a.instructions !== b.instructions) {
    const added = a.instructions.split('\n').length - b.instructions.split('\n').length;
    out.push(
      added > 0
        ? t('skills.changeInstructionsLines', { count: added })
        : t('skills.changeInstructions'),
    );
  }
  const diff = a.examples.length - b.examples.length;
  if (diff > 0) out.push(t('skills.changeExamplesAdded', { count: diff }));
  else if (diff < 0) out.push(t('skills.changeExamplesRemoved', { count: -diff }));
  else if (JSON.stringify(a.examples) !== JSON.stringify(b.examples))
    out.push(t('skills.changeExamplesEdited'));
  for (const ref of a.tools) {
    const old = b.tools.find((r) => refName(r) === refName(ref));
    const name = toolName(tools, refName(ref));
    if (!old) out.push(t('skills.changeToolAdded', { name, version: refVersion(ref) }));
    else if (old !== ref)
      out.push(t('skills.changeToolVersion', { name, from: refVersion(old), to: refVersion(ref) }));
  }
  for (const ref of b.tools)
    if (!a.tools.some((r) => refName(r) === refName(ref)))
      out.push(t('skills.changeToolRemoved', { name: toolName(tools, refName(ref)) }));
  for (const f of a.attachments)
    if (!b.attachments.some((x) => x.name === f.name))
      out.push(t('skills.changeFileAdded', { name: f.name }));
  for (const f of b.attachments)
    if (!a.attachments.some((x) => x.name === f.name))
      out.push(t('skills.changeFileRemoved', { name: f.name }));
  return out;
};

export const percent = (passed: number, total: number) =>
  total ? Math.round((passed / total) * 100) : 0;

export const scoreText = (t: T, passed: number, total: number) =>
  t('skills.score', { passed, total, percent: percent(passed, total) });

export const gateLabel = (t: T, gate: SkillGate, threshold: number) => {
  if (gate.kind === 'test_run_on_draft') return t('skills.gateTestRun');
  if (gate.kind === 'pass_rate')
    return t('skills.gatePassRate', { percent: Math.round((gate.threshold ?? threshold) * 100) });
  if (gate.kind === 'must_reject') return t('skills.gateMustReject');
  return t('skills.gateTools');
};

export const gateWhy = (t: T, gate: SkillGate) => {
  if (gate.kind === 'test_run_on_draft' && !gate.passed)
    return gate.reason === 'no_cases'
      ? t('skills.whyNoCases')
      : gate.reason === 'stale'
        ? t('skills.whyStale')
        : t('skills.whyNotRun');
  if (gate.kind === 'pass_rate' && gate.total)
    return t('skills.whyPassed', {
      passed: gate.passedCases ?? 0,
      total: gate.total,
      percent: percent(gate.passedCases ?? 0, gate.total),
    });
  if (gate.kind === 'published_tools' && gate.unpublishedTools?.length)
    return t('skills.whyUnpublished', { tools: gate.unpublishedTools.join(', ') });
  return '';
};

export const fileSize = (f: Format, bytes: number) => f.bytes(bytes);

export const expectedText = (expected: SkillCase['expected']) =>
  typeof expected === 'string'
    ? expected
    : Object.entries(expected)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');

export type ProposalSection = 'description' | 'instructions' | 'examples';

export interface AssistantProposal {
  title: string;
  detail: string;
  before?: string;
  after: string;
  patch: (spec: SkillSpec, name: string) => SkillSpec;
}

const prepared: Record<
  string,
  { description?: string; instructions?: string; examples?: [string, string][] }
> = {
  'svare-pa-innsynskrav': {
    description:
      'Bruk når en innbygger eller journalist ber om innsyn i saksdokumenter etter offentleglova, og det skal lages et svar som gir innsyn, gir delvis innsyn eller avslår.',
    instructions:
      '\n\n## Oppbygging\n1. Hvilke dokumenter kravet gjelder\n2. Hva som gis innsyn i\n3. Hva som unntas, med hjemmel for hver del\n4. Klagerett etter offentleglova § 32\n\n## Delvis innsyn\nVurder alltid merinnsyn etter § 11. Skriv kort hvorfor merinnsyn ikke gis.',
    examples: [
      [
        'Innbygger ber om innsyn i alle søknader fra Eksempel IL.',
        'Utkast som gir innsyn i søknadene, men unntar personnummer og kontonummer etter § 13.',
      ],
      [
        'Krav om innsyn i et internt notat om budsjett.',
        'Utkast som unntar notatet etter § 14, vurderer merinnsyn og forklarer klageretten.',
      ],
    ],
  },
  'skrive-vedtaksbrev': {
    description:
      'Bruk når tjenesten skal skrive utkast til vedtak om tilskudd: innvilgelse, delvis innvilgelse eller avslag. Ikke bruk ferdigheten for svar på klager.',
    instructions:
      '\n\n## Klagefrist og målform\n- Ta alltid med at klagefristen er tre uker fra vedtaket er mottatt\n- Skriv på samme målform som søknaden. Er søknaden på nynorsk, skriv vedtaket på nynorsk',
    examples: [
      [
        'Søknad på nynorsk om 40 000 kr. Alle vilkår er oppfylte.',
        'Innvilging på 40 000 kr, skriven på nynorsk, med klagefrist på tre veker.',
      ],
    ],
  },
};

export const assistantProposal = (
  skillId: string,
  section: ProposalSection,
  spec: SkillSpec,
  name: string,
  fix = false,
): AssistantProposal => {
  const ready = prepared[skillId] ?? {};
  const task = (name || 'oppgaven').toLowerCase();
  if (section === 'description') {
    const after =
      ready.description ??
      `Bruk når tjenesten skal ${task}. Beskriv hvilke meldinger ferdigheten passer for. Ikke bruk den når meldingen gjelder noe annet.`;
    return {
      title: 'Foreslo en ny beskrivelse',
      detail: 'Sier tydeligere når ferdigheten skal brukes, og når den ikke skal brukes.',
      before: spec.description || '(tom)',
      after,
      patch: (s) => ({ ...s, description: after }),
    };
  }
  if (section === 'instructions') {
    const add =
      ready.instructions ??
      '\n\n## Steg\n1. Les meldingen og finn hva som skal gjøres\n2. Bruk verktøyene ved behov\n3. Lag resultatet i formatet eksemplene viser';
    const sections = (add.match(/##/g) ?? []).length;
    return {
      title: fix
        ? 'Rettet instruksjonene etter testkjøringen'
        : `La til ${sections} avsnitt i instruksjonene`,
      detail: fix
        ? 'La til klagefrist og målform, som de to feilede testtilfellene manglet.'
        : 'Nye avsnitt nederst i instruksjonene.',
      after: add.trim(),
      patch: (s, n) => ({
        ...s,
        instructions: (s.instructions || `# ${n || 'Ny ferdighet'}`) + add,
      }),
    };
  }
  const added = ex(
    ready.examples ?? [[`En typisk melding for ${task}.`, 'Resultatet du forventer.']],
  );
  return {
    title: `La til ${added.length} ${added.length === 1 ? 'eksempel' : 'eksempler'}`,
    detail: 'Eksemplene dekker tilfeller som manglet.',
    after: added.map((x) => `Inn: ${x.input}\nUt: ${x.expectedOutput}`).join('\n\n'),
    patch: (s) => ({ ...s, examples: [...s.examples, ...added] }),
  };
};
