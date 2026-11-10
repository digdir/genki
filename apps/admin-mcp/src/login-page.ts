import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export type LoginPageKind = 'signed-in' | 'cancelled' | 'unknown';
export type LoginPageLanguage = 'nb' | 'en';

interface PageText {
  title: string;
  body: string[];
}

const texts: Record<LoginPageLanguage, Record<LoginPageKind, PageText>> = {
  nb: {
    'signed-in': {
      title: 'Du er logget inn',
      body: [
        'Gå tilbake til kodeagenten. Den fortsetter der den slapp.',
        'Innloggingen gjelder bare genki-admin på denne maskinen, til den stopper. Du kan lukke denne fanen.',
      ],
    },
    cancelled: {
      title: 'Innloggingen ble ikke fullført',
      body: [
        'Gå tilbake til kodeagenten og be den prøve igjen. Den åpner en ny innlogging.',
        'Du kan lukke denne fanen.',
      ],
    },
    unknown: {
      title: 'Lenken hører ikke til en innlogging som pågår',
      body: [
        'Den kan være brukt allerede, eller innloggingen kan ha gått ut på tid.',
        'Gå tilbake til kodeagenten og be den prøve igjen.',
      ],
    },
  },
  en: {
    'signed-in': {
      title: 'You are signed in',
      body: [
        'Go back to your coding agent. It carries on where it left off.',
        'The sign-in applies only to genki-admin on this machine, until it stops. You can close this tab.',
      ],
    },
    cancelled: {
      title: 'The sign-in was not completed',
      body: [
        'Go back to your coding agent and ask it to try again. It opens a new sign-in.',
        'You can close this tab.',
      ],
    },
    unknown: {
      title: 'This link does not belong to a sign-in in progress',
      body: [
        'It may have been used already, or the sign-in may have timed out.',
        'Go back to your coding agent and ask it to try again.',
      ],
    },
  },
};

const shell: Record<LoginPageLanguage, { owner: string; brand: string; product: string }> = {
  nb: {
    owner: 'Digdir',
    brand: 'Fellesløsning for generativ KI',
    product: 'genki-admin for kodeagenter',
  },
  en: {
    owner: 'Digdir',
    brand: 'Generative AI platform',
    product: 'genki-admin for coding agents',
  },
};

const alertColor: Record<LoginPageKind, string> = {
  'signed-in': 'success',
  cancelled: 'danger',
  unknown: 'info',
};

const emblem =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 25.1 24.93" aria-hidden="true"><path fill="#0062B8" d="M12.67.1H.5A.5.5,0,0,0,0,.6V24.33a.5.5,0,0,0,.5.5H12.67A12.37,12.37,0,0,0,12.67.1m1.19,21A8.8,8.8,0,1,1,21,14a8.8,8.8,0,0,1-7.18,7.18"/></svg>';

const require = createRequire(import.meta.url);

const designsystemet = (() => {
  let css: string | undefined;
  return () => {
    if (css !== undefined) return css;
    try {
      css = [
        require.resolve('@digdir/designsystemet-css'),
        require.resolve('@digdir/designsystemet-theme/digdir.css'),
      ]
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
    } catch {
      css = '';
    }
    return css;
  };
})();

const pageCss = `
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--ds-color-neutral-background-tinted, #f4f5f6); color: var(--ds-color-neutral-text-default, #1e2b3c); font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { background: var(--ds-color-neutral-background-default, #fff); border-bottom: 1px solid var(--ds-color-neutral-border-subtle, #dfe3e8); }
.bar { max-width: 1200px; margin: 0 auto; min-height: 64px; padding: 0 16px; display: flex; align-items: center; gap: 10px; box-sizing: border-box; }
.brand-text { display: flex; flex-direction: column; line-height: 1.2; }
.brand-owner { font-size: 13px; color: var(--ds-color-neutral-text-subtle, #4f5d6d); }
.brand-name { font-size: 16px; font-weight: 600; }
main { flex: 1; display: flex; justify-content: center; align-items: flex-start; padding: 64px 16px; box-sizing: border-box; }
.panel { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: var(--ds-size-4, 16px); }
.product { color: var(--ds-color-neutral-text-subtle, #4f5d6d); }
.ds-alert .ds-heading { margin-bottom: var(--ds-size-2, 8px); }
.ds-alert .ds-paragraph + .ds-paragraph { margin-top: var(--ds-size-2, 8px); }
`;

export const loginPageHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline' https://altinncdn.no; font-src https://altinncdn.no; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export const languageOf = (acceptLanguage: string | undefined): LoginPageLanguage => {
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('en') ? 'en' : 'nb';
};

export const loginPage = (kind: LoginPageKind, language: LoginPageLanguage) => {
  const { title, body } = texts[language][kind];
  const { owner, brand, product } = shell[language];
  return `<!doctype html>
<html lang="${language}" data-color-scheme="auto" data-size="md">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${brand}</title>
<link rel="stylesheet" href="https://altinncdn.no/fonts/inter/v4.1/inter.css">
<style>${designsystemet()}${pageCss}</style>
</head>
<body>
<header>
<div class="bar">
${emblem}
<span class="brand-text"><span class="brand-owner">${owner}</span><span class="brand-name">${brand}</span></span>
</div>
</header>
<main>
<div class="panel">
<p class="ds-paragraph product" data-size="sm">${product}</p>
<div class="ds-alert" data-color="${alertColor[kind]}" role="${kind === 'signed-in' ? 'status' : 'alert'}">
<h1 class="ds-heading" data-size="xs">${title}</h1>
${body.map((line) => `<p class="ds-paragraph">${line}</p>`).join('\n')}
</div>
</div>
</main>
</body>
</html>`;
};
