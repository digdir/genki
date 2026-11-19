/** Sign-in through genki's BFF (ADR 0061): the page holds no token, only the host's session cookie. */
export interface SignedIn {
  name: string | null;
  organisation: string | null;
  organisations: { orgNumber: string; name?: string }[];
  expiresAt: string;
}

export interface HostSignIn {
  /** Who is signed in, or undefined when no one is. */
  current(): Promise<SignedIn | undefined>;
  signInUrl(next: string): string;
  signOutUrl: string;
  /** Headers for every API call from the page, so a state-changing call passes the CSRF check. */
  headers(): Record<string, string>;
  chooseOrganisation(orgNumber: string): Promise<SignedIn>;
}

export const bffSignIn = (fetcher: typeof fetch = fetch): HostSignIn => ({
  current: async () => {
    const response = await fetcher('/auth/me', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (response.status === 401) return undefined;
    if (!response.ok) throw new Error(`sign-in answered ${response.status}`);
    return (await response.json()) as SignedIn;
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
