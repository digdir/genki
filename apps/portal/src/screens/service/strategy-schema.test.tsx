// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { undescribedPaths, type UiSchema } from '@genai/schema-forms';
import { fixtureSchemaFetch } from '@genai/schema-forms/fixtures';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api';
import { applySpec, type ServiceDefinition } from '../../data/service-definition';
import { exampleTemplate } from '../../data/services';
import { StrategyPanel } from './StrategyPanel';
import { registerStrategies } from '../../data/strategies';
import { platformStrategies } from '../../mock/strategies';

document.getAnimations ??= () => [];
afterEach(cleanup);
registerStrategies(platformStrategies);

const served = fixtureSchemaFetch();

const apiWith = (getJson: (path: string) => Promise<unknown>) =>
  ({
    getJson,
    listModels: async () => [],
    listDefinitions: async () => [],
    getDefinition: async () => ({}),
  }) as unknown as ApiClient;

const Harness = ({ api, seen }: { api: ApiClient; seen?: (d: ServiceDefinition) => void }) => {
  const [definition, setDefinition] = useState(() => exampleTemplate('answers', 'Svar'));
  return (
    <StrategyPanel
      api={api}
      tenant="991825827"
      definition={definition}
      patch={(edit) =>
        setDefinition((d) => {
          const next = applySpec(d, edit);
          seen?.(next);
          return next;
        })
      }
    />
  );
};

describe('the strategy settings are generated from the served schema', () => {
  it('shows the label the schema gives, in bokmål and in English', async () => {
    const api = apiWith(async (path) => served(path));
    const { unmount } = render(<Harness api={api} />);
    expect(await screen.findByLabelText(/Maks tokens i svaret/)).toBeTruthy();
    unmount();

    render(inEnglish(<Harness api={api} />));
    expect(await screen.findByLabelText(/Max tokens in the answer/)).toBeTruthy();
    expect(screen.queryByLabelText(/Maks tokens i svaret/)).toBeNull();
  });

  it('writes a value the person types into the strategy config', async () => {
    let latest: ServiceDefinition | undefined;
    const api = apiWith(async (path) => served(path));
    render(<Harness api={api} seen={(c) => (latest = c)} />);
    fireEvent.change(await screen.findByLabelText(/Maks tokens i svaret/), {
      target: { value: '400' },
    });
    await waitFor(() => expect(latest?.spec.strategy.config).toEqual({ maxTokens: 400 }));
  });

  it('shows no hand-written fields of its own when the schema cannot be fetched', async () => {
    const api = apiWith(async () => {
      throw new Error('down');
    });
    render(<Harness api={api} />);
    expect(await screen.findByText('Henter innstillingene for arbeidsmåten.')).toBeTruthy();
    expect(screen.queryByLabelText(/Temperatur/)).toBeNull();
  });
});

describe('the strategy screen only sets values its schema describes', () => {
  it('writes no key the served strategy schema leaves undescribed', async () => {
    let latest: ServiceDefinition | undefined;
    const api = apiWith(async (path) => served(path));
    render(<Harness api={api} seen={(c) => (latest = c)} />);
    fireEvent.change(await screen.findByLabelText(/Maks tokens i svaret/), {
      target: { value: '200' },
    });
    await waitFor(() => expect(latest).toBeDefined());
    const schema = (await api.getJson('/schemas/Strategy.single-call%401')) as UiSchema;
    expect(undescribedPaths(schema, latest?.spec.strategy.config)).toEqual([]);
  });
});
