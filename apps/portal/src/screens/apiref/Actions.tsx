import { Button, Paragraph } from '@digdir/designsystemet-react';
import { ApiCallLink, type ApiCallPreview } from '../../components/ApiCall';
import { useT } from '../../i18n';
import { endpoints, fillPath, portalActions, rights } from '../../data/api-reference';

export const Actions = ({ tenant, onDone }: { tenant: string; onDone: (text: string) => void }) => {
  const t = useT();
  return (
    <div className="stack">
      <Paragraph className="ar-measure">{t('apiref.actionsIntro')}</Paragraph>
      <ul className="plain-list ar-acts">
        {portalActions.map((a) => {
          const ep = endpoints.find((e) => e.id === a.endpoint);
          if (!ep) return null;
          const call: ApiCallPreview = {
            action: t(a.title),
            method: ep.method,
            path: fillPath(ep.path, { tenant, ...a.values }),
            right: t(rights[ep.right]),
            endpoint: ep.id,
            ...(ep.body !== undefined ? { body: ep.body } : {}),
          };
          return (
            <li key={a.endpoint} className="ar-act">
              <span className="meta small">{t(a.where)}</span>
              <span className="ar-act-title">{t(a.title)}</span>
              <span className="small">{t(a.desc)}</span>
              <div className="actions">
                <Button
                  data-size="sm"
                  onClick={() => onDone(t('apiref.actionDone', { button: t(a.button) }))}
                >
                  {t(a.button)}
                </Button>
                <ApiCallLink call={call} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
