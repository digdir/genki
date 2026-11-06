import { Button, Spinner, Tag } from '@digdir/designsystemet-react';
import { useT } from '../../../i18n';
import type { ImproveState } from './useAssistant';

export const ImproveInstructions = ({
  state,
  off,
  onToggle,
  onApply,
  onUndo,
  onClose,
  draft = false,
  needsPurpose = false,
}: {
  draft?: boolean;
  needsPurpose?: boolean;
  state: ImproveState;
  off: boolean;
  onToggle: () => void;
  onApply: () => void;
  onUndo: () => void;
  onClose: () => void;
}) => {
  const t = useT();
  const open = state.status === 'open' || state.status === 'applied';
  return (
    <div className="stack-xs">
      <Button
        variant="secondary"
        data-size="sm"
        className="align-start"
        aria-expanded={open}
        aria-disabled={off || needsPurpose || state.status === 'busy' || undefined}
        onClick={() => !off && !needsPurpose && state.status !== 'busy' && onToggle()}
      >
        {t(draft ? 'assistant.draftInstructions' : 'assistant.improve')}
      </Button>
      {needsPurpose ? <span className="meta">{t('assistant.draftNeedsPurpose')}</span> : null}
      {state.status === 'busy' ? (
        <span role="status" className="ax-spinner-line">
          <Spinner aria-hidden data-size="xs" />
          {t('assistant.improveBusy')}
        </span>
      ) : null}
      {open ? (
        <div className="ax-suggestion-panel">
          <Tag data-size="sm" data-color="info">
            {t('assistant.fromAssistant')}
          </Tag>
          <ul className="ax-changes">
            {state.data.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="ax-before-after">
            <div>
              <span className="ax-label">{t('assistant.before')}</span>
              <div className="ax-text-box">{state.previous}</div>
            </div>
            <div>
              <span className="ax-label">{t('assistant.after')}</span>
              <div className="ax-text-box" data-after="true">
                {state.data.after}
              </div>
            </div>
          </div>
          {state.status === 'open' ? (
            <div className="ax-row">
              <Button variant="primary" data-size="sm" onClick={onApply}>
                {t('assistant.useSuggestion')}
              </Button>
              <Button variant="secondary" data-size="sm" onClick={onClose}>
                {t('assistant.discard')}
              </Button>
            </div>
          ) : (
            <div className="ax-row" role="status">
              <span>{t('assistant.appliedNote')}</span>
              <Button variant="tertiary" data-size="sm" onClick={onUndo}>
                {t('assistant.undo')}
              </Button>
              <Button variant="tertiary" data-size="sm" onClick={onClose}>
                {t('assistant.close')}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
