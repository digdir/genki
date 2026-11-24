// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BlockData } from '@genai/contracts/block-fields';
import type { BlockTemplate, TemplateNode } from '@genai/contracts/block-template';
import type { BlockState, BlockTexts } from '@genai/contracts/blocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Render } from './Render.js';

afterEach(cleanup);

const texts: BlockTexts = {
  nb: {
    label: 'Spørsmålet ditt:',
    open: 'Åpne',
    again: 'Spør igjen',
    'n.one': '{count} kilde',
    'n.other': '{count} kilder',
    title: 'Tittel',
    empty: 'Ingen kilder',
    done: 'Lagret',
    more: 'Mer',
    les: 'Les mer',
  },
  en: { label: 'Your question:', 'n.one': '{count} source', 'n.other': '{count} sources' },
};

const data: BlockData = {
  question: { text: 'Hva er klarspråk?' },
  sources: [
    { index: 1, title: 'Klarspråk i staten', url: 'https://www.digdir.no/klarsprak' },
    { index: 2, title: 'Språkrådet', url: 'javascript:alert(1)' },
    { index: 3, title: 'Veileder', url: '/om' },
  ],
};

const draw = (
  root: TemplateNode,
  options: {
    data?: BlockData;
    state?: BlockState;
    locale?: 'nb' | 'en';
    states?: BlockTemplate['states'];
  } = {},
) => {
  const onEvent = vi.fn();
  const template: BlockTemplate = {
    version: 1,
    root,
    ...(options.states ? { states: options.states } : {}),
  };
  const view = render(
    <Render
      template={template}
      data={options.data ?? data}
      texts={texts}
      locale={options.locale ?? 'nb'}
      state={options.state ?? 'filled'}
      onEvent={onEvent}
    />,
  );
  return { ...view, onEvent };
};

describe('a declarative block', () => {
  it('draws each element with its Designsystemet component', () => {
    const { container } = draw({
      type: 'card',
      children: [
        { type: 'heading', level: 3, text: { t: 'title' } },
        { type: 'paragraph', text: { bind: 'question.text' } },
        { type: 'tag', color: 'info', text: { t: 'more' } },
        { type: 'alert', color: 'warning', text: { t: 'more' } },
        { type: 'divider' },
        { type: 'details', summary: { t: 'more' }, children: [] },
        { type: 'button', text: { t: 'again' }, event: { name: 'notify', text: { t: 'done' } } },
        {
          type: 'table',
          rows: 'sources',
          as: 'source',
          columns: [
            { header: { t: 'title' }, cell: { type: 'paragraph', text: { bind: 'source.title' } } },
          ],
        },
        { type: 'keyValue', items: [{ key: { t: 'label' }, value: { bind: 'question.text' } }] },
      ],
    });

    expect(container.querySelector('.ds-card')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Tittel' }).className).toContain(
      'ds-heading',
    );
    expect(screen.getAllByText('Hva er klarspråk?')[0]?.className).toContain('ds-paragraph');
    expect(container.querySelector('.ds-tag')?.getAttribute('data-color')).toBe('info');
    expect(container.querySelector('.ds-alert')?.getAttribute('data-color')).toBe('warning');
    expect(container.querySelector('hr.ds-divider')).not.toBeNull();
    expect(container.querySelector('.ds-details')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Spør igjen' }).className).toContain('ds-button');
    expect(screen.getByRole('table').className).toContain('ds-table');
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByRole('term').textContent).toBe('Spørsmålet ditt:');
  });

  it('writes data as text, never as HTML', () => {
    const { container } = draw(
      { type: 'paragraph', text: { bind: 'question.text' } },
      { data: { question: { text: '<img src=x onerror=alert(1)><script>alert(2)</script>' } } },
    );

    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)><script>alert(2)</script>')).toBeTruthy();
  });

  it('writes a text that looks like markup as text, never as HTML', () => {
    const { container } = render(
      <Render
        template={{ version: 1, root: { type: 'paragraph', text: { t: 'x' } } }}
        data={{}}
        texts={{ nb: { x: '<b onclick="alert(1)">fet</b>' } }}
        locale="nb"
        state="filled"
        onEvent={() => undefined}
      />,
    );

    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<b onclick="alert(1)">fet</b>')).toBeTruthy();
  });

  it('draws at most the max items of an each', () => {
    const many: BlockData = {
      sources: Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Kilde ${i + 1}` })),
    };
    const each = (max?: number): TemplateNode => ({
      type: 'list',
      items: [
        {
          type: 'each',
          of: 'sources',
          as: 'source',
          ...(max ? { max } : {}),
          children: [{ type: 'paragraph', text: { bind: 'source.title' } }],
        },
      ],
    });

    draw(each(3), { data: many });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    cleanup();
    draw(each(), { data: many });
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    cleanup();
    draw(each(500), { data: many });
    expect(screen.getAllByRole('listitem')).toHaveLength(30);
  });

  it('draws nothing of a template whose lists would repeat it past 2000 elements', () => {
    const many: BlockData = {
      sources: Array.from({ length: 50 }, (_, i) => ({ index: i + 1, title: `Kilde ${i + 1}` })),
    };
    const nested = (inner: number): TemplateNode => ({
      type: 'each',
      of: 'sources',
      as: 'a',
      max: 50,
      children: [
        {
          type: 'each',
          of: 'sources',
          as: 'b',
          max: 50,
          children: Array.from({ length: inner }, () => ({ type: 'divider' as const })),
        },
      ],
    });

    const { container } = draw(nested(10), { data: many });
    expect(container.querySelectorAll('hr')).toHaveLength(0);
    cleanup();
    const small = draw({ ...nested(1), max: 1 }, { data: many });
    expect(small.container.querySelectorAll('hr')).toHaveLength(50);
  });

  it('sends no open-page event for a page name the language does not allow', () => {
    const page = (name: string) => {
      const { onEvent } = draw({
        type: 'button',
        text: { t: 'more' },
        event: { name: 'open-page', page: name },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Mer' }));
      cleanup();
      return onEvent;
    };

    expect(page('//evil.example')).not.toHaveBeenCalled();
    expect(page('om-tjenesten')).toHaveBeenCalledWith({ name: 'open-page', page: 'om-tjenesten' });
  });

  it('sends the question of an ask button when the person clicks it', () => {
    const { onEvent } = draw({
      type: 'button',
      text: { t: 'again' },
      event: { name: 'ask', question: { bind: 'question.text' } },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Spør igjen' }));

    expect(onEvent).toHaveBeenCalledWith({ name: 'ask', question: 'Hva er klarspråk?' });
  });

  it('opens the document of the clicked source', () => {
    const { onEvent } = draw({
      type: 'each',
      of: 'sources',
      as: 'source',
      children: [
        {
          type: 'button',
          text: [{ t: 'open' }, ' ', { bind: 'source.title' }],
          event: { name: 'open-document', source: 'source.index' },
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Åpne Språkrådet' }));

    expect(onEvent).toHaveBeenCalledWith({ name: 'open-document', index: 2 });
  });

  it("draws the state's own template when there is one", () => {
    const root: TemplateNode = { type: 'paragraph', text: { bind: 'question.text' } };
    const states = { empty: { type: 'paragraph', text: { t: 'empty' } } } as const;

    draw(root, { state: 'empty', states });
    expect(screen.getByText('Ingen kilder')).toBeTruthy();
    cleanup();
    draw(root, { state: 'filled', states });
    expect(screen.getByText('Hva er klarspråk?')).toBeTruthy();
  });

  it('draws one branch of an if, by data or by state', () => {
    const node: TemplateNode = {
      type: 'if',
      when: { not: { state: 'loading' } },
      then: [{ type: 'paragraph', text: { t: 'more' } }],
      else: [{ type: 'paragraph', text: { t: 'empty' } }],
    };

    draw(node, { state: 'loading' });
    expect(screen.getByText('Ingen kilder')).toBeTruthy();
    cleanup();
    draw({ ...node, when: { empty: 'sources' } }, { data: {} });
    expect(screen.getByText('Mer')).toBeTruthy();
  });

  it('picks the plural text for a count', () => {
    const node: TemplateNode = {
      type: 'paragraph',
      text: { t: 'n', args: { count: { count: 'sources' } } },
    };

    draw(node);
    expect(screen.getByText('3 kilder')).toBeTruthy();
    cleanup();
    draw(node, { data: { sources: [{ title: 'En' }] } });
    expect(screen.getByText('1 kilde')).toBeTruthy();
    cleanup();
    draw(node, { locale: 'en' });
    expect(screen.getByText('3 sources')).toBeTruthy();
  });

  it('draws no link whose address is not https or a page of the service, also at render time', () => {
    draw({
      type: 'stack',
      children: [
        {
          type: 'each',
          of: 'sources',
          as: 'source',
          children: [
            { type: 'link', href: { bind: 'source.url' }, text: { bind: 'source.title' } },
          ],
        },
        { type: 'link', href: 'javascript:alert(1)', text: { t: 'les' } },
        { type: 'link', href: { page: 'om' }, text: { t: 'more' } },
      ],
    });

    const external = screen.getByRole('link', { name: 'Klarspråk i staten' });
    expect(external.getAttribute('href')).toBe('https://www.digdir.no/klarsprak');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Veileder' }).getAttribute('href')).toBe('/om');
    expect(screen.getByRole('link', { name: 'Mer' }).getAttribute('href')).toBe('/om');
    expect(screen.queryByRole('link', { name: 'Språkrådet' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Les mer' })).toBeNull();
    expect(screen.getByText('Språkrådet')).toBeTruthy();
  });

  it('draws a decorative icon hidden from screen readers', () => {
    const { container } = draw({
      type: 'row',
      children: [
        { type: 'icon', name: 'file-text' },
        { type: 'icon', name: 'star', label: { t: 'more' } },
      ],
    });

    const icons = container.querySelectorAll('svg');
    expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('img', { name: 'Mer' })).toBe(icons[1]);
  });

  it('reads no inherited property of the data', () => {
    draw({ type: 'paragraph', text: [{ bind: 'question.constructor' }, '·'] });

    expect(screen.getByText('·')).toBeTruthy();
    expect(within(document.body).queryByText(/function/)).toBeNull();
  });
});
