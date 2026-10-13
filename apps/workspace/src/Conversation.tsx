import { Alert, Button, Details, Paragraph, Spinner, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId } from 'react';
import { AnswerText, sourceAnchor } from './AnswerText';
import { failureCopy } from './failures';
import { Feedback } from './Feedback';
import { useT } from './i18n';
import type { AssistantMessage, ChatMessage, FeedbackInput, Source } from './types';

interface Props {
  messages: ChatMessage[];
  organisation: string;
  now: Date;
  onRetry: (message: AssistantMessage) => void;
  onFeedback: (input: FeedbackInput) => Promise<void>;
  onOpenTable?: (message: AssistantMessage) => void;
}

const SourceItem = ({ source, id }: { source: Source; id: string }) => {
  const t = useT();
  const f = useFormat();
  const dateText = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : f.date(date);
  };
  const facts = [
    ...(source.version ? [t('answer.version', { version: source.version })] : []),
    ...(source.publishedAt ? [dateText(source.publishedAt)] : []),
  ];
  return (
    <li id={id} {...(source.index === undefined ? {} : { value: source.index })}>
      {source.url ? (
        <a href={source.url} target="_blank" rel="noreferrer">
          {source.title}
        </a>
      ) : (
        source.title
      )}
      {facts.length ? <span className="source-facts"> · {facts.join(', ')}</span> : null}
      {source.excerpt ? (
        <Details data-size="sm" className="source-excerpt">
          <Details.Summary>{t('answer.excerpt')}</Details.Summary>
          <Details.Content>{source.excerpt}</Details.Content>
        </Details>
      ) : null}
    </li>
  );
};

const Answer = ({
  message,
  organisation,
  now,
  onRetry,
  onFeedback,
  onOpenTable,
}: Omit<Props, 'messages'> & { message: AssistantMessage }) => {
  const t = useT();
  const f = useFormat();
  const anchors = useId();
  const copy = message.failure
    ? failureCopy(message.failure, { organisation, now }, t, f)
    : undefined;
  const empty =
    !message.pending &&
    !message.failure &&
    !message.table &&
    (!!message.noAnswer || !message.text.trim());
  return (
    <div className="answer" aria-busy={message.pending || undefined}>
      {empty ? (
        <Paragraph data-size="sm" className="alert-title">
          {t('answer.noAnswer')}
        </Paragraph>
      ) : (message.text || message.table) && !message.failure ? (
        <Tag data-size="sm" data-color="neutral" className="answer-tag">
          {t('answer.aiTag')}
        </Tag>
      ) : null}
      {message.pending && !message.text ? (
        <Spinner aria-label={t('answer.working')} data-size="sm" />
      ) : null}
      {message.table ? (
        <div className="table-teaser">
          <Paragraph className="strong">{message.table.title ?? t('answer.table')}</Paragraph>
          <Paragraph data-size="sm" className="subtle-sm">
            {t('answer.rows', { count: message.table.rows.length })}
            {message.table.skipped.length
              ? t('answer.unreadable', { count: message.table.skipped.length })
              : ''}
          </Paragraph>
          {onOpenTable ? (
            <Button data-size="sm" className="table-open" onClick={() => onOpenTable(message)}>
              {t('answer.openTable')}
            </Button>
          ) : null}
        </div>
      ) : message.text ? (
        <AnswerText
          text={message.text}
          lang={message.lang}
          sources={message.sources}
          anchorPrefix={anchors}
        />
      ) : null}
      {message.sources.length ? (
        <div>
          <span className="sources-title">{t('answer.sources')}</span>
          <ol className="sources">
            {message.sources.map((source, i) => (
              <SourceItem
                key={i}
                source={source}
                id={sourceAnchor(anchors, source.index ?? i + 1)}
              />
            ))}
          </ol>
        </div>
      ) : null}
      {copy ? (
        <Alert data-color={copy.color} data-size="sm">
          <Paragraph data-size="sm" className="alert-title">
            {copy.title}
          </Paragraph>
          <Paragraph data-size="sm">{copy.text}</Paragraph>
          {copy.action ? (
            <Button
              variant="secondary"
              data-size="sm"
              className="alert-action"
              onClick={() => onRetry(message)}
            >
              {copy.action}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {!message.failure && !message.pending ? (
        <Feedback task={message.task} onSend={onFeedback} />
      ) : null}
    </div>
  );
};

export const Conversation = ({ messages, ...rest }: Props) => {
  const t = useT();
  const f = useFormat();
  return (
    <ol aria-label={t('answer.conversation')} className="conversation">
      {messages.map((message) => (
        <li key={message.id} className={message.role === 'user' ? 'from-user' : 'from-ai'}>
          {message.role === 'user' ? (
            <div lang={message.lang} className="question">
              <span className="visually-hidden">{t('answer.youWrote')}</span>
              {message.values?.length ? (
                <dl className="question-values">
                  {message.values.map((v) => (
                    <div key={v.label}>
                      <dt>{v.label}</dt>
                      <dd>{v.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {message.attachments?.length ? (
                <p className="question-files">
                  {t('answer.attached', { names: f.list(message.attachments) })}
                </p>
              ) : null}
              {message.text}
            </div>
          ) : (
            <Answer message={message} {...rest} />
          )}
        </li>
      ))}
    </ol>
  );
};
