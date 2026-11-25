import { mockFetch } from '../../mock';
import { renderAt } from '../../test-utils';

const studioOn = {
  data: [
    {
      key: 'blockStudio',
      on: true,
      source: 'person',
      selfService: true,
      person: true,
      tenant: null,
    },
  ],
};

export const withStudio =
  (base: typeof fetch = mockFetch()): typeof fetch =>
  async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/me\/flags$/.test(new URL(url, 'http://mock').pathname))
      return new Response(JSON.stringify(studioOn), {
        headers: { 'content-type': 'application/json' },
      });
    return base(input, init);
  };

export const studioAt = (path: string, fetch?: typeof globalThis.fetch) =>
  renderAt(path, withStudio(fetch));

export const heldStudio = (base?: typeof fetch) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const studio = withStudio(base);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/me\/flags$/.test(new URL(url, 'http://mock').pathname)) await held;
    return studio(input, init);
  };
  return { fetch, release };
};
