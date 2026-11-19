/** Sign-in through genki's BFF (ADR 0061): the page holds no token, only the host's session cookie. */
export interface SignedIn {
  name: string | null;
  organisation: string | null;
  organisations: { orgNumber: string; name?: string }[];
  expiresAt: string;
}

export type HostSession =
  | { kind: 'off' }
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; who: SignedIn };

export interface HostSignIn {
  /** Whether the host serves the BFF, and who is signed in through it. */
  session(): Promise<HostSession>;
  signInUrl(next: string): string;
  signOutUrl: string;
  /** Headers for every API call from the page, so a state-changing call passes the CSRF check. */
  headers(): Record<string, string>;
  chooseOrganisation(orgNumber: string): Promise<SignedIn>;
}

const isJson = (response: Response) =>
  /^application\/([a-z0-9.+-]*\+)?json\s*(;|$)/i.test(response.headers.get('content-type') ?? '');

const isSignedIn = (body: unknown): body is SignedIn =>
  typeof body === 'object' &&
  body !== null &&
  typeof (body as SignedIn).expiresAt === 'string' &&
  Array.isArray((body as SignedIn).organisations);

export const bffSignIn = (fetcher: typeof fetch = fetch): HostSignIn => ({
  session: async () => {
    const response = await fetcher('/auth/me', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    // Without the BFF the host answers its page here, not JSON.
    if (!isJson(response)) return { kind: 'off' };
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.ok && isSignedIn(body)) return { kind: 'signed-in', who: body };
    if (
      response.status === 404 &&
      (body as { code?: unknown } | undefined)?.code === 'bff-not-configured'
    )
      return { kind: 'unavailable' };
    return { kind: 'off' };
  },
  signInUrl: (next) => `/auth/login?next=${encodeURIComponent(next)}`,
  signOutUrl: '/auth/logout',
  headers: () => ({ 'genai-csrf': '1' }),
  chooseOrganisation: async (orgNumber) => {
    const response = await fetcher('/auth/org', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ organisation: orgNumber }),
    });
    if (!response.ok) throw new Error(`choosing the organisation answered ${response.status}`);
    return (await response.json()) as SignedIn;
  },
});
