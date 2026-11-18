import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { actorNames, personNameOf } from './actor-names.js';
import { InMemoryConfigEntryStore } from './config-store.js';

const kari: Principal = {
  kind: 'employee',
  issuer: 'https://login.example',
  subject: 'kari',
  name: 'kari.nordmann@example.no',
  email: 'kari.nordmann@example.no',
  tenant: '312521172',
};

describe('actor names', () => {
  it('a name from the token beats the sign-in name', () => {
    expect(personNameOf({ ...kari, name: 'Kari Nordmann' }, 'Someone Else')).toBe('Kari Nordmann');
  });

  it('an email standing in for the name gives way to the sign-in name', () => {
    expect(personNameOf(kari, 'Kari Nordmann')).toBe('Kari Nordmann');
  });

  it('keeps the email when nothing better is known', () => {
    expect(personNameOf(kari, 'kari.nordmann@example.no')).toBe('kari.nordmann@example.no');
  });

  it('a stored email is replaced by the real name at the next sign-in', async () => {
    const names = actorNames(new InMemoryConfigEntryStore());
    await names.remember(kari, 'kari.nordmann@example.no');
    await names.remember(kari, personNameOf(kari, 'Kari Nordmann') ?? '');
    expect(await names.nameOf('employee:https://login.example:kari')).toBe('Kari Nordmann');
  });

  it('asks the store again for a person without a name only after a while', async () => {
    const store = new InMemoryConfigEntryStore();
    let asked = 0;
    const history = store.history.bind(store);
    store.history = async (...args: Parameters<typeof history>) => {
      asked += 1;
      return history(...args);
    };
    let clock = 0;
    const names = actorNames(store, () => clock);

    await names.namesOf(['employee:x:ola', 'employee:x:ola']);
    await names.nameOf('employee:x:ola');
    clock = 5 * 60 * 1000 + 1;
    await names.nameOf('employee:x:ola');

    expect(asked).toBe(2);
  });
});
