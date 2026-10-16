import { useEffect, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnswerMarkdown, type CiteRenderer } from '../AnswerMarkdown';
import { ApiError, lockedEnvironmentType, type ApiClient } from '../api';
import { useT } from '../i18n';
import type { AnswerSource, ChatTurn } from '../types';

export const guideService = 'genki-guide__default';
export const atlasSource = '/system-atlas.html';

export const atlasMessages = {
  ask: 'genki-atlas:ask',
  cancel: 'genki-atlas:cancel',
  delta: 'genki-atlas:delta',
  answer: 'genki-atlas:answer',
  error: 'genki-atlas:error',
} as const;

const maxTurns = 40;

const citeFrom =
  (sources: AnswerSource[]): CiteRenderer =>
  (n, key) => {
    const url = sources.find((s) => s.index === n)?.url;
    return url && /^https?:\/\//i.test(url) ? (
      <a key={key} href={url} target="_blank" rel="noreferrer">
        [{n}]
      </a>
    ) : undefined;
  };

export const answerHtml = (text: string, sources: AnswerSource[]) =>
  renderToStaticMarkup(<AnswerMarkdown text={text} cite={citeFrom(sources)} />);

const failureOf = (error: unknown) => {
  if (error instanceof ApiError && error.problem?.type === lockedEnvironmentType)
    return { code: 'locked', title: error.problem.title, detail: error.problem.detail ?? '' };
  if (error instanceof ApiError && (error.status === 403 || error.status === 404))
    return { code: 'no-access' };
  return { code: 'failed' };
};

const turnsOf = (value: unknown): ChatTurn[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxTurns) return undefined;
  const turns = value.filter(
    (m): m is ChatTurn =>
      typeof m === 'object' &&
      m !== null &&
      ((m as ChatTurn).role === 'user' || (m as ChatTurn).role === 'assistant') &&
      typeof (m as ChatTurn).content === 'string',
  );
  if (turns.length !== value.length || turns.at(-1)?.role !== 'user') return undefined;
  return turns.map(({ role, content }) => ({ role, content }));
};

export const Atlas = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const running = new Map<string, AbortController>();
    const reply = (message: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage(message, window.location.origin);
    const relay = async (id: string, messages: ChatTurn[]) => {
      running.get(id)?.abort();
      const controller = new AbortController();
      running.set(id, controller);
      try {
        const answer = await api.askService(
          guideService,
          messages,
          (text) => reply({ type: atlasMessages.delta, id, text }),
          controller.signal,
        );
        reply({
          type: atlasMessages.answer,
          id,
          text: answer.text,
          html: answerHtml(answer.text, answer.sources),
          sources: answer.sources,
        });
      } catch (error) {
        if (!controller.signal.aborted)
          reply({ type: atlasMessages.error, id, ...failureOf(error) });
      } finally {
        if (running.get(id) === controller) running.delete(id);
      }
    };
    const listen = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; id?: unknown; messages?: unknown } | null;
      if (typeof data?.id !== 'string') return;
      if (data.type === atlasMessages.cancel) {
        running.get(data.id)?.abort();
        return;
      }
      const messages = data.type === atlasMessages.ask ? turnsOf(data.messages) : undefined;
      if (messages) void relay(data.id, messages);
    };
    window.addEventListener('message', listen);
    return () => {
      window.removeEventListener('message', listen);
      running.forEach((controller) => controller.abort());
    };
  }, [api]);

  return (
    <main className="atlas-view" id="hovedinnhold">
      <h1 className="visually-hidden">{t('shell.pageAtlas')}</h1>
      <iframe
        ref={frame}
        className="atlas-view-frame"
        title={t('atlas.frameTitle')}
        src={atlasSource}
      />
    </main>
  );
};
