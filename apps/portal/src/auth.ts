import type { Session } from './types';

export interface AuthClient {
  current(): Session | undefined;
  login(): Promise<Session>;
  logout(endSession?: boolean): Promise<void>;
  restore?(): Promise<Session | undefined>;
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
