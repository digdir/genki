import { Label, Paragraph, Textarea } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import type { PlaygroundSource } from '../../api/playground';
import { useT } from '../../i18n';
import { ErrorState } from '../../states';
import './setup-layout.css';

interface Turn {
  question: string;
  answer?: string;
  sources?: PlaygroundSource[];
  error?: unknown;
}

export const TryPane = ({
  api,
  tenant,
  serviceId,
  draft,
  model,
  datasets,
  files,
  version,
  inUse = false,
  playgroundHref,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  draft: unknown;
  model: string;
  datasets: string[];
  files: Record<string, string>;
  version: number;
  inUse?: boolean;
  playgroundHref: string;
}) => {
  const t = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setQuestion('');
    setBusy(true);
    setTurns((all) => [...all, { question: text }]);
    const settle = (turn: Turn) => setTurns((all) => [...all.slice(0, -1), turn]);
    try {
      const result = await api.playground.run(tenant, {
        setup: {
          service: { id: serviceId, version: 'draft', definition: draft, files },
          model,
          datasets,
          skills: [],
          blocks: [],
          output: 'text',
        },
        input: { text },
      });
      settle({
        question: text,
        answer: result.noAnswer ? t('setupList.tryNoAnswer') : (result.text ?? ''),
        sources: result.sources,
      });
    } catch (error) {
      settle({ question: text, error });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-try">
      <Paragraph data-size="sm" className="meta">
        {inUse
          ? t('setupList.tryNoteInUse', { n: version })
          : version > 0
            ? t('setupList.tryNote', { n: version })
            : t('setupList.tryNoteFirst')}
      </Paragraph>
      <div className="try-log" aria-live="polite">
        {turns.map((turn, i) => (
          <div key={i} className="try-turn">
            <div className="try-q">{turn.question}</div>
            {turn.error !== undefined ? (
              <ErrorState error={turn.error} headingLevel={3} />
            ) : turn.answer === undefined ? (
              <span role="status" className="meta">
                {t('setupList.tryRunning')}
              </span>
            ) : (
              <div className="try-a">
                <span>{turn.answer}</span>
                {turn.sources?.length ? (
                  <div className="try-sources">
                    <span className="try-sources-head">{t('setupList.trySources')}</span>
                    {turn.sources.map((s) =>
                      s.url ? (
                        <a key={s.chunkId} href={s.url} target="_blank" rel="noreferrer">
                          {s.title ?? s.document ?? s.chunkId}
                        </a>
                      ) : (
                        <span key={s.chunkId}>{s.title ?? s.document ?? s.chunkId}</span>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>
      <a href={playgroundHref}>{t('setupList.openPlayground')}</a>
      <div className="try-compose">
        <Label htmlFor="setup-try-question" className="visually-hidden">
          {t('setupList.tryQuestionLabel')}
        </Label>
        <Textarea
          id="setup-try-question"
          rows={2}
          placeholder={t('setupList.tryPlaceholder')}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
      </div>
    </div>
  );
};
