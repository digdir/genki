import type { Session } from './types';

export interface AuthClient {
  current(): Session | undefined;
  restore?(): Promise<Session | undefined>;
  login(): Promise<Session>;
  logout?(endSession?: boolean): Promise<void>;
  expiresAt?(): number | undefined;
  refresh?(): Promise<Session | undefined>;
}

export const mockLogin = (person: Omit<Session, 'token'>, delayMs = 0): AuthClient => {
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
