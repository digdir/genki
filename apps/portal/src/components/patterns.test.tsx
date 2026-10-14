// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiCallLink, type ApiCallPreview } from './ApiCall';
import { ChangeLogged, changedWhen } from './ChangeLogged';
import { DataLocationTag } from './DataLocationTag';
import { PlaygroundPanel } from './playground/PlaygroundPanel';
import { ReasonField } from './ReasonField';
import { StepList } from './StepList';

document.getAnimations ??= () => [];

afterEach(cleanup);

const call: ApiCallPreview = {
  action: 'Ta i bruk byggekloss',
  method: 'POST',
  path: '/tenants/999888777/building-blocks/hybridsok/adopt',
  body: { reason: 'Trenger bedre søk' },
  right: 'Administrere tjenester',
};

const curlLines = (curl: string) => curl.split(' \\\n');

const setWidth = (px: number) => {
  window.innerWidth = px;
  window.dispatchEvent(new Event('resize'));
};

describe('ApiCall', () => {
  afterEach(() => setWidth(1024));

  it('opens a 480 px side panel with method, path and curl', () => {
    render(<ApiCallLink call={call} />);

    expect(screen.getByRole('button', { name: 'Vis API-kall' }).getAttribute('aria-haspopup')).toBe(
      'dialog',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));

    const panel = screen.getByRole('dialog', { name: 'Ta i bruk byggekloss' });
    expect(within(panel).getByRole('button', { name: 'Kopier forespørselen' })).toBeTruthy();
    expect(within(panel).getByLabelText('Forespørsel').textContent).toContain(call.path);
    expect(panel.style.width).toBe('min(480px, 100vw)');
    expect(within(panel).getByText('POST')).toBeTruthy();
    expect(within(panel).getByText(call.path)).toBeTruthy();
    expect(within(panel).queryByText('Ikke bestemt')).toBeNull();
    expect(within(panel).getByRole('link', { name: /API-referansen/ })).toBeTruthy();
  });

  it('names the action, says the token is hidden once and sends a change reason with writes', () => {
    render(<ApiCallLink call={call} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));

    const panel = screen.getByRole('dialog', { name: 'Ta i bruk byggekloss' });
    expect(within(panel).getByText('API-kall for «Ta i bruk byggekloss»')).toBeTruthy();
    expect(within(panel).getAllByText(/Tokenet/)).toHaveLength(1);
    expect(within(panel).getAllByText(/Bytt ut \$TOKEN/)).toHaveLength(1);
    expect(within(panel).getByLabelText('Forespørsel').textContent).toContain(
      "-H 'change-reason: <begrunnelse>'",
    );
  });

  it('puts the given reason percent-encoded and the version to match into the request', () => {
    render(
      <ApiCallLink
        call={{
          ...call,
          method: 'PUT',
          headers: { 'change-reason': 'Bedre søk', 'if-match': '4' },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));

    const curl = screen.getByLabelText('Forespørsel').textContent ?? '';
    expect(curl).toContain("-H 'change-reason: Bedre%20s%C3%B8k'");
    expect(curl).toContain("-H 'if-match: 4'");
    expect(curlLines(curl).at(-1)).toMatch(/^ {2}-d /);
  });

  it('leaves out the change reason for a write that does not take one', () => {
    render(<ApiCallLink call={{ ...call, needsReason: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));

    expect(screen.getByLabelText('Forespørsel').textContent).not.toContain('change-reason');
    expect(screen.queryByText(/Bytt ut <begrunnelse>/)).toBeNull();
  });

  it('has a 520 px variant and takes the full width on narrow screens', () => {
    const { unmount } = render(<ApiCallLink call={call} width={520} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
    expect(screen.getByRole('dialog').style.width).toBe('min(520px, 100vw)');
    unmount();

    setWidth(600);
    render(<ApiCallLink call={call} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
    const panel = screen.getByRole('dialog');
    expect(panel.style.width).toBe('100%');
    expect(panel.getAttribute('aria-modal')).toBe('true');
  });

  it('marks a proposed call as not decided', () => {
    render(<ApiCallLink call={{ ...call, notDecided: { what: 'byggeklosser' } }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));

    const panel = screen.getByRole('dialog');
    const tag = within(panel).getByText('Ikke bestemt');
    expect(tag.getAttribute('data-color')).toBe('warning');
    expect(tag.parentElement?.textContent).toBe(
      'Ikke bestemt Det finnes ikke et API for byggeklosser ennå. Kallet er et forslag i samme mønster som resten av API-et.',
    );
    expect(within(panel).queryByRole('link', { name: /API-referansen/ })).toBeNull();
  });

  it('takes its own closing sentence for a not decided call', () => {
    render(
      <ApiCallLink
        call={{
          ...call,
          notDecided: {
            what: 'ferdigheter',
            note: 'Kallet er et forslag i samme mønster som katalogen og tjenestene.',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));

    expect(
      screen.getByText(
        /Det finnes ikke et API for ferdigheter ennå\. Kallet er et forslag i samme mønster som katalogen og tjenestene\./,
      ),
    ).toBeTruthy();
  });
});

const Reason = ({ minLength, showError }: { minLength?: number; showError: boolean }) => {
  const [value, setValue] = useState('');
  return (
    <ReasonField
      value={value}
      onChange={setValue}
      showError={showError}
      {...(minLength ? { minLength } : {})}
    />
  );
};

describe('ReasonField', () => {
  it('asks for at least 10 characters and marks the field invalid', () => {
    const { container } = render(<Reason showError />);
    const field = screen.getByLabelText('Begrunnelse');

    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('.ds-validation-message')?.textContent).toBe(
      'Skriv en begrunnelse på minst 10 tegn.',
    );

    fireEvent.change(field, { target: { value: 'Ny kilde fra Kudos' } });
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(container.querySelector('.ds-validation-message')).toBeNull();
  });

  it('takes another minimum length', () => {
    render(<Reason minLength={20} showError />);
    const field = screen.getByLabelText('Begrunnelse');
    fireEvent.change(field, { target: { value: 'Ny kilde fra Kudos' } });

    expect(screen.getByText('Skriv en begrunnelse på minst 20 tegn.')).toBeTruthy();
  });

  it('shows no error before it is asked to', () => {
    render(<Reason showError={false} />);

    expect(screen.getByLabelText('Begrunnelse').getAttribute('aria-invalid')).toBeNull();
  });
});

describe('DataLocationTag', () => {
  it.each([
    ['norway', 'Data i Norge', 'neutral'],
    ['eu', 'Data i EU/EØS', 'neutral'],
    ['global', 'Data utenfor EU/EØS', 'warning'],
  ] as const)('shows %s as text, with a warning outside EU/EØS', (location, text, color) => {
    render(<DataLocationTag location={location} />);

    expect(screen.getByText(text).getAttribute('data-color')).toBe(color);
  });
});

describe('ChangeLogged', () => {
  it('says who changed it, when and why, and that it is logged', () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T12:30:00Z'), toFake: ['Date'] });
    try {
      render(
        <ChangeLogged by="Kari Nordmann" at="2026-10-07T12:05:00Z" reason=" Strammere kildekrav ">
          Byggeklossen er tatt i bruk.
        </ChangeLogged>,
      );

      const alert = screen.getByRole('status');
      expect(alert.getAttribute('data-color')).toBe('success');
      expect(alert.textContent).toBe(
        'Byggeklossen er tatt i bruk. Endret av Kari Nordmann i dag kl. 14.05: «Strammere kildekrav». Logget.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the date when the change was not made today', () => {
    expect(changedWhen(new Date('2026-10-03T07:09:00Z'), new Date('2026-10-07T12:00:00Z'))).toBe(
      '3. oktober 2026 kl. 09.09',
    );
  });
});

describe('StepList', () => {
  it('marks the current step with aria-current=step', () => {
    render(<StepList steps={['Velg', 'Overfør', 'Ta i bruk']} current={2} />);

    const list = screen.getByRole('list', { name: 'Steg' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(items[0]?.textContent).toBe('Velg (fullført)');
    expect(items[1]?.textContent).toBe('2Overfør');
  });
});

describe('PlaygroundPanel', () => {
  it('opens as a dialog named Prøv and closes with Lukk once the setup has loaded', async () => {
    const onClose = vi.fn();
    render(<PlaygroundPanel layout="side" context="dataset" name="Kudos" onClose={onClose} />);

    const panel = screen.getByRole('dialog', { name: 'Prøv' });
    expect(panel.getAttribute('data-layout')).toBe('side');
    await within(panel).findByRole('button', { name: 'Sammenlign' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Lukk' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
