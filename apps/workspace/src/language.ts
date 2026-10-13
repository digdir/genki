import type { Lang } from './types';

const markers: [Lang, Set<string>][] = [
  [
    'nn',
    new Set(
      'ikkje eg ein eit kva korleis kvifor kven frå berre vere vore desse dei noko nokre mykje kvar heile fekk gjer òg sjølv utan høyrer då medan difor meir hjå seier gjekk tenesta tenester verksemda verksemder kommunane rapportane'.split(
        ' ',
      ),
    ),
  ],
  [
    'nb',
    new Set(
      'ikke jeg en et hva hvordan hvorfor hvem fra bare være vært disse de noe noen mye hver hele fikk gjør også selv uten hører da mens derfor mer hos sier gikk tjenesten tjenester virksomheten virksomheter kommunene rapportene'.split(
        ' ',
      ),
    ),
  ],
  [
    'en',
    new Set(
      'the and is are what how why who with this that from only these they some much every also without when while therefore more their which were was have has does'.split(
        ' ',
      ),
    ),
  ],
];

export const detectLang = (text: string): Lang => {
  const words = text.toLowerCase().match(/[a-zæøåòé]+/g) ?? [];
  const [nn, nb, en] = markers.map(([, set]) => words.filter((w) => set.has(w)).length) as [
    number,
    number,
    number,
  ];
  if (en > nn && en > nb) return 'en';
  return nn > nb ? 'nn' : 'nb';
};
