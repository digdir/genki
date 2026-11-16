import { Paragraph } from '@digdir/designsystemet-react';
import {
  blockSpec,
  templateIds,
  templateKey,
  templates,
  zones,
  type TemplateId,
  type Zone,
} from '@genai/ui-blocks/builder';
import { useT, type PlainKey } from '../../../i18n';
import { blockLabel } from './BlocksPanel';

const shortZone: Record<Zone, PlainKey> = {
  primary: 'builderBlocks.panelLeftShort',
  main: 'builderBlocks.panelMainShort',
  secondary: 'builderBlocks.panelRightShort',
};

export const TemplatesPanel = ({
  current,
  onPick,
}: {
  current: TemplateId | undefined;
  onPick: (id: TemplateId) => void;
}) => {
  const t = useT();
  const nameOf = (id: Parameters<typeof blockLabel>[0]) =>
    blockSpec(id).status === 'planned'
      ? t('builderBlocks.planned', { block: t(blockLabel(id)) })
      : t(blockLabel(id));
  return (
    <div className="blocks-panel">
      <Paragraph data-size="sm">{t('builderBlocks.templatesIntro')}</Paragraph>
      <ul className="blocks-templates">
        {templateIds.map((id) => {
          const template = templates[id];
          const name = t(templateKey(id));
          return (
            <li key={id}>
              <button
                type="button"
                className="blocks-template"
                aria-pressed={current === id}
                aria-label={t('builderBlocks.templateUse', { name })}
                onClick={() => onPick(id)}
              >
                <span className="blocks-stamp" aria-hidden="true">
                  {zones.map((zone) => (
                    <span key={zone} data-zone={zone} data-empty={template[zone].length === 0} />
                  ))}
                </span>
                <span className="stack-xs">
                  <span className="blocks-template-name">{name}</span>
                  <span className="blocks-template-panels">
                    {zones.map((zone) => (
                      <span key={zone} className="meta">
                        <strong>{t(shortZone[zone])}:</strong>{' '}
                        {template[zone].length
                          ? template[zone].map(nameOf).join(', ')
                          : t('builderBlocks.templateNone')}
                      </span>
                    ))}
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
