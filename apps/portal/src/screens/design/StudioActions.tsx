import { useState } from 'react';
import type { ApiClient } from '../../api';
import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import { ConnectClaude, ConnectClaudeToggle } from './ConnectClaude';
import { Panel } from './parts';

interface Connect {
  api: ApiClient;
  tenant: string;
  tenantName: string;
}

const Guide = ({ open, ...props }: Connect & { open: boolean }) => {
  const t = useT();
  return open ? (
    <div id="design-connect-claude" className="design-connect-panel">
      <Panel title={t('design.connectClaude')}>
        <ConnectClaude {...props} />
      </Panel>
    </div>
  ) : null;
};

/** The catalogue's two ways in: «Koble til Claude» and «Importer fra Claude». */
export const StudioActions = (props: Connect) => {
  const t = useT();
  const manage = useRights().has('manage-services');
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="design-actions">
        {manage ? <ConnectClaudeToggle open={open} onToggle={() => setOpen(!open)} /> : null}
        {manage ? (
          <a className="ds-button" data-variant="primary" href="#/design/import">
            {t('design.importFromClaude')}
          </a>
        ) : null}
      </div>
      <Guide open={open && manage} {...props} />
    </>
  );
};

/** A block's header: «Koble til Claude» and «Utgaver og deling». */
export const StudioActionsFor = ({ versions, ...props }: Connect & { versions: string }) => {
  const t = useT();
  const manage = useRights().has('manage-services');
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="design-actions">
        {manage ? <ConnectClaudeToggle open={open} onToggle={() => setOpen(!open)} /> : null}
        <a className="ds-button" data-variant="secondary" href={versions}>
          {t('design.seeVersions')}
        </a>
      </div>
      <Guide open={open && manage} {...props} />
    </>
  );
};
