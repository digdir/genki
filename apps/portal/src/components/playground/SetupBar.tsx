import { Button, Chip } from '@digdir/designsystemet-react';
import { useT } from '../../i18n';
import { Icon, icons } from '../Icon';

export interface SetupRow {
  key: 'a' | 'b';
  chips: string[];
  expanded: boolean;
  onEdit: () => void;
}

export const SetupBar = ({
  rows,
  comparing,
  sessionText,
  onToggleCompare,
  onShowCall,
}: {
  rows: SetupRow[];
  comparing: boolean;
  sessionText: string;
  onToggleCompare: () => void;
  onShowCall: () => void;
}) => {
  const t = useT();
  return (
    <div className="playground-setup-bar">
      {rows.map((row) => {
        const label = t('playground.setupLabel', { key: row.key.toUpperCase() });
        return (
          <div key={row.key} className="playground-setup-row">
            {comparing ? <span className="playground-strong">{label}</span> : null}
            <div role="group" aria-label={label} className="playground-chips">
              {row.chips.map((chip) => (
                <Chip.Button key={chip} data-size="sm" onClick={row.onEdit}>
                  {chip}
                </Chip.Button>
              ))}
              <Button
                variant="tertiary"
                data-size="sm"
                aria-expanded={row.expanded}
                onClick={row.onEdit}
              >
                {t('playground.editSetup')}
              </Button>
            </div>
          </div>
        );
      })}
      <div className="playground-setup-foot">
        <span className="playground-session">
          {t('playground.setupSessionNote')} {sessionText}
        </span>
        <Button
          variant="secondary"
          data-size="sm"
          aria-pressed={comparing}
          onClick={onToggleCompare}
        >
          {comparing ? t('playground.endCompare') : t('playground.compare')}
        </Button>
        <Button variant="tertiary" data-size="sm" onClick={onShowCall}>
          <Icon d={icons.code} size={18} />
          {t('common.apiCall')}
        </Button>
      </div>
    </div>
  );
};
