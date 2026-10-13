import type { Session } from './types';

export interface AuthClient {
  current(): Session | undefined;
  login(): Promise<Session>;
  logout(endSession?: boolean): Promise<void>;
  callbackPending?(): boolean;
  expiresAt?(): number | undefined;
  refresh?(): Promise<Session | undefined>;
}

export interface TestPerson {
  name: string;
  organisations: Session['organisations'];
}

export const mockAnsattporten = (person: TestPerson, delayMs = 0): AuthClient => {
  let session: Session | undefined;
  return {
    current: () => session,
    login: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      session = { ...person, token: 'mock-ansattporten-token' };
      return session;
    },
    logout: async () => {
      session = undefined;
    },
  };
};

export const localDevLogin = (fetcher: typeof fetch = fetch): AuthClient => {
  let session: Session | undefined;
  return {
    current: () => session,
    login: async () => {
      const response = await fetcher('/api/mock/dev-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ as: 'employee' }),
      });
      if (!response.ok) throw new Error(`local dev login failed with status ${response.status}`);
      const body = (await response.json()) as Session;
      session = { name: body.name, organisations: body.organisations, token: body.token };
      return session;
    },
    logout: async () => {
      session = undefined;
    },
  };
};
