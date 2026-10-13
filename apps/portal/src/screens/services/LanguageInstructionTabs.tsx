import {
  Button,
  Field,
  Label,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type { ServiceDefinition, SpecEdit } from '../../data/service-definition';
import {
  answerLanguages,
  houseStyleKey,
  houseStyleOf,
  instructionsByLanguageOf,
  languageInstructionsOf,
  languagesOf,
  perLanguageInstructions,
  sharedInstructionsOf,
  withHouseStyle,
  withInstructionsByLanguage,
  withLanguageInstruction,
  withSharedInstructions,
  type AnswerLanguage,
} from '../../data/service-languages';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';

type Tab = 'shared' | AnswerLanguage;

const tabKeys: Record<Tab, PlainKey> = {
  shared: 'languageTabs.tabShared',
  nb: 'languageTabs.tabNb',
  nn: 'languageTabs.tabNn',
  en: 'languageTabs.tabEn',
};

const sourceKeys: Record<string, PlainKey> = {
  tenant: 'languageTabs.fromTenant',
  service: 'languageTabs.fromService',
};

interface Inherited {
  text: string;
  source: string;
}

export interface LanguageInstructionTabsProps {
  api: ApiClient;
  tenant: string;
  definition: ServiceDefinition;
  patch: (edit: SpecEdit) => void;
  shared: ReactNode;
  readOnly?: boolean;
}

export const LanguageInstructionTabs = ({
  api,
  tenant,
  definition: d,
  patch,
  shared,
  readOnly = false,
}: LanguageInstructionTabsProps) => {
  const t = useT();
  const [tab, setTab] = useState<Tab>('shared');
  const [inherited] = useAsync(
    async (signal) => {
      const effective = await api.tenantEffectiveSettings(tenant, signal);
      return Object.fromEntries(
        answerLanguages.map((l) => {
          const found = effective[houseStyleKey(l)];
          return [
            l,
            {
              text: typeof found?.value === 'string' ? found.value : '',
              source: found?.source ?? 'default',
            },
          ];
        }),
      ) as Record<AnswerLanguage, Inherited>;
    },
    [api, tenant],
  );
  const languages = languagesOf(d.spec);
  const byLanguage = instructionsByLanguageOf(d.spec);
  const houseStyle = houseStyleOf(d.spec);
  const serviceTexts = languageInstructionsOf(d.spec);
  const answered = (l: AnswerLanguage) =>
    languages.includes(l) || (l === 'nn' && languages.includes('nb'));

  const perLanguage = perLanguageInstructions(d.spec);
  const writeSeparately = () =>
    patch((cur) =>
      withInstructionsByLanguage(
        cur.spec,
        Object.fromEntries(
          languagesOf(cur.spec).map((language) => [language, sharedInstructionsOf(cur.spec)]),
        ),
      ),
    );

  const fullPrompt = (l: AnswerLanguage) =>
    perLanguage ? (
      <Field>
        <Label htmlFor={`full-prompt-${l}`}>{t('languageTabs.fullPrompt')}</Label>
        <Field.Description>{t('languageTabs.fullPromptHelp')}</Field.Description>
        {answered(l) && !byLanguage[l] ? (
          <ValidationMessage>{t('languageTabs.fullPromptMissing')}</ValidationMessage>
        ) : null}
        <Textarea
          id={`full-prompt-${l}`}
          className="instructions-editor"
          rows={10}
          value={byLanguage[l] ?? ''}
          readOnly={readOnly}
          onChange={(e) => {
            const text = e.target.value;
            patch((cur) =>
              withInstructionsByLanguage(cur.spec, {
                ...instructionsByLanguageOf(cur.spec),
                [l]: text,
              }),
            );
          }}
        />
        {readOnly ? null : (
          <Button
            variant="tertiary"
            data-size="sm"
            className="align-start"
            onClick={() =>
              patch((cur) =>
                withSharedInstructions(cur.spec, instructionsByLanguageOf(cur.spec)[l] ?? ''),
              )
            }
          >
            {t('languageTabs.useShared')}
          </Button>
        )}
      </Field>
    ) : readOnly ? null : (
      <div className="stack-xs">
        <span className="meta">{t('languageTabs.fullPromptOffer')}</span>
        <Button
          variant="secondary"
          data-size="sm"
          className="align-start"
          onClick={writeSeparately}
        >
          {t('languageTabs.writeSeparately')}
        </Button>
      </div>
    );

  const panel = (l: AnswerLanguage) => {
    const own = houseStyle[l];
    const from = inherited.status === 'ready' ? inherited.data[l] : undefined;
    return (
      <div className="stack-sm" data-testid={`language-panel-${l}`}>
        {answered(l) ? null : (
          <p className="meta">
            {t('languageTabs.notAnswered', { first: t(tabKeys[languages[0] ?? 'nb']) })}
          </p>
        )}
        <div className="stack-xs">
          <span className="ds-label">{t('languageTabs.houseStyle')}</span>
          <span className="meta">{t('languageTabs.houseStyleHelp')}</span>
          {own === undefined ? (
            <>
              {inherited.status === 'loading' ? (
                <p className="meta">{t('languageTabs.loadingHouseStyle')}</p>
              ) : inherited.status === 'error' ? (
                <p className="meta">{t('languageTabs.houseStyleUnavailable')}</p>
              ) : from?.text ? (
                <>
                  <Tag data-size="sm" className="align-start">
                    {t(sourceKeys[from.source] ?? 'languageTabs.fromPlatform')}
                  </Tag>
                  <p className="body-md" data-testid={`house-style-${l}`}>
                    {from.text}
                  </p>
                </>
              ) : (
                <p className="meta">{t('languageTabs.noHouseStyle')}</p>
              )}
              {readOnly ? null : (
                <Button
                  variant="secondary"
                  data-size="sm"
                  className="align-start"
                  onClick={() => patch((cur) => withHouseStyle(cur.spec, l, from?.text ?? ''))}
                >
                  {t('languageTabs.override')}
                </Button>
              )}
            </>
          ) : (
            <Field>
              <Label htmlFor={`house-style-${l}-own`}>{t('languageTabs.overrideLabel')}</Label>
              <Textarea
                id={`house-style-${l}-own`}
                rows={4}
                value={own}
                readOnly={readOnly}
                onChange={(e) => {
                  const text = e.target.value;
                  patch((cur) => withHouseStyle(cur.spec, l, text));
                }}
              />
              {readOnly ? null : (
                <Button
                  variant="tertiary"
                  data-size="sm"
                  className="align-start"
                  onClick={() => patch((cur) => withHouseStyle(cur.spec, l, undefined))}
                >
                  {t('languageTabs.useInherited')}
                </Button>
              )}
            </Field>
          )}
        </div>
        {fullPrompt(l)}
        <Field>
          <Label htmlFor={`service-text-${l}`}>{t('languageTabs.serviceText')}</Label>
          <Field.Description>{t('languageTabs.serviceTextHelp')}</Field.Description>
          <Textarea
            id={`service-text-${l}`}
            rows={5}
            value={serviceTexts[l] ?? ''}
            readOnly={readOnly}
            onChange={(e) => {
              const text = e.target.value;
              patch((cur) => withLanguageInstruction(cur.spec, l, text === '' ? undefined : text));
            }}
          />
        </Field>
      </div>
    );
  };

  return (
    <Tabs value={tab} onChange={(v) => setTab(v as Tab)}>
      <TabsList aria-label={t('languageTabs.tabsLabel')}>
        {(['shared', ...answerLanguages] as Tab[]).map((id) => (
          <TabsTab key={id} value={id}>
            {t(tabKeys[id])}
          </TabsTab>
        ))}
      </TabsList>
      <TabsPanel value="shared">
        {perLanguage ? <p className="meta">{t('languageTabs.sharedUnused')}</p> : null}
        {shared}
      </TabsPanel>
      {answerLanguages.map((l) => (
        <TabsPanel key={l} value={l}>
          {panel(l)}
        </TabsPanel>
      ))}
    </Tabs>
  );
};
