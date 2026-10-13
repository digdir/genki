import { Chip, Fieldset, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { changeColors, changeTypeKeys, changeTypes, type ChangeEntry } from '../../data/log';
import { useT } from '../../i18n';

export const ChangesTab = ({ changes }: { changes: ChangeEntry[] }) => {
  const t = useT();
  const [type, setType] = useState<(typeof changeTypes)[number]>('Alle');
  const list = changes.filter((c) => type === 'Alle' || c.type === type);
  return (
    <div className="stack-sm">
      <Fieldset>
        <Fieldset.Legend>{t('logChanges.legend')}</Fieldset.Legend>
        <div className="tag-row">
          {changeTypes.map((kind) => (
            <Chip.Radio
              key={kind}
              name="lg-type"
              checked={type === kind}
              onChange={() => setType(kind)}
            >
              {t(changeTypeKeys[kind])}
            </Chip.Radio>
          ))}
        </div>
      </Fieldset>
      {list.length > 0 ? (
        <ol className="plain-list log-changes" aria-label={t('log.tabChanges')}>
          {list.map((c) => (
            <li
              key={`${c.when}-${c.what}`}
              className={c.type === 'Støttetilgang' ? 'support' : undefined}
            >
              <span className="log-change-when meta">{c.when}</span>
              <span className="log-change-body">
                <span className="tag-row">
                  <Tag data-size="sm" data-color={c.color ?? changeColors[c.type] ?? 'neutral'}>
                    {t(changeTypeKeys[c.type])}
                  </Tag>
                  <span className="log-strong">{c.what}</span>
                </span>
                <span className="meta">
                  {c.who}
                  {c.why ? ` · «${c.why}»` : ''}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p>{t('logChanges.empty')}</p>
      )}
    </div>
  );
};
