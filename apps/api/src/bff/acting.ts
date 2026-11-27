import { AsyncLocalStorage } from 'node:async_hooks';

export interface ActingClient {
  tenant: string;
  client: string;
}

export const platformApps = ['portal', 'console'] as const;

export type PlatformApp = (typeof platformApps)[number];

const acting = new AsyncLocalStorage<ActingClient>();
const actingApp = new AsyncLocalStorage<PlatformApp>();

/** The hosted Client the BFF is calling the API for, set only in this process and never from a request. */
export const actingClient = () => acting.getStore();

export const actFor = <T>(client: ActingClient, work: () => T): T => acting.run(client, work);

/** The platform app whose session the BFF is calling the API for, set only in this process. */
export const platformAppActing = () => actingApp.getStore();

export const actAsPlatformApp = <T>(app: PlatformApp, work: () => T): T => actingApp.run(app, work);
