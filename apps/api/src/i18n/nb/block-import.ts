import { defineNamespace } from '@genai/i18n';

export const blockImport = defineNamespace({
  bodyTooLarge: 'Forespørselen er større enn {limit}',
  tooLarge: 'Designet er større enn 512 KiB',
  empty: 'Designet har ikke noe innhold',
  tooMuchText:
    'Designet har for mye tekst: høyst 200 tekster på høyst 1000 tegn hver. Del opp de lange tekstene.',
  codeScript:
    'Designet har skript, og det trenger et designelement med kode. Det kan ikke importeres ennå.',
  codeAnimation:
    'Designet har animasjoner, og det trenger et designelement med kode. Det kan ikke importeres ennå.',
  codeElement:
    'Designet har elementet <{element}>, og det trenger et designelement med kode. Det kan ikke importeres ennå.',
  codeLimits:
    'Designet har {nodes} elementer og er {depth} nivåer dypt, og det trenger et designelement med kode. Det kan ikke importeres ennå.',
  codeInvalid:
    'Malen ble ikke gyldig ved {path}, og designet trenger et designelement med kode. Det kan ikke importeres ennå.',
  mustBeText: 'må være tekst',
  mustBeSlug: 'må være små bokstaver, tall og bindestreker',
  invalid: 'Designet ble ikke et gyldig designelement',
  convertedDeclarative: 'Laget som designelement uten kode',
  droppedScript: 'Fjernet skript som lastes fra andre steder',
  droppedStylesheet: 'Fjernet stilark og skrifter som lastes fra andre steder',
  droppedHandler: 'Fjernet hendelseskode i attributter som onclick',
  droppedLink: 'Fjernet lenker som ikke er https',
  droppedBase: 'Fjernet base-adressen',
  droppedStyle: 'Fjernet stiler; designelementet bruker Designsystemet',
  droppedElement: 'Fjernet elementet <{element}>',
  colours: 'Fargene følger temaet',
  englishLeftOut: 'Tekstene er bare på bokmål; legg til engelsk i Utforming',
  buttonWithoutEvent: 'En knapp uten data-genki-event ble tekst',
  linkAsText: 'En lenke inne i teksten ble tekst',
  bindOutsideFields: '{path} er ikke et felt designelementet kan lese, så det står som tekst',
  eachOutsideFields: '{path} er ikke en liste designelementet kan gjenta',
});
