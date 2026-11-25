import { Alert, Paragraph } from '@digdir/designsystemet-react';
import { bridgeLimits, type RenderMessage } from '@genai/contracts/block-bridge';
import type { BlockData } from '@genai/contracts/block-fields';
import type { BlockState, RefBlockPayload } from '@genai/contracts/blocks';
import { useEffect, useRef, useState } from 'react';
import { BlockPlaceholder } from './block-placeholder.js';
import {
  dispatchEvent,
  fitRender,
  frameGate,
  helloPort,
  themeOf,
  type BlockEventHandlers,
  type BridgePort,
  type FrameHello,
} from './bridge.js';
import { useT } from './i18n.js';

export interface CodeBlockProps {
  payload: RefBlockPayload;
  data: BlockData;
  state: BlockState;
  settings?: Record<string, boolean | string> | undefined;
  level?: 2 | 3 | undefined;
  locale?: 'nb' | 'nn' | 'en' | undefined;
  handlers?: BlockEventHandlers | undefined;
  host?: string | undefined;
}

type Status = 'loading' | 'ready' | 'silent' | 'stopped';

const schemeOf = (element: Element | null): 'light' | 'dark' =>
  element?.closest('[data-color-scheme]')?.getAttribute('data-color-scheme') === 'dark'
    ? 'dark'
    : 'light';

const CodeFrame = ({
  payload,
  data,
  state,
  settings,
  level,
  locale = 'nb',
  handlers = {},
  host,
}: CodeBlockProps) => {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<BridgePort | null>(null);
  const loads = useRef(0);
  const silence = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState<Status>('loading');
  const [height, setHeight] = useState(payload.frame?.height ?? bridgeLimits.defaultHeight);
  const [notice, setNotice] = useState('');
  const latest = useRef({ data, handlers, state, locale, settings, texts: payload.texts });
  latest.current = { data, handlers, state, locale, settings, texts: payload.texts };
  const title = (locale === 'en' ? payload.title.en : undefined) ?? payload.title.nb ?? '';
  const url = payload.frame?.url;
  const events = useRef(payload.events).current;

  useEffect(() => {
    if (!url) return undefined;
    const gate = frameGate({ events });
    const onHello = (event: MessageEvent) => {
      if (port.current) return;
      const given = helloPort(event as FrameHello, frame.current?.contentWindow);
      if (!given) return;
      port.current = given;
      given.onmessage = (message) => {
        const checked = gate(message.data);
        if (!checked) return;
        if (checked.type === 'resize') setHeight(checked.height);
        else if (checked.type === 'event' && checked.name === 'notify')
          setNotice(checked.payload.text);
        else if (checked.type === 'event')
          dispatchEvent(checked, latest.current.data, latest.current.handlers);
      };
      clearTimeout(silence.current);
      setStatus((s) => (s === 'loading' ? 'ready' : s));
    };
    window.addEventListener('message', onHello);
    return () => {
      window.removeEventListener('message', onHello);
      clearTimeout(silence.current);
      clearTimeout(pending.current);
      port.current?.close();
      port.current = null;
    };
  }, [url, events]);

  useEffect(() => {
    if (status !== 'ready' || pending.current !== undefined) return;
    pending.current = setTimeout(() => {
      pending.current = undefined;
      const now = latest.current;
      const message: RenderMessage = {
        genki: 1,
        type: 'render',
        state: now.state,
        locale: now.locale,
        colorScheme: schemeOf(frame.current),
        theme: themeOf(frame.current),
        props: now.settings ?? {},
        texts: now.texts?.[now.locale] ?? now.texts?.nb ?? {},
        data: now.data,
      };
      port.current?.postMessage(fitRender(message));
    }, 100);
  }, [status, state, locale, settings, data, payload.texts]);

  useEffect(() => {
    if (status !== 'stopped') return;
    port.current?.close();
    port.current = null;
  }, [status]);

  if (!url) return <BlockPlaceholder blockRef={payload.ref} {...(level ? { level } : {})} />;
  if (status === 'silent' || status === 'stopped')
    return (
      <Alert data-color="warning" data-size="sm">
        <Paragraph data-size="sm">
          {status === 'silent' ? t('assembly.codeBlockSilent') : t('assembly.codeBlockStopped')}
        </Paragraph>
      </Alert>
    );
  return (
    <div className="uia-code-block">
      <iframe
        ref={frame}
        src={url}
        sandbox="allow-scripts"
        title={title}
        referrerPolicy="no-referrer"
        allow=""
        loading="lazy"
        height={Math.min(height, bridgeLimits.maxHeight)}
        style={{ border: 0, width: '100%', display: 'block' }}
        onLoad={() => {
          loads.current += 1;
          if (loads.current > 1) setStatus('stopped');
          else if (!port.current)
            silence.current = setTimeout(
              () => setStatus((s) => (s === 'loading' ? 'silent' : s)),
              bridgeLimits.readyWithinMs,
            );
        }}
      />
      {host !== undefined && payload.publisher !== host ? (
        <Paragraph data-size="xs" variant="short">
          {t('assembly.codeBlockFrom', { publisher: payload.publisherName ?? payload.publisher })}
        </Paragraph>
      ) : null}
      <Paragraph data-size="xs" variant="short" role="status">
        {notice}
      </Paragraph>
    </div>
  );
};

/** A code block, run in a sandboxed frame from the block origin and spoken to only over its own channel. */
export const CodeBlock = (props: CodeBlockProps) => (
  <CodeFrame
    key={`${props.payload.frame?.url ?? ''} ${props.payload.events.join(',')}`}
    {...props}
  />
);
