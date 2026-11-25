import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import { claudeLink } from './naming';

const ClaudeLink = ({ prompt }: { prompt: string }) => {
  const t = useT();
  return (
    <a
      className="ds-button"
      data-variant="secondary"
      href={claudeLink(prompt)}
      target="_blank"
      rel="noreferrer"
    >
      {t('design.openInClaude')}
    </a>
  );
};

/** The catalogue's two ways in: «Åpne i Claude» and «Importer fra Claude». */
export const StudioActions = ({ prompt }: { prompt: string }) => {
  const t = useT();
  const manage = useRights().has('manage-services');
  return (
    <div className="design-actions">
      <ClaudeLink prompt={prompt} />
      {manage ? (
        <a className="ds-button" data-variant="primary" href="#/design/import">
          {t('design.importFromClaude')}
        </a>
      ) : null}
    </div>
  );
};

/** A block's header: «Åpne i Claude» and «Utgaver og deling». */
export const StudioActionsFor = ({ prompt, versions }: { prompt: string; versions: string }) => {
  const t = useT();
  return (
    <div className="design-actions">
      <ClaudeLink prompt={prompt} />
      <a className="ds-button" data-variant="secondary" href={versions}>
        {t('design.seeVersions')}
      </a>
    </div>
  );
};
