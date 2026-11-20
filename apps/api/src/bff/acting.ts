import { AsyncLocalStorage } from 'node:async_hooks';

export interface ActingClient {
  tenant: string;
  client: string;
}

const acting = new AsyncLocalStorage<ActingClient>();

/** The hosted Client the BFF is calling the API for, set only in this process and never from a request. */
export const actingClient = () => acting.getStore();

export const actFor = <T>(client: ActingClient, work: () => T): T => acting.run(client, work);
