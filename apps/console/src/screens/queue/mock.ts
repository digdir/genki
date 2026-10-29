import type {
  AccessRequest,
  BlockApprovalRequest,
  PlatformProposal,
  QuarantinedDefinition,
  SkillShareRequest,
} from '../../types';

export const exampleBlockRequests: BlockApprovalRequest[] = [
  {
    id: 'ar-12',
    tenant: '999888777',
    tenantName: 'Testetaten',
    block: {
      kind: 'model',
      id: 'claude-sonnet-5-5',
      version: '1.0',
      name: 'Claude Sonnet 5.5',
      publisher: 'Anthropic',
      dataLocation: 'global',
      rule: {
        rule: 'M-3',
        ownedBy: 'Digdir',
        text: 'Modeller utenfor EU/EØS krever godkjenning (plattformregel M-3). Regelen kan endres av Digdir, ikke av virksomheten.',
      },
      access: [
        {
          type: 'network',
          value: 'api.anthropic.com',
          note: 'Spørsmål og dokumentutdrag fra tjenestene som bruker den',
        },
      ],
      scores: [
        { testSet: 'Saksbehandling, bokmål', service: 'vedtaksutkast', score: 0.82 },
        { testSet: 'Lange dokumenter', service: 'vedtaksutkast', score: 0.88 },
      ],
      services: ['Vedtaksutkast'],
    },
    reason: 'Vedtaksutkast trenger en modell som resonnerer bedre over lange regelverk.',
    requestedBy: 'Kari Nordmann',
    requestedAt: '2026-10-07T08:30:00Z',
    status: 'pending',
  },
  {
    id: 'ar-9',
    tenant: '983888999',
    tenantName: 'Eksempelhelseforetaket',
    block: { kind: 'tool', id: 'web-search', version: '2.1', name: 'Nettsøk' },
    reason: 'Svar om offentlige retningslinjer.',
    requestedBy: 'Leif Strand',
    requestedAt: '2026-10-02T12:10:00Z',
    status: 'approved',
    decision: {
      by: 'operator:entra:lise',
      byName: 'Lise Dahl',
      at: '2026-10-03T09:00:00Z',
      reason: 'Godkjent for helsefaglige kilder.',
    },
  },
];

export const exampleSkillShares: SkillShareRequest[] = [
  {
    id: '999888777-klarsprak',
    tenant: '999888777',
    tenantName: 'Testetaten',
    skill: 'klarsprak',
    skillName: 'Klarspråk',
    version: '3',
    state: 'pending_digdir',
    by: 'employee:altinn:kari',
    byName: 'Kari Nordmann',
    at: '2026-10-06T14:00:00Z',
    reason: 'Flere etater har spurt om å få bruke den.',
    detail: {
      description:
        'Skriver om vedtakstekst til klarspråk etter Språkrådets råd, uten å endre det juridiske innholdet.',
      instructions:
        'Skriv korte setninger.\nBruk du-form til mottakeren.\nEndre aldri beløp, datoer eller frister.',
      tools: ['lovdata@1.4'],
      test: { score: 0.95, passed: 19, total: 20, threshold: 0.9 },
      previous: {
        version: 2,
        instructions: 'Skriv korte setninger.\nBruk De-form til mottakeren.',
      },
    },
  },
];

export const exampleProposals: PlatformProposal[] = [
  {
    id: 'p-41',
    tenant: '983888999',
    tenantName: 'Eksempelhelseforetaket',
    title: 'Koble til journalsystemet',
    summary: 'Tjenesten trenger lesetilgang til journalsystemet for å oppsummere pasientforløp.',
    status: 'pending',
    createdAt: '2026-10-05T10:20:00Z',
    createdBy: 'assistant',
    requestedByName: 'Hanne Lie',
    ask: 'Kan tjenesten lese pasientforløpet i journalsystemet og lage en oppsummering?',
    detail:
      'Ingen eksisterende utløser eller kobling leser journalsystemet, og en egen byggekloss kan ikke få tilgang til det.',
    forService: { id: 'forlop', name: 'Forløpsoppsummering' },
    platformChange: { status: 'sent', caseId: 'KI-2026-0007' },
  },
];

export const exampleAccessRequests: AccessRequest[] = [
  {
    id: 'req-7',
    org: '940999000',
    orgName: 'Eksempel kommune',
    contactName: 'Ola Nordmann',
    contactEmail: 'ola.nordmann@example.no',
    purpose: 'Vil prøve Kunnskapsassistenten for saksbehandlere i byggesak.',
    requestedBy: 'Ola Nordmann',
    requesterName: 'Ola Viken',
    requestedAt: '2026-10-07T07:45:00Z',
    status: 'pending',
    terms: { at: '2026-10-07T07:45:00Z', version: 'utkast' },
  },
];

export const exampleQuarantine: QuarantinedDefinition[] = [
  {
    tenant: '999888777',
    kind: 'Service',
    id: 'vedtaksutkast',
    version: 4,
    errors: [{ path: 'spec.strategy.ref', message: 'ukjent strategi «agent-loop@3»' }],
    at: '2026-10-07T05:02:00Z',
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

const invalid = () =>
  json(
    {
      title: 'Ugyldig forespørsel',
      status: 400,
      errors: [{ path: 'approve', message: 'approve (true eller false) og en begrunnelse kreves' }],
    },
    400,
  );

const notPending = () => json({ title: 'Fant ikke en ventende forespørsel', status: 404 }, 404);

export const queueMock = (
  record: (tenant: string, action: string, target: string, reason: string) => void,
) => {
  let blocks = structuredClone(exampleBlockRequests);
  let shares = structuredClone(exampleSkillShares);
  let proposals = structuredClone(exampleProposals);
  let access = structuredClone(exampleAccessRequests);
  const quarantine = structuredClone(exampleQuarantine);

  return (
    path: string,
    method: string,
    reason: string | null,
    body: () => Record<string, unknown>,
  ): Response | undefined => {
    if (method === 'GET') {
      if (path === '/operator/building-blocks/approval-requests') return json({ data: blocks });
      if (path === '/operator/skills/shares') return json({ data: shares });
      if (path === '/operator/proposals') return json({ data: proposals });
      if (path === '/operator/onboarding/requests') return json({ data: access });
      if (path === '/operator/definitions/quarantine') return json({ data: quarantine });
      return undefined;
    }
    const review = /^\/operator\/proposals\/([^/]+)\/status$/.exec(path);
    if (review && method === 'POST') {
      const input = body();
      const why = reason ?? '';
      const found = proposals.find((p) => p.id === decodeURIComponent(review[1] ?? ''));
      if (!found || found.status !== 'pending') return notPending();
      if (input.status !== 'under_review' || why.trim().length < 10) return invalid();
      const next: PlatformProposal = {
        ...found,
        platformChange: { ...found.platformChange, status: 'under_review' },
      };
      proposals = proposals.map((p) => (p === found ? next : p));
      record(found.tenant, 'Satte endring under vurdering', found.title, why);
      return json(next);
    }
    const match =
      /^\/operator\/(building-blocks\/approval-requests|skills\/shares|proposals|onboarding\/requests)\/([^/]+)\/decision$/.exec(
        path,
      );
    if (!match || method !== 'POST') return undefined;
    const input = body();
    const why = reason ?? (typeof input.reason === 'string' ? input.reason : '');
    if (typeof input.approve !== 'boolean' || !why.trim()) return invalid();
    const approve = input.approve;
    const id = decodeURIComponent(match[2] ?? '');
    const status = approve ? 'approved' : 'rejected';
    const decision = {
      by: 'operator:entra:lise',
      byName: 'Lise Dahl',
      at: new Date().toISOString(),
      reason: why,
    };
    switch (match[1]) {
      case 'building-blocks/approval-requests': {
        const found = blocks.find((r) => r.id === id && r.status === 'pending');
        if (!found) return notPending();
        const next = { ...found, status, decision };
        blocks = blocks.map((r) => (r === found ? next : r));
        record(
          found.tenant,
          approve ? 'Godkjente byggekloss' : 'Avviste byggekloss',
          found.block.name ?? found.block.id,
          why,
        );
        return json(next);
      }
      case 'skills/shares': {
        const found = shares.find((s) => s.id === id && s.state === 'pending_digdir');
        if (!found) return notPending();
        const next = {
          ...found,
          state: approve ? 'shared' : 'rejected',
          decision: { ...decision, approved: approve },
        };
        shares = shares.map((s) => (s === found ? next : s));
        record(
          found.tenant,
          approve ? 'Delte ferdighet' : 'Avviste deling',
          found.skillName ?? found.skill,
          why,
        );
        return json(next);
      }
      case 'proposals': {
        const found = proposals.find((p) => p.id === id && p.status === 'pending');
        if (!found) return notPending();
        const caseId =
          typeof input.caseId === 'string' && input.caseId
            ? input.caseId
            : found.platformChange?.caseId;
        const next: PlatformProposal = {
          ...found,
          status,
          platformChange: {
            status: approve ? 'planned' : 'rejected',
            ...(caseId ? { caseId } : {}),
          },
          decision,
        };
        proposals = proposals.map((p) => (p === found ? next : p));
        record(found.tenant, approve ? 'Godkjente endring' : 'Avviste endring', found.title, why);
        return json(next);
      }
      default: {
        const found = access.find((r) => r.id === id && r.status === 'pending');
        if (!found) return notPending();
        const next = { ...found, status, decision };
        access = access.map((r) => (r === found ? next : r));
        record(
          found.org,
          approve ? 'Godkjente tilgang' : 'Avviste tilgang',
          found.orgName ?? found.org,
          why,
        );
        return json(next);
      }
    }
  };
};
