import { act } from '@testing-library/react';

/** Where an area of Oppsett lives: the form itself, a part of Avansert, or the publish page. */
const homes: [RegExp, string | undefined][] = [
  [/^(Formål og målgruppe|Kunnskap|Inndata|Resultat|Modell)$/, undefined],
  [/^Arbeidsmåte$/, '/advanced/how'],
  [/^Verktøy$/, '/advanced/tools'],
  [/^Varianter$/, '/advanced/variants'],
  [/^Begrensninger og loggføring$/, '/advanced/limits'],
  [/^Kanaler$/, '/advanced/channels'],
  [/^(Risiko og KI-forordningen|Sikkerhetsregler)$/, '/setup/publish'],
];

const areaNames = [
  'Formål og målgruppe',
  'Kunnskap',
  'Inndata',
  'Resultat',
  'Modell',
  'Arbeidsmåte',
  'Verktøy',
  'Varianter',
  'Begrensninger og loggføring',
  'Kanaler',
  'Risiko og KI-forordningen',
  'Sikkerhetsregler',
];

/**
 * Opens an area the way a person reaches it now: the basic areas are on the Oppsett form, and the
 * rest are a part of Avansert or on the publish page.
 */
export const openArea = (name: RegExp) => {
  const area = areaNames.find((n) => name.test(n));
  if (!area) throw new Error(`No area matches ${String(name)}`);
  const home = homes.find(([pattern]) => pattern.test(area))?.[1];
  const service = /^#\/services\/([^/?]+)/.exec(window.location.hash)?.[1];
  if (!service) throw new Error('Not on a service page');
  const target = `#/services/${service}${home ?? '/setup'}`;
  if (window.location.hash === target) return;
  act(() => {
    window.location.hash = target;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};
