// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { Attachments } from '../../components/Attachments';
import type { ServiceDefinition } from '../../data/service-definition';
import { withOperationModel } from '../../data/service-form';
import { exampleTemplate } from '../../data/services';
import { hasOperationSteps, operationKindsIn } from '../../data/step-operations';
import { mockFetch } from '../../mock';
import { examplePng } from '../../mock/step-operations';
import { PublishedTest } from '../service/PublishedTest';
import { Steps } from '../log/Steps';
import { SetupHarness } from './setup-harness';

document.getAnimations ??= () => [];
afterEach(cleanup);

const imageFlow = {
  spec: {
    steps: [
      { id: 'tekst', block: 'model@1' },
      {
        id: 'hver',
        forEach: {
          in: 'input.items',
          as: 'x',
          steps: [
            {
              id: 'figur',
              block: 'call-operation@1',
              params: { descriptor: 'example/generate-image@1' },
            },
          ],
        },
      },
    ],
  },
};

const operationModels = [
  {
    kind: 'generate-image',
    models: [
      { id: 'aivar/borealis-27b', name: 'Borealis-27B', where: 'Norge' },
      { id: 'foundry-openai/gpt-4.1', name: 'GPT-4.1', where: 'EU' },
    ],
  },
];

describe('model per operation in the service setup', () => {
  it('finds every kind of operation the flow calls, also inside loops', () => {
    expect(operationKindsIn(imageFlow)).toEqual(['generate-image']);
    expect(hasOperationSteps(imageFlow)).toBe(true);
    expect(hasOperationSteps({ spec: { steps: [{ id: 'a', block: 'model@1' }] } })).toBe(false);
  });

  it('the model section offers a model for each kind the flow calls, among the models that offer it', () => {
    let latest: ServiceDefinition | undefined;
    render(
      <SetupHarness
        sections={['model']}
        initial={exampleTemplate('answers')}
        operationModels={operationModels}
        onChange={(d) => (latest = d)}
      />,
    );
    const select = screen.getByLabelText('Modell for Generate image') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Hovedmodellen',
      'Borealis-27B (Norge)',
      'GPT-4.1 (EU)',
    ]);
    fireEvent.change(select, { target: { value: 'aivar/borealis-27b' } });
    expect(latest?.spec.model.operations).toEqual({ 'generate-image': 'aivar/borealis-27b' });
  });

  it('choosing the main model for an operation removes it from the service', () => {
    const spec = {
      ...exampleTemplate('answers').spec,
      model: { primary: 'a', operations: { 'generate-image': 'b' } },
    };
    expect(withOperationModel(spec, 'generate-image', '')).toEqual({ model: { primary: 'a' } });
    expect(withOperationModel(spec, 'speak', 'c')).toEqual({
      model: { primary: 'a', operations: { 'generate-image': 'b', speak: 'c' } },
    });
  });
});

const api = () => createApiClient({ baseUrl: '', fetch: mockFetch(), token: () => 'kari' });

describe('testing a step that calls an operation', () => {
  it('runs the published version with a note before it, and shows the image as a preview card', async () => {
    URL.createObjectURL ??= () => 'blob:figur';
    URL.revokeObjectURL ??= () => undefined;
    render(<PublishedTest api={api()} model="figur__default" version={3} />);
    expect(screen.getByText(/så denne testen kjører den publiserte versjonen v3/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Spørsmål eller tekst'), {
      target: { value: 'Lag en figur av saksgangen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør test mot v3' }));
    const card = await screen.findByRole('img', { name: 'Bilde fra steget figur' });
    expect(card.getAttribute('src')).toMatch(/^blob:/);
    expect(screen.getByText(/image\/png · 70 byte · fra steget figur/)).toBeTruthy();
  });

  it('says to publish first when the service has no published version', () => {
    render(<PublishedTest api={api()} model="figur__default" version={undefined} />);
    expect(screen.getByText(/Publiser tjenesten for å teste dem\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Kjør test/ })).toBeNull();
  });
});

describe('media in the run log', () => {
  it('a media block in the run log shows a preview card fetched from the run', async () => {
    URL.createObjectURL ??= () => 'blob:figur';
    const asked: string[] = [];
    render(
      <Steps
        steps={[
          {
            id: 'e1',
            type: 'step',
            title: 'Lag figuren',
            summary: '',
            at: 0,
            blocks: [
              {
                kind: 'list',
                label: 'Media',
                items: [['image/png', '70 byte']],
                media: [{ id: 'm1', mediaType: 'image/png', bytes: examplePng.byteLength }],
              },
            ],
          },
        ]}
        isOpen={() => true}
        onToggle={() => undefined}
        media={{
          task: 'opg-1',
          load: async (url) => {
            asked.push(url);
            return new Blob([examplePng], { type: 'image/png' });
          },
        }}
      />,
    );
    const figure = await screen.findByRole('img', { name: 'Bilde fra svaret' });
    expect(figure).toBeTruthy();
    expect(asked).toEqual(['/v1/tasks/opg-1/media/m1']);
  });

  it('a preview that cannot be fetched says so instead of breaking the page', async () => {
    render(
      <Attachments
        items={[{ id: 'm1', mediaType: 'image/png', bytes: 70, url: '/v1/tasks/x/media/m1' }]}
        load={() => Promise.reject(new Error('404'))}
      />,
    );
    const group = screen.getByRole('region', { name: 'Vedlegg' });
    expect(await within(group).findByRole('alert')).toBeTruthy();
  });
});
