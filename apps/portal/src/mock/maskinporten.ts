import type { MaskinportenClient, NewMaskinportenClient } from '../api/maskinporten';
import type { MockHandler } from '../mock';

export interface MaskinportenMockOptions {
  clients?: MaskinportenClient[];
}

export const exampleMaskinportenClients = (): MaskinportenClient[] => [
  {
    clientId: '4f1c2a7e-91b3-4d0a-8c55-2e6f9a1b3c7d',
    name: 'Tilskuddssystemet',
    services: ['rapportassistenten'],
    createdAt: '2026-09-14T08:30:00Z',
  },
];

export const maskinportenMock = (options: MaskinportenMockOptions = {}): MockHandler => {
  let clients = structuredClone(options.clients ?? exampleMaskinportenClients());
  return (req) => {
    const route = /^\/tenants\/[^/]+\/maskinporten-clients(?:\/([^/]+))?$/.exec(req.path);
    if (!route) return undefined;
    const id = route[1] ? decodeURIComponent(route[1]) : undefined;
    if (!id && req.method === 'GET') return req.json({ data: clients });
    if (!req.reason) return req.reasonMissing();
    if (!id && req.method === 'POST') {
      const body = req.body<Partial<NewMaskinportenClient>>();
      const errors = [
        ...(body.clientId?.trim() ? [] : [{ path: 'clientId', message: 'required' }]),
        ...(body.name?.trim() ? [] : [{ path: 'name', message: 'required' }]),
        ...(body.services?.length ? [] : [{ path: 'services', message: 'choose at least one' }]),
      ];
      if (errors.length)
        return req.json({ title: 'Ugyldig forespørsel', status: 400, errors }, 400);
      if (clients.some((c) => c.clientId === body.clientId))
        return req.json({ title: 'Klienten er allerede registrert', status: 409 }, 409);
      const created: MaskinportenClient = {
        clientId: body.clientId?.trim() ?? '',
        name: body.name?.trim() ?? '',
        services: body.services ?? [],
        createdAt: new Date().toISOString(),
      };
      clients = [...clients, created];
      return req.json(created, 201);
    }
    if (id && req.method === 'DELETE') {
      if (!clients.some((c) => c.clientId === id)) return req.notFound();
      clients = clients.filter((c) => c.clientId !== id);
      return req.json({ clientId: id, deleted: true });
    }
    return undefined;
  };
};
