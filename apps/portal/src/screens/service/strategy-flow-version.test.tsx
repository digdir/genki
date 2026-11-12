// @vitest-environment jsdom
import { fixtureSchemaFetch } from '@genai/schema-forms/fixtures';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api';
import { applySpec, type ServiceDefinition } from '../../data/service-definition';
import { exampleTemplate } from '../../data/services';
import { registerStrategies } from '../../data/strategies';
import { platformStrategies } from '../../mock/strategies';
import { StrategyPanel } from './StrategyPanel';

document.getAnimations ??= () => [];
afterEach(cleanup);
registerStrategies(platformStrategies);

const served = fixtureSchemaFetch();

const flowVersion = (version: number, steps: { id: string; name: string }[]) => ({
  kind: 'StepFlow',
  tenant: '991825827',
  id: 'postruting',
  version,
  publishedBy: 'employee:ansattporten:kari',
  publishedAt: '2026-10-02T10:00:00Z',
  reason: '',
  definition: {
    kind: 'StepFlow',
    metadata: { id: 'postruting', version },
    spec: { purpose: 'Rut post', steps: steps.map((s) => ({ ...s, block: 'classify@1' })) },
  },
});

const v1 = flowVersion(1, [{ id: 'gammel', name: 'Gammel sortering' }]);
const v2 = flowVersion(2, [{ id: 'ny', name: 'Ny sortering' }]);

const api = {
  getJson: async (path: string) => served(path),
  listModels: async () => [],
  listDefinitions: async () => [{ kind: 'StepFlow', id: 'postruting', latestVersion: 2 }],
  getDefinition: async () => ({
    kind: 'StepFlow',
    id: 'postruting',
    latest: v2,
    versions: [
      { version: 2, publishedBy: '', publishedAt: '', reason: '' },
      { version: 1, publishedBy: '', publishedAt: '', reason: '' },
    ],
  }),
  getVersion: async (_t: string, _k: string, _id: string, version: number) =>
    version === 1 ? v1 : v2,
} as unknown as ApiClient;

const Harness = ({ seen }: { seen: (d: ServiceDefinition) => void }) => {
  const [definition, setDefinition] = useState(() => {
    const d = exampleTemplate('prepares', 'Post');
    return applySpec(d, () => ({
      strategy: { id: 'step-flow', version: 1, config: { flow: 'postruting@1' } },
    }));
  });
  return (
    <StrategyPanel
      api={api}
      tenant="991825827"
      definition={definition}
      patch={(edit) =>
        setDefinition((d) => {
          const next = applySpec(d, edit);
          seen(next);
          return next;
        })
      }
    />
  );
};

describe('the step flow a service uses', () => {
  it('lists every published version of a flow, not only the newest', async () => {
    render(<Harness seen={() => undefined} />);
    const picker = await screen.findByRole('combobox', { name: 'Stegflyt' });
    const options = () => [
      ...(picker.closest('ds-suggestion')?.querySelectorAll<HTMLOptionElement>('u-option') ?? []),
    ];
    await waitFor(() =>
      expect(
        options()
          .filter((o) => o.value)
          .map((o) => o.textContent),
      ).toEqual(['postruting, versjon 2 (nyeste)', 'postruting, versjon 1']),
    );
  });

  it('shows the steps of the pinned version and offers the newer one as one click', async () => {
    let latest: ServiceDefinition | undefined;
    render(<Harness seen={(d) => (latest = d)} />);
    const steps = await screen.findByRole('list', { name: 'Stegene i postruting' });
    expect(within(steps).getByText('Gammel sortering')).toBeTruthy();
    expect(within(steps).queryByText('Ny sortering')).toBeNull();
    expect(screen.getByText('Ny versjon er tilgjengelig: postruting v2.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Oppdater til v2' }));
    expect(latest?.spec.strategy.config).toEqual({ flow: 'postruting@2' });
    expect(await screen.findByText('Ny sortering')).toBeTruthy();
    expect(screen.queryByText(/Ny versjon er tilgjengelig/)).toBeNull();
  });
});
