import {
  Button,
  Chip,
  Field,
  Fieldset,
  Heading,
  Label,
  Link,
  Select,
  Spinner,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import {
  API_BASE,
  answerSources,
  callErrors,
  codeInput,
  codeResult,
  codeServices,
  type CodeServiceType,
} from '../../data/integrations';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import type { AccessView, ServiceSummaryView } from '../../types';

type Channel = 'api' | 'openai' | 'mcp';
type Lang = 'curl' | 'python' | 'js' | 'cs';

const J = (o: unknown) => JSON.stringify(o, null, 2);

export const codeFor = (lang: Lang, url: string, body: unknown) => {
  const b = J(body);
  if (lang === 'curl')
    return `curl -X POST "${url}" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${b}'`;
  if (lang === 'python')
    return `import os, requests\n\nsvar = requests.post(\n    "${url}",\n    headers={"Authorization": f"Bearer {os.environ['TOKEN']}"},\n    json=${b
      .replace(/true/g, 'True')
      .replace(/false/g, 'False')
      .replace(/null/g, 'None')
      .split('\n')
      .join('\n    ')},\n    timeout=60,\n)\nsvar.raise_for_status()\nprint(svar.json())`;
  if (lang === 'js')
    return `const svar = await fetch("${url}", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.TOKEN}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify(${b
      .split('\n')
      .join(
        '\n  ',
      )}),\n});\nif (!svar.ok) throw new Error(\`Feil \${svar.status}\`);\nconsole.log(await svar.json());`;
  return `using System.Net.Http.Headers;\nusing System.Text;\n\nvar klient = new HttpClient();\nklient.DefaultRequestHeaders.Authorization =\n    new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("TOKEN"));\n\nvar innhold = new StringContent("""\n${b}\n""", Encoding.UTF8, "application/json");\n\nvar svar = await klient.PostAsync("${url}", innhold);\nsvar.EnsureSuccessStatusCode();\nConsole.WriteLine(await svar.Content.ReadAsStringAsync());`;
};

const back = 'M15 6l-6 6 6 6';

export interface CodeService {
  id: string;
  name: string;
  type: CodeServiceType;
}

const typeOf = (outputKind: string | undefined): CodeServiceType =>
  outputKind === 'fields' ? 'felter' : outputKind === 'document' ? 'dokument' : 'svar';

export const liveCodeServices = (
  access: AccessView['services'],
  services: ServiceSummaryView[],
): CodeService[] => {
  const byId = new Map(services.map((s) => [s.id, s]));
  return access
    .filter((a) => byId.get(a.id)?.lifecycle !== 'archived')
    .map((a) => ({
      id: a.publicName,
      name: byId.get(a.id)?.name ?? a.name,
      type: typeOf(byId.get(a.id)?.outputKind),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'nb'));
};

const BackLink = () => {
  const t = useT();
  return (
    <Link href="#/integrations" className="int-back">
      <Icon d={back} size={18} />
      {t('integrations.heading')}
    </Link>
  );
};

export const LiveCallFromCode = ({
  api,
  tenant,
  tenantName,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
}) => {
  const t = useT();
  const [state, retry] = useAsync(
    async (signal) => {
      const [access, services] = await Promise.all([
        api.access(tenant, signal),
        api.services(tenant, signal),
      ]);
      return liveCodeServices(access.services, services.data);
    },
    [api, tenant],
  );
  if (state.status === 'loading') return <Loading label={t('integCode.loadingServices')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  if (!state.data.length)
    return (
      <div className="stack int">
        <BackLink />
        <Heading level={1} data-size="md">
          {t('integrations.callFromCode')}
        </Heading>
        <div className="state empty">
          <Heading level={2} data-size="2xs">
            {t('integCode.noServices')}
          </Heading>
          <p>{t('integCode.noServicesText')}</p>
        </div>
      </div>
    );
  return <CallFromCode tenantName={tenantName} services={state.data} live />;
};

export const CallFromCode = ({
  tenantName,
  services = codeServices,
  live = false,
}: {
  tenantName: string;
  services?: CodeService[];
  live?: boolean;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [svcId, setSvcId] = useState(services[0]?.id ?? '');
  const [ch, setCh] = useState<Channel>('api');
  const [lang, setLang] = useState<Lang>('curl');
  const [trying, setTrying] = useState(false);
  const [tryMsg, setTryMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const svc = services.find((s) => s.id === svcId) ?? services[0];
  if (!svc) return null;
  const question = t('integCode.liveQuestion');
  const answer = t('integCode.liveAnswer');
  const inp = live ? { query: question } : codeInput[svc.type];
  const resO = live ? { answer, status: 'ok', ai_generated: true } : codeResult[svc.type];
  let req: string;
  let res: string;
  let reqLabel: string;
  let resLabel = 'application/json';
  let step2: string;
  let step2Title = t('integCode.callService');
  let step3: string;
  if (ch === 'api') {
    const path = `/api/tools/call/${svc.id}`;
    req = codeFor(lang, API_BASE + path, inp);
    reqLabel = `POST ${path}`;
    res = J(resO);
    step2 = live
      ? t('integCode.liveApiStep2')
      : t(svc.type === 'dokument' ? 'integCode.apiStep2Approval' : 'integCode.apiStep2Wait');
    step3 = live
      ? t('integCode.liveApiStep3')
      : t(
          svc.type === 'svar'
            ? 'integCode.apiStep3Answer'
            : svc.type === 'felter'
              ? 'integCode.apiStep3Fields'
              : 'integCode.apiStep3Document',
        );
  } else if (ch === 'openai') {
    req = codeFor(lang, `${API_BASE}/v1/chat/completions`, {
      model: svc.id,
      messages: [
        {
          role: 'user',
          content: live
            ? question
            : svc.type === 'svar'
              ? 'Hva sier evalueringer om digital veiledning siden 2020?'
              : 'Hent ut feltene fra søknaden.',
        },
      ],
    });
    reqLabel = 'POST /v1/chat/completions';
    res = live
      ? J({
          object: 'chat.completion',
          model: svc.id,
          choices: [
            { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
          ],
        })
      : J({
          id: 'chatcmpl-opg_7f2kq9d1',
          object: 'chat.completion',
          model: svc.id,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content:
                  svc.type === 'svar'
                    ? 'Evalueringene peker på tre ting: …'
                    : '{"sokers_navn":"Elvebakken Musikkorps", …}',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 4120, completion_tokens: 350, total_tokens: 4470 },
          kilder:
            svc.type === 'svar'
              ? answerSources.map((k) => ({ tittel: k.tittel, url: k.url }))
              : undefined,
        });
    step2 = t('integCode.openaiStep2');
    step3 = t(live ? 'integCode.liveOpenaiStep3' : 'integCode.openaiStep3');
  } else {
    req = J({
      mcpServers: {
        [live ? 'felleslosning-ki' : 'testetaten-ki']: {
          url: `${API_BASE}/api/mcp`,
          headers: { Authorization: 'Bearer ${TOKEN}' },
        },
      },
    });
    reqLabel = t('integCode.mcpSetup');
    res = live
      ? J({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: answer }] } })
      : J({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text:
                  svc.type === 'svar' ? 'Evalueringene peker på tre ting: …' : 'Felter hentet ut.',
              },
            ],
            structuredContent: (resO as { resultat?: unknown }).resultat,
          },
        });
    resLabel = t('integCode.mcpResponseLabel');
    step2Title = t('integCode.mcpStep2Title');
    step2 = t('integCode.mcpStep2', { tenant: tenantName, id: svc.id });
    step3 = t(live ? 'integCode.liveMcpStep3' : 'integCode.mcpStep3');
  }
  const step1 = ch === 'mcp' ? t('integCode.step1Mcp') : t('integCode.step1');

  const tryIt = () => {
    if (trying) return;
    setTrying(true);
    setTryMsg(t('integCode.fetching'));
    timer.current = setTimeout(() => {
      setTrying(false);
      setTryMsg(tRef.current('integCode.exampleDone'));
    }, 1300);
  };

  return (
    <div className="stack int">
      <BackLink />
      <div className="stack-xs int-intro-text">
        <Heading level={1} data-size="md">
          {t('integrations.callFromCode')}
        </Heading>
        <p className="lead">{t(live ? 'integCode.liveLead' : 'integCode.lead')}</p>
      </div>
      <div className="int-code-choices">
        <Field className="int-field-select">
          <Label htmlFor="tjeneste">{t('integCode.service')}</Label>
          <Select
            id="tjeneste"
            value={svcId}
            onChange={(e) => {
              setSvcId(e.target.value);
              setTryMsg('');
            }}
          >
            {services.map((s) => (
              <Select.Option key={s.id} value={s.id}>
                {s.name} ({s.id})
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Fieldset>
          <Fieldset.Legend>{t('integCode.channel')}</Fieldset.Legend>
          <div className="tag-row">
            {(
              [
                ['api', 'API'],
                ['openai', t('integCode.openaiCompatible')],
                ['mcp', 'MCP'],
              ] as const
            ).map(([id, label]) => (
              <Chip.Radio
                key={id}
                name="kanal"
                checked={ch === id}
                onChange={() => {
                  setCh(id);
                  setTryMsg('');
                }}
              >
                {label}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
        {ch !== 'mcp' ? (
          <Fieldset>
            <Fieldset.Legend>{t('integCode.language')}</Fieldset.Legend>
            <div className="tag-row">
              {(
                [
                  ['curl', 'curl'],
                  ['python', 'Python'],
                  ['js', 'JavaScript'],
                  ['cs', 'C#'],
                ] as const
              ).map(([id, label]) => (
                <Chip.Radio
                  key={id}
                  name="sprak"
                  checked={lang === id}
                  onChange={() => setLang(id)}
                >
                  {label}
                </Chip.Radio>
              ))}
            </div>
          </Fieldset>
        ) : null}
      </div>
      <ol className="int-steps">
        <li>
          <span aria-hidden="true" className="int-step-no">
            1
          </span>
          <div className="stack-xs">
            <Heading level={2} data-size="xs">
              {t('integCode.getToken')}
            </Heading>
            <p className="int-step-text">{step1}</p>
            <div className="row-wrap small">
              <a href="https://docs.digdir.no/docs/Maskinporten/">{t('integCode.makeClient')}</a>
              <a href="https://docs.digdir.no/docs/idporten/">{t('integCode.ansattportenDocs')}</a>
            </div>
          </div>
        </li>
        <li>
          <span aria-hidden="true" className="int-step-no">
            2
          </span>
          <div className="stack-sm">
            <Heading level={2} data-size="xs">
              {step2Title}
            </Heading>
            <p className="int-step-text">{step2}</p>
            <div className="code-block">
              <div className="code-block-head">
                <span>{reqLabel}</span>
                <CopyButton text={req} />
              </div>
              <pre tabIndex={0} aria-label={reqLabel}>
                <code>{req}</code>
              </pre>
            </div>
            {ch !== 'mcp' && !live ? (
              <div className="actions">
                <Button variant="primary" aria-disabled={trying || undefined} onClick={tryIt}>
                  {t('integCode.showExample')}
                </Button>
                <span role="status" className="row-wrap">
                  {trying ? <Spinner aria-hidden data-size="xs" /> : null}
                  {tryMsg}
                </span>
              </div>
            ) : null}
          </div>
        </li>
        <li>
          <span aria-hidden="true" className="int-step-no">
            3
          </span>
          <div className="stack-sm">
            <Heading level={2} data-size="xs">
              {t('integCode.response')}
            </Heading>
            <p className="int-step-text">{step3}</p>
            <div className="code-block">
              <div className="code-block-head">
                <span className="row-wrap">
                  <Tag data-size="sm" data-color="success">
                    200 OK
                  </Tag>
                  {resLabel}
                </span>
                <CopyButton text={res} />
              </div>
              <pre tabIndex={0} aria-label={t('integCode.exampleResponse')}>
                <code>{res}</code>
              </pre>
            </div>
          </div>
        </li>
      </ol>
      <section aria-labelledby="feil-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="feil-h">
          {t('integCode.errorsHeading')}
        </Heading>
        <dl className="int-errors">
          {callErrors.map(([code, title, text]) => (
            <div key={code}>
              <dt>
                {code} {t(title)}
              </dt>
              <dd>{t(text)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
};
