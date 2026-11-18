# Dokumentasjonssiden

Nettsiden på <https://digdir.github.io/genki/>: byggeklossene, flytene og målbildet for Genki, forklart på norsk for ledere, tjenesteeiere og arkitekter. Utviklerdokumentasjonen ligger i [docs/](../../docs/) og i [README](../../README.md).

Bygd med [Designsystemet](https://www.designsystemet.no) og [Motion](https://motion.dev) for animasjoner. Siden er statisk: ingen API, ingen innlogging.

## Kjør lokalt

Fra repoets rot, etter `npm install`:

```sh
npm run dev --workspace apps/docs
```

Åpne <http://localhost:5180/genki/>. Stien `/genki/` er den samme som på GitHub Pages.

`npm run build --workspace apps/docs` lager en statisk versjon i `apps/docs/dist/`. Arbeidsflyten [pages.yml](../../.github/workflows/pages.yml) bygger og publiserer den ved hver endring på `main`.

## Innhold

| Side                  | Hva                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oversikt              | Målarkitekturen der hvert lag åpner byggeklossen direkte                                                                                                                             |
| Målbilde              | Produktbladet på én side (`#/malbilde`): hvem som bruker Genki, byggeklossene, grunnlaget, veien fra idé til tjeneste, gevinster og samlet effekt. Innholdet ligger i `malbilde.ts`  |
| Byggeklosser          | Katalog over de tolv overordnede byggeklossene (lagene i figuren) i to grupper: nye og gjenbrukte                                                                                    |
| Overordnet byggekloss | Beskrivelse, kapabiliteter, pakker, ADR-er og byggeklossene under (`components.ts`)                                                                                                  |
| Byggekloss            | Egenskaper, typiske valg og anbefalt praksis for én byggekloss                                                                                                                       |
| Typer KI-tjenester    | Assistenter, chatboter, apper og agenter: hva de er, når de passer, hvordan de bygges (`service-types.ts`)                                                                           |
| Flyt                  | Caser: KI-tjenester vist steg for steg gjennom byggeklossene, i to deler: bruk av tjenesten og oppsett i Genki. Nye caser legges til i `cases` i `blocks.ts`                         |
| Kom i gang            | Hvordan kjøre Genki lokalt og kalle API-et                                                                                                                                           |
| Søk                   | Lokalt søk over alt innholdet (MiniSearch, indeks bygd fra datafilene i [packages/docs-site](../../packages/docs-site/src/search/index.ts)). Dialog fra headeren eller Ctrl+K        |
| Merkelapper           | Samleside (`#/status`) per status: bygd, delvis bygd, planlagt                                                                                                                       |
| Fullskjerm            | Alle figurer har en utvid-knapp som viser figuren i fullskjerm med alle lenker intakte. Piltastene flytter markeringen, Enter åpner (`packages/docs-site/src/components/Figure.tsx`) |

Innholdet er skrevet fra README og ADR-ene i dette repoet og ligger i [packages/docs-content](../../packages/docs-content/src/), og sidene, figurene og søket ligger i [packages/docs-site](../../packages/docs-site/src/). Portalen viser de samme sidene på sine offentlige sider under `#/about`. Når en ADR eller README endrer noe siden beskriver, oppdater datafilen i samme pull request.
