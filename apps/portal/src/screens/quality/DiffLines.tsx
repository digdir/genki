import { useT } from '../../i18n';
import { diffRows } from './diff';
import './diff.css';

const opKey = {
  add: 'quality.opAdd',
  remove: 'quality.opRemove',
  same: 'quality.opSame',
  change: 'quality.opChange',
} as const;

export const DiffLines = ({
  title,
  before,
  after,
}: {
  title: string;
  before: string;
  after: string;
}) => {
  const t = useT();
  return (
    <div className="diff-box">
      <div className="diff-head">{title}</div>
      <ol
        aria-label={t('quality.changesIn', { title: title.toLowerCase() })}
        className="diff-lines"
      >
        {diffRows(before, after).map((row, i) => (
          <li key={i} className={row.op === 'same' ? undefined : row.op}>
            <span className="diff-op">{t(opKey[row.op])}</span>
            {row.op === 'change' ? (
              <span>
                {row.parts.map(([op, text], j) =>
                  op === 'add' ? (
                    <ins key={j}>{text}</ins>
                  ) : op === 'remove' ? (
                    <del key={j}>{text}</del>
                  ) : (
                    <span key={j}>{text}</span>
                  ),
                )}
              </span>
            ) : row.op === 'remove' ? (
              <del>{row.text}</del>
            ) : (
              <span>{row.text}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
};
