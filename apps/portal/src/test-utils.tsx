import { act, render, screen } from '@testing-library/react';
import { expect } from 'vitest';
import { App } from './App';
import { mockAnsattporten } from './auth';
import { exampleOrganisations, mockFetch } from './mock';

document.getAnimations ??= () => [];

export const kari = { name: 'Kari Nordmann', organisations: exampleOrganisations };

export const go = (path: string) =>
  act(() => {
    window.location.hash = path;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

export const renderAt = async (path: string, fetch: typeof globalThis.fetch = mockFetch()) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = path;
  const result = render(<App auth={auth} fetch={fetch} />);
  return { auth, ...result };
};

export const failingFetch =
  (pattern: RegExp, status = 503, base: typeof globalThis.fetch = mockFetch()): typeof fetch =>
  async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (pattern.test(url))
      return new Response(JSON.stringify({ title: 'Feil', status }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
      });
    return base(input, init);
  };

const accessibleName = (el: Element) => {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy)
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    const labels = el.labels ? Array.from(el.labels) : [];
    return (
      labels
        .map((l) => l.textContent ?? '')
        .join(' ')
        .trim() ||
      (el.getAttribute('title') ?? '')
    );
  }
  return (el.textContent ?? '').trim() || (el.getAttribute('title') ?? '');
};

export const expectAccessible = (root: HTMLElement = document.body) => {
  const problems: string[] = [];
  const ids = new Map<string, number>();
  root.querySelectorAll('[id]').forEach((el) => ids.set(el.id, (ids.get(el.id) ?? 0) + 1));
  ids.forEach((n, id) => n > 1 && problems.push(`duplicate id ${id}`));
  root.querySelectorAll('img').forEach((img) => {
    if (!img.hasAttribute('alt')) problems.push(`img without alt: ${img.outerHTML.slice(0, 80)}`);
  });
  root
    .querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="link"]')
    .forEach((el) => {
      if (!accessibleName(el)) problems.push(`no accessible name: ${el.outerHTML.slice(0, 120)}`);
    });
  root.querySelectorAll('input:not([type="hidden"]), textarea, select').forEach((el) => {
    if (!accessibleName(el)) problems.push(`unlabelled field: ${el.outerHTML.slice(0, 120)}`);
  });
  root.querySelectorAll('th').forEach((th) => {
    if (th.closest('thead') && !th.getAttribute('scope') && !th.closest('[role="presentation"]'))
      problems.push(`th without scope: ${th.textContent ?? ''}`);
  });
  root.querySelectorAll('[aria-labelledby]').forEach((el) => {
    (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).forEach((id) => {
      if (id && !document.getElementById(id))
        problems.push(`aria-labelledby points to missing ${id}`);
    });
  });
  root.querySelectorAll('[aria-describedby]').forEach((el) => {
    (el.getAttribute('aria-describedby') ?? '').split(/\s+/).forEach((id) => {
      if (id && !document.getElementById(id))
        problems.push(`aria-describedby points to missing ${id}`);
    });
  });
  root.querySelectorAll('button[disabled]').forEach((el) => {
    problems.push(`blocked button uses disabled instead of aria-disabled: ${el.textContent ?? ''}`);
  });
  expect(problems).toEqual([]);
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
};
