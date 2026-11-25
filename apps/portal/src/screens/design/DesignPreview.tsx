import { ToggleGroup } from '@digdir/designsystemet-react';
import type { BlockData } from '@genai/contracts/block-fields';
import type { BlockState, RefBlockPayload } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { RefBlock } from '@genai/ui-assembly';
import '@genai/ui-assembly/styles.css';
import '@genai/ui-blocks/styles.css';
import { useState } from 'react';
import { useT, type PlainKey } from '../../i18n';

const stateKey: Record<BlockState, PlainKey> = {
  filled: 'design.stateFilled',
  empty: 'design.stateEmpty',
  loading: 'design.stateLoading',
  error: 'design.stateError',
  partial: 'design.statePartial',
  disabled: 'design.stateDisabled',
};

const stateOrder: readonly BlockState[] = ['filled', 'empty', 'loading', 'error', 'partial'];

/** The states a preview offers: «Med svar» first, then each the designelement declares. */
export const previewStates = (declared: readonly BlockState[]): BlockState[] =>
  stateOrder.filter((s) => s === 'filled' || declared.includes(s));

/** A designelement drawn with genki's made-up data, in each state it declares, light or dark, narrow or wide. */
export const DesignPreview = ({
  payload,
  fixtures,
  tools = true,
}: {
  payload: RefBlockPayload;
  fixtures: Partial<Record<BlockState, BlockData>>;
  tools?: boolean;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const states = previewStates(payload.states);
  const [chosen, setState] = useState<BlockState>('filled');
  const [dark, setDark] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const state = states.includes(chosen) ? chosen : 'filled';
  return (
    <div className="design-preview">
      {tools ? (
        <div className="design-preview-tools">
          <ToggleGroup
            data-size="sm"
            variant="secondary"
            aria-label={t('design.stateLabel')}
            value={state}
            onChange={(v) => setState(v as BlockState)}
          >
            {states.map((s) => (
              <ToggleGroup.Item key={s} value={s}>
                {t(stateKey[s])}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup>
          <ToggleGroup
            data-size="sm"
            variant="secondary"
            aria-label={t('design.themeLabel')}
            value={dark ? 'dark' : 'light'}
            onChange={(v) => setDark(v === 'dark')}
          >
            <ToggleGroup.Item value="light">{t('design.light')}</ToggleGroup.Item>
            <ToggleGroup.Item value="dark">{t('design.dark')}</ToggleGroup.Item>
          </ToggleGroup>
          <ToggleGroup
            data-size="sm"
            variant="secondary"
            aria-label={t('design.widthLabel')}
            value={narrow ? 'narrow' : 'wide'}
            onChange={(v) => setNarrow(v === 'narrow')}
          >
            <ToggleGroup.Item value="narrow">{t('design.narrow')}</ToggleGroup.Item>
            <ToggleGroup.Item value="wide">{t('design.wide')}</ToggleGroup.Item>
          </ToggleGroup>
        </div>
      ) : null}
      <div className="design-stage" data-color-scheme={dark ? 'dark' : 'light'}>
        <div className="design-frame" data-width={narrow ? 'narrow' : 'wide'}>
          <RefBlock
            payload={payload}
            data={fixtures[state] ?? {}}
            state={state}
            locale={locale}
            level={2}
          />
        </div>
      </div>
    </div>
  );
};
