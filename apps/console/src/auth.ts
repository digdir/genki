import type { OperatorSession } from './types';

export const operatorRole = 'GenAI.Operator';

export interface AuthClient {
  current(): OperatorSession | undefined;
  login(): Promise<OperatorSession>;
  logout(): Promise<void>;
  expire(): void;
  restore?(): Promise<OperatorSession | undefined>;
  expiresAt?(): number | undefined;
  renew?(): Promise<OperatorSession | undefined>;
}

export const mockEntra = (person: { name: string; roles: string[] }, delayMs = 0): AuthClient => {
  let session: OperatorSession | undefined;
  return {
    current: () => session,
    login: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      session = { ...person, token: 'mock-entra-token' };
      return session;
    },
    logout: async () => {
      session = undefined;
    },
    expire: () => {
      session = undefined;
    },
  };
};

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}
