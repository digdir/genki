import { Field, Label, Search } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { useT } from '../../i18n';
import { areas, endpoints } from '../../data/api-reference';

export const EndpointNav = ({
  selected,
  onPick,
}: {
  selected: string;
  onPick: (id: string) => void;
}) => {
  const t = useT();
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const groups = areas
    .map((area) => ({
      area,
      eps: endpoints.filter(
        (e) =>
          e.area === area &&
          (!query || `${e.method} ${e.path} ${t(e.summary)}`.toLowerCase().includes(query)),
      ),
    }))
    .filter((g) => g.eps.length);
  return (
    <nav aria-label={t('apiref.navLabel')} className="ar-nav">
      <Field data-size="sm">
        <Label htmlFor="ep-sok">{t('apiref.searchLabel')}</Label>
        <Search data-size="sm">
          <Search.Input id="ep-sok" value={q} onChange={(e) => setQ(e.target.value)} />
          <Search.Clear aria-label={t('apiref.clearSearch')} onClick={() => setQ('')} />
        </Search>
      </Field>
      {groups.length === 0 ? (
        <p className="meta" role="status">
          {t('apiref.noMatch')}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.area} className="ar-group">
            <span className="ar-group-name" id={`ar-g-${g.area.replace(/\W+/g, '-')}`}>
              {t(`apiref.area.${g.area}`)}
            </span>
            <ul className="plain-list" aria-labelledby={`ar-g-${g.area.replace(/\W+/g, '-')}`}>
              {g.eps.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className="ar-ep"
                    aria-current={e.id === selected ? 'true' : undefined}
                    onClick={() => onPick(e.id)}
                  >
                    <span className={`ar-m ar-m-${e.method.toLowerCase()}`}>{e.method}</span>
                    <span>{t(e.summary)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </nav>
  );
};
