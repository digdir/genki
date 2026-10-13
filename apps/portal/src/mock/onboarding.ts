import type { AccessRequest, AccessRequestInput } from '../api/onboarding';
import type { MockHandler } from '../mock';

export interface OnboardingMockOptions {
  requests?: AccessRequest[];
  registered?: string[];
  pendingByOther?: Record<string, string>;
  mayRequest?: boolean;
}

export const onboardingMock = (options: OnboardingMockOptions = {}): MockHandler => {
  const requests = structuredClone(options.requests ?? []);
  const registered = options.registered ?? [];
  const byOther = options.pendingByOther ?? {};
  return (req) => {
    if (req.path === '/onboarding/requests/mine' && req.method === 'GET')
      return req.json({ data: requests });
    const status = /^\/onboarding\/organisations\/([^/]+)$/.exec(req.path);
    if (status && req.method === 'GET') {
      const org = decodeURIComponent(status[1] ?? '');
      const mine = requests.find((r) => r.org === org && r.status === 'pending');
      const other = byOther[org];
      return req.json({
        org,
        registered: registered.includes(org),
        mayRequest: options.mayRequest ?? true,
        pendingRequest: mine
          ? { requestedAt: mine.requestedAt, mine: true }
          : other
            ? { requestedAt: other, mine: false }
            : null,
      });
    }
    if (req.path !== '/onboarding/requests' || req.method !== 'POST') return undefined;
    const body = req.body<Partial<AccessRequestInput>>();
    const missing = (['org', 'orgName', 'contactName', 'contactEmail', 'purpose'] as const).filter(
      (k) => !body[k]?.trim(),
    );
    if (missing.length || body.acceptedTerms !== true)
      return req.json(
        {
          title: 'Ugyldig forespørsel',
          status: 400,
          errors: [
            ...missing.map((path) => ({ path, message: 'required' })),
            ...(body.acceptedTerms === true
              ? []
              : [{ path: 'acceptedTerms', message: 'the terms must be accepted' }]),
          ],
        },
        400,
      );
    const org = body.org ?? '';
    if (
      registered.includes(org) ||
      byOther[org] ||
      requests.some((r) => r.org === org && r.status === 'pending')
    )
      return req.json(
        { title: 'Virksomheten er registrert eller har en forespørsel som venter', status: 409 },
        409,
      );
    const created: AccessRequest = {
      id: `req-${requests.length + 1}`,
      org,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      contactEmail: body.contactEmail ?? '',
    };
    requests.unshift(created);
    return req.json({ id: created.id, status: created.status }, 201);
  };
};
