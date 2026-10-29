import { Paragraph } from '@digdir/designsystemet-react';
import { useT, type PlainKey } from '../../../i18n';
import { blockLabel } from './BlocksPanel';
import {
  blocksIn,
  panels,
  templateIds,
  templates,
  type BlockLayout,
  type TemplateId,
} from './rules';

export const templateLabel: Record<TemplateId, PlainKey> = {
  all: 'builderBlocks.templateAll',
  sourcesFocus: 'builderBlocks.templateSourcesFocus',
  procedureFocus: 'builderBlocks.templateProcedureFocus',
  notesFocus: 'builderBlocks.templateNotesFocus',
  documentFocus: 'builderBlocks.templateDocumentFocus',
  classic: 'builderBlocks.templateClassic',
  noRight: 'builderBlocks.templateNoRight',
  noLeft: 'builderBlocks.templateNoLeft',
  chatOnly: 'builderBlocks.templateChatOnly',
};

const shortPanel: Record<(typeof panels)[number], PlainKey> = {
  left: 'builderBlocks.panelLeftShort',
  main: 'builderBlocks.panelMainShort',
  right: 'builderBlocks.panelRightShort',
};

export const TemplatesPanel = ({
  current,
  onPick,
}: {
  current: TemplateId | undefined;
  onPick: (id: TemplateId, layout: BlockLayout) => void;
}) => {
  const t = useT();
  return (
    <div className="blocks-panel">
      <Paragraph data-size="sm">{t('builderBlocks.templatesIntro')}</Paragraph>
      <ul className="blocks-templates">
        {templateIds.map((id) => {
          const layout = templates[id];
          const name = t(templateLabel[id]);
          return (
            <li key={id}>
              <button
                type="button"
                className="blocks-template"
                aria-pressed={current === id}
                aria-label={t('builderBlocks.templateUse', { name })}
                onClick={() => onPick(id, layout)}
              >
                <span className="blocks-stamp" aria-hidden="true">
                  {panels.map((p) => (
                    <span key={p} data-panel={p} data-empty={blocksIn(layout, p).length === 0} />
                  ))}
                </span>
                <span className="stack-xs">
                  <span className="blocks-template-name">{name}</span>
                  <span className="blocks-template-panels">
                    {panels.map((p) => {
                      const ids = blocksIn(layout, p);
                      return (
                        <span key={p} className="meta">
                          <strong>{t(shortPanel[p])}:</strong>{' '}
                          {ids.length
                            ? ids.map((b) => t(blockLabel[b])).join(', ')
                            : t('builderBlocks.templateNone')}
                        </span>
                      );
                    })}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
