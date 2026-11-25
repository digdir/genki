import { Alert, Divider, Heading, Paragraph } from '@digdir/designsystemet-react';
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useT, type PlainKey } from '../../i18n';
import { areaLabelKeys } from './setup-change-text';
import type { SetupArea } from './setup-diff';
import type { AreaFact } from './setup-layout';
import './setup-form.css';

/** The areas the new Oppsett shows; the rest are under Avansert or on the publish page. */
const groups: { heading: PlainKey; areas: SetupArea[] }[] = [
  { heading: 'setupList.groupBasic', areas: ['purpose', 'sources', 'input', 'result'] },
  { heading: 'setupList.groupAdvanced', areas: ['model'] },
];

const helpKeys: Partial<Record<SetupArea, PlainKey>> = {
  purpose: 'setupList.helpPurpose',
  sources: 'setupList.helpSources',
  input: 'setupList.helpInput',
  result: 'setupList.helpResult',
  model: 'setupList.helpModel',
};

export const chatWidth = { start: 400, min: 320, max: 640, step: 16 };
const widthKey = 'genki.setup.chatWidth';

const keptWidth = () => {
  try {
    const n = Number(localStorage.getItem(widthKey));
    return n >= chatWidth.min && n <= chatWidth.max ? n : chatWidth.start;
  } catch {
    return chatWidth.start;
  }
};

const keepWidth = (n: number) => {
  try {
    localStorage.setItem(widthKey, String(n));
  } catch {
    // The width is a convenience; without storage it starts at the default next time.
  }
};

const clamp = (n: number) => Math.min(chatWidth.max, Math.max(chatWidth.min, Math.round(n)));

/** Where the chat sticks: under the tab row, as `top` in setup-form.css. */
export const chatStickyTop = 64;

/**
 * Keeps the chat's field on screen: the chat is as tall as the room from where it stands to the
 * bottom of the window, lower on the page before it is scrolled, under the tab row after.
 */
const useChatTop = (on: boolean) => {
  const chat = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = chat.current;
    const layout = element?.parentElement;
    if (!on || !element || !layout) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const top = Math.max(chatStickyTop, Math.round(layout.getBoundingClientRect().top));
      element.style.setProperty('--chat-top', `${top}px`);
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('scroll', later, { passive: true, capture: true });
    window.addEventListener('resize', later);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', later, { capture: true });
      window.removeEventListener('resize', later);
    };
  }, [on]);
  return chat;
};

/** The new Oppsett: every area in one form, the builder assistant left of a movable line. */
export const SetupForm = ({
  facts,
  area,
  assistant,
  footer,
}: {
  facts: Record<SetupArea, AreaFact>;
  area: (area: SetupArea) => ReactNode;
  assistant?: ReactNode;
  footer?: ReactNode;
}) => {
  const t = useT();
  const [width, setWidth] = useState(keptWidth);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const chatRef = useChatTop(assistant !== undefined);
  const resize = (n: number) => {
    const next = clamp(n);
    setWidth(next);
    keepWidth(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const to: Record<string, number> = {
      ArrowLeft: width - chatWidth.step,
      ArrowRight: width + chatWidth.step,
      Home: chatWidth.min,
      End: chatWidth.max,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resize(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    resize(drag.current.width + event.clientX - drag.current.x);
  };
  const onPointerUp = () => {
    drag.current = undefined;
  };
  return (
    <div
      className="setup-form-layout"
      style={assistant === undefined ? undefined : { ['--chat-width' as string]: `${width}px` }}
      data-with-chat={assistant === undefined ? undefined : true}
    >
      {assistant === undefined ? null : (
        <>
          <div
            ref={chatRef}
            className="setup-form-chat"
            role="region"
            aria-label={t('setupList.sideLabel')}
          >
            {assistant}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('setupList.chatWidth')}
            aria-valuenow={width}
            aria-valuemin={chatWidth.min}
            aria-valuemax={chatWidth.max}
            tabIndex={0}
            className="setup-form-handle"
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </>
      )}
      <div className="setup-form stack">
        {groups.map((group, g) => (
          <Fragment key={group.heading}>
            {g > 0 ? <Divider /> : null}
            <Heading level={2} data-size="md">
              {t(group.heading)}
            </Heading>
            {group.areas.map((a, i) => {
              const fact = facts[a];
              const help = helpKeys[a];
              return (
                <Fragment key={a}>
                  {i > 0 ? <Divider /> : null}
                  <section
                    id={`omrade-${a}`}
                    aria-labelledby={`omrade-${a}-h`}
                    className="setup-form-area stack"
                  >
                    <div className="stack-xs">
                      <Heading level={3} data-size="sm" id={`omrade-${a}-h`}>
                        {t(areaLabelKeys[a])}
                      </Heading>
                      {help ? <Paragraph className="meta">{t(help)}</Paragraph> : null}
                    </div>
                    {fact.problems?.length ? (
                      <Alert data-color="warning" data-size="sm">
                        <Heading level={4} data-size="2xs">
                          {t('setupList.missingHeading')}
                        </Heading>
                        <ul className="bullets">
                          {fact.problems.map((problem) => (
                            <li key={problem}>{problem}</li>
                          ))}
                        </ul>
                      </Alert>
                    ) : null}
                    {area(a)}
                  </section>
                </Fragment>
              );
            })}
          </Fragment>
        ))}
        <Divider />
        {footer}
      </div>
    </div>
  );
};
