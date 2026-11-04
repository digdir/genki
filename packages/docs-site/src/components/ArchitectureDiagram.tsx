import {
  BranchingIcon,
  CloudIcon,
  CpuIcon,
  CogIcon,
  ComponentIcon,
  DatabaseIcon,
  HouseIcon,
  LayersIcon,
  MonitorIcon,
  PackageIcon,
  PadlockLockedIcon,
  ShieldIcon,
  SparklesIcon,
  TestFlaskIcon,
  WrenchIcon,
} from '@navikt/aksel-icons';
import { motion } from 'motion/react';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type RefObject,
  type SVGProps,
} from 'react';
import { useFigure } from './Figure';
import { blockById, localName } from '@genai/docs-content';
import { useLocale } from '@genai/i18n/react';
import { useT, type LabelKey } from '../i18n';
import { navigate } from '../router';

export type NodeId =
  | 'identitet'
  | 'tilgang'
  | 'infra'
  | 'grensesnitt'
  | 'tjenester'
  | 'kjerne'
  | 'rag'
  | 'verktoy'
  | 'kvalitet'
  | 'plattform'
  | 'modeller'
  | 'inferens';

export type Tone =
  'sand' | 'mist' | 'lilac' | 'teal' | 'sage' | 'olive' | 'stone' | 'rose' | 'ocean';
type Kind = 'grey' | 'cyan' | 'green' | 'blue' | 'purple';
type Icon = ComponentType<SVGProps<SVGSVGElement>>;

type NodeDef = {
  id: NodeId;
  block: string;
  x: number;
  y: number;
  w: number;
  h: number;
  short: LabelKey;
  kind: Kind;
  tone: Tone;
  icon: Icon;
  vertical?: boolean;
  chip?: LabelKey;
};

// Layout after the target architecture: login pillars on the left, the stack in the middle,
// gateway and language models on the right.
const nodes: NodeDef[] = [
  {
    id: 'identitet',
    block: 'autentisering',
    x: 20,
    y: 40,
    w: 72,
    h: 390,
    short: 'docsLabels.shortIdentity',
    kind: 'grey',
    tone: 'sand',
    icon: PadlockLockedIcon,
    vertical: true,
  },
  {
    id: 'tilgang',
    block: 'tilgangsstyring',
    x: 104,
    y: 40,
    w: 72,
    h: 390,
    short: 'docsLabels.shortAccess',
    kind: 'grey',
    tone: 'sand',
    icon: ShieldIcon,
    vertical: true,
  },
  {
    id: 'grensesnitt',
    block: 'kanaler',
    x: 200,
    y: 40,
    w: 540,
    h: 80,
    short: 'docsLabels.shortInterfaces',
    kind: 'grey',
    tone: 'mist',
    icon: MonitorIcon,
    chip: 'docsLabels.chipComponents',
  },
  {
    id: 'tjenester',
    block: 'definisjoner',
    x: 200,
    y: 142,
    w: 540,
    h: 80,
    short: 'docsLabels.shortServices',
    kind: 'green',
    tone: 'lilac',
    icon: ComponentIcon,
    chip: 'docsLabels.chipPortal',
  },
  {
    id: 'kjerne',
    block: 'agent-runtime',
    x: 200,
    y: 244,
    w: 540,
    h: 80,
    short: 'docsLabels.shortFramework',
    kind: 'blue',
    tone: 'teal',
    icon: CogIcon,
  },
  {
    id: 'rag',
    block: 'rag',
    x: 200,
    y: 346,
    w: 170,
    h: 80,
    short: 'docsLabels.shortKnowledge',
    kind: 'blue',
    tone: 'sage',
    icon: DatabaseIcon,
  },
  {
    id: 'verktoy',
    block: 'verktoy',
    x: 385,
    y: 346,
    w: 170,
    h: 80,
    short: 'docsLabels.shortTools',
    kind: 'blue',
    tone: 'olive',
    icon: WrenchIcon,
  },
  {
    id: 'kvalitet',
    block: 'evals',
    x: 570,
    y: 346,
    w: 170,
    h: 80,
    short: 'docsLabels.shortQuality',
    kind: 'blue',
    tone: 'rose',
    icon: TestFlaskIcon,
  },
  {
    id: 'plattform',
    block: 'plattform',
    x: 20,
    y: 452,
    w: 816,
    h: 80,
    short: 'docsLabels.shortPlatform',
    kind: 'grey',
    tone: 'stone',
    icon: LayersIcon,
  },
  {
    id: 'modeller',
    block: 'ki-gateway',
    x: 764,
    y: 40,
    w: 72,
    h: 390,
    short: 'docsLabels.shortGateway',
    kind: 'blue',
    tone: 'ocean',
    icon: BranchingIcon,
    vertical: true,
  },
  {
    id: 'inferens',
    block: 'sprakmodeller',
    x: 860,
    y: 40,
    w: 72,
    h: 492,
    short: 'docsLabels.shortModels',
    kind: 'purple',
    tone: 'ocean',
    icon: SparklesIcon,
    vertical: true,
  },
];

const HOST_H = 68;
const TOP = 40;
const NARROW_BELOW = 960;
const hosts: {
  y: number;
  icon?: Icon;
  more?: boolean;
  sub: string;
  label: LabelKey;
  full: LabelKey;
  twoLines?: boolean;
}[] = [
  {
    y: 40,
    icon: PackageIcon,
    sub: 'sigma2',
    label: 'docsLabels.hostSigma2',
    full: 'docsLabels.hostSigma2Full',
  },
  {
    y: 146,
    icon: CpuIcon,
    sub: 'telenor',
    label: 'docsLabels.hostTelenor',
    full: 'docsLabels.hostTelenor',
    twoLines: true,
  },
  {
    y: 252,
    icon: CloudIcon,
    sub: 'sky',
    label: 'docsLabels.hostCloud',
    full: 'docsLabels.hostCloud',
  },
  {
    y: 358,
    icon: HouseIcon,
    sub: 'egen-drift',
    label: 'docsLabels.hostOwn',
    full: 'docsLabels.hostOwn',
  },
  { y: 464, more: true, sub: 'flere', label: 'docsLabels.hostMore', full: 'docsLabels.hostMore' },
];

const splitFirst = (text: string) => {
  const at = text.indexOf(' ');
  return at < 0 ? [text] : [text.slice(0, at), text.slice(at + 1)];
};

const useNarrow = (ref: RefObject<SVGSVGElement | null>) => {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width > 0 && entry.contentRect.width < NARROW_BELOW),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
};

// Connectors between the pillars and the stack, with a small dot at each end.
const rowCenters = [80, 182, 284, 386];
const links: [number, number, number, number][] = [
  ...rowCenters.map((y): [number, number, number, number] => [176, y, 200, y]),
  ...rowCenters.map((y): [number, number, number, number] => [740, y, 764, y]),
  ...[120, 235, 350].map((y): [number, number, number, number] => [836, y, 860, y]),
  ...hosts.map((h): [number, number, number, number] => [
    932,
    h.y + HOST_H / 2,
    956,
    h.y + HOST_H / 2,
  ]),
];

/** `infra:<del>` markerer én enkelt boks i infrastrukturkolonnen, f.eks. `infra:sigma2`. */
export type Highlight = NodeId | 'data' | `infra:${string}`;

function activeSet(highlight?: Highlight): Set<NodeId> {
  if (!highlight) return new Set();
  if (highlight === 'data') return new Set<NodeId>(['rag']);
  if (highlight.startsWith('infra:')) return new Set<NodeId>(['infra']);
  return new Set([highlight as NodeId]);
}

export function ArchitectureDiagram({
  highlight,
  interactive = true,
  onSelect,
  compact = false,
}: {
  highlight?: Highlight;
  interactive?: boolean;
  onSelect?: (block: string) => void;
  compact?: boolean;
}) {
  const t = useT();
  const { locale } = useLocale();
  const title = (n: { block: string }) => {
    const b = blockById(n.block);
    return b ? localName(b, locale) : n.block;
  };
  const select = (block: string) => {
    if (onSelect) onSelect(block);
    else navigate({ page: 'byggeklosser', id: block });
  };

  // I fullskjerm eier figuren markeringen: piltastene flytter den, Enter åpner. Starter på det aktive laget.
  const fig = useFigure();
  const nav = interactive && fig.isFull && fig.keyboardNav;
  const [cursor, setCursor] = useState<Highlight | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement>(null);
  const narrow = useNarrow(svgRef);
  useEffect(() => {
    if (!nav) {
      setCursor(undefined);
      return;
    }
    const order: Highlight[] = [
      ...nodes.map((n) => n.id),
      ...hosts.map((h) => `infra:${h.sub}` as Highlight),
    ];
    const start =
      highlight === 'data' ? 'rag' : highlight === 'infra' ? order[nodes.length] : highlight;
    // Uten aktivt lag står alt umarkert til første tastetrykk.
    setCursor(start && order.includes(start) ? start : undefined);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
      const i = focused ? order.indexOf(focused as Highlight) : -1;
      const next =
        e.key === 'Home'
          ? order[0]
          : e.key === 'End'
            ? order[order.length - 1]
            : e.key === 'ArrowRight' || e.key === 'ArrowDown'
              ? order[(i + 1) % order.length]
              : order[(i - 1 + order.length) % order.length];
      setCursor(next);
      svgRef.current?.querySelector<SVGElement>(`[data-key="${next}"]`)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // select og highlight endres ikke mens fullskjerm er åpen
  }, [nav]);

  const shown = nav && cursor ? cursor : highlight;
  const active = activeSet(shown);
  const activeHost = shown?.startsWith('infra:') ? shown.slice(6) : undefined;
  const hasActive = active.size > 0;

  const onKey = (e: KeyboardEvent<Element>, block: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(block);
    }
  };

  const listNodes = [
    ...nodes,
    {
      id: 'infra' as NodeId,
      block: 'ki-infrastruktur',
      short: 'docsLabels.shortInfra' as LabelKey,
      tone: 'stone' as Tone,
    },
  ];

  return (
    <>
      <svg
        className={`diagram fig-dark${compact ? ' compact' : ''}${narrow ? ' narrow' : ''}`}
        viewBox={`0 0 1140 ${560 + TOP}`}
        role="group"
        ref={svgRef}
        aria-label={t('docsFigure.diagramLabel')}
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" className="gridline" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="1140" height={560 + TOP} className="bg" rx="14" />
        <rect x="0" y="0" width="1140" height={560 + TOP} fill="url(#grid)" rx="14" />

        <g transform={`translate(0 ${TOP})`}>
          {links.map(([x1, y1, x2, y2], i) => (
            <g key={i} className="link">
              <line x1={x1} y1={y1} x2={x2} y2={y2} />
              <circle cx={x1} cy={y1} r="3" />
              <circle cx={x2} cy={y2} r="3" />
            </g>
          ))}

          {nodes.map((n) => {
            const isActive = active.has(n.id);
            const dim = hasActive && !isActive;
            const I = n.icon;
            const cx = n.x + n.w / 2;
            const cy = n.y + n.h / 2;
            const name = title(n);
            const chip = n.chip && !narrow ? t(n.chip) : undefined;
            const small = n.w < 200;
            return (
              <motion.g
                key={n.id}
                data-key={n.id}
                onFocus={nav ? () => setCursor(n.id) : undefined}
                className={`node ${n.kind}${isActive ? ' active' : ''}${dim ? ' dim' : ''}`}
                initial={false}
                animate={{ opacity: dim ? 0.7 : 1, y: 0 }}
                transition={{ duration: 0.2 }}
                tabIndex={interactive ? 0 : -1}
                role={interactive ? 'button' : undefined}
                aria-label={interactive ? t('docsFigure.showDetails', { name }) : name}
                aria-pressed={interactive ? isActive : undefined}
                onClick={interactive ? () => select(n.block) : undefined}
                onKeyDown={interactive ? (e) => onKey(e, n.block) : undefined}
                style={{ pointerEvents: interactive ? 'auto' : 'none' }}
              >
                <rect className="box" x={n.x} y={n.y} width={n.w} height={n.h} rx="8" />
                {n.vertical ? (
                  <>
                    <I
                      aria-hidden
                      x={cx - 14}
                      y={n.y + 24}
                      width={28}
                      height={28}
                      className="icon"
                    />
                    <text
                      className="title"
                      transform={`translate(${cx + 8} ${cy + 20}) rotate(-90)`}
                      textAnchor="middle"
                    >
                      {name}
                    </text>
                  </>
                ) : (
                  <>
                    <I
                      aria-hidden
                      x={n.x + (small ? 12 : 22)}
                      y={cy - 15}
                      width={30}
                      height={30}
                      className="icon"
                    />
                    <text
                      className={`title${small ? ' small' : ''}`}
                      x={n.x + (small ? 48 : 68)}
                      y={cy + 9}
                    >
                      {name}
                    </text>
                    {chip ? (
                      <g className="chip">
                        <rect
                          x={n.x + n.w - chip.length * 9.5 - 34}
                          y={cy - 16}
                          width={chip.length * 9.5 + 20}
                          height="32"
                          rx="6"
                        />
                        <text x={n.x + n.w - 24} y={cy + 5} textAnchor="end">
                          {chip}
                        </text>
                      </g>
                    ) : null}
                  </>
                )}
              </motion.g>
            );
          })}

          <motion.g
            className={`hosts${hasActive && !active.has('infra') ? ' dim' : ''}`}
            initial={false}
            animate={{ opacity: hasActive && !active.has('infra') ? 0.7 : 1 }}
            transition={{ duration: 0.2 }}
          >
            {hosts.map((h) => {
              const I = narrow ? undefined : h.icon;
              const label = t(h.label);
              const lines = h.twoLines ? splitFirst(label) : [label];
              const two = lines.length > 1;
              const textX = I ? 1004 : 972;
              const lineGap = narrow ? 24 : 20;
              const go = () =>
                navigate({
                  page: 'byggeklosser',
                  id: 'ki-infrastruktur',
                  sub: h.sub,
                });
              return (
                <g
                  key={h.sub}
                  data-key={`infra:${h.sub}`}
                  onFocus={nav ? () => setCursor(`infra:${h.sub}`) : undefined}
                  className={`node purple host${h.more ? ' more' : ''}${active.has('infra') && (!activeHost || activeHost === h.sub) ? ' active' : ''}`}
                  role={interactive ? 'link' : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={t('docsFigure.openBlock', { name: t(h.full) })}
                  onClick={interactive ? go : undefined}
                  onKeyDown={
                    interactive
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            go();
                          }
                        }
                      : undefined
                  }
                >
                  <title>{t(h.full)}</title>
                  <rect className="box" x="956" y={h.y} width="164" height={HOST_H} rx="8" />
                  {h.more ? (
                    [-16, 0, 16].map((dx) => (
                      <circle
                        key={dx}
                        className="dot"
                        cx={1038 + dx}
                        cy={h.y + HOST_H / 2}
                        r="3.5"
                      />
                    ))
                  ) : (
                    <>
                      {I && (
                        <I
                          aria-hidden
                          x={970}
                          y={h.y + HOST_H / 2 - 13}
                          width={26}
                          height={26}
                          className="icon"
                        />
                      )}
                      {lines.map((l, i) => (
                        <text
                          key={l}
                          className="title host-label"
                          x={textX}
                          y={h.y + HOST_H / 2 + 6 + (two ? (i - 0.5) * lineGap : 0)}
                        >
                          {l}
                        </text>
                      ))}
                    </>
                  )}
                </g>
              );
            })}
          </motion.g>
        </g>
      </svg>

      <ol
        className={`diagram-list fig${interactive ? '' : ' steps'}`}
        aria-label={t('docsFigure.layers')}
      >
        {listNodes.map((n) => {
          const isActive = active.has(n.id);
          return (
            <li key={n.id} data-tone={n.tone}>
              {interactive ? (
                <button
                  type="button"
                  aria-pressed={isActive}
                  className={isActive ? 'active' : undefined}
                  onClick={() => select(n.block)}
                >
                  <strong>{title(n)}</strong>
                  <span>{t(n.short)}</span>
                </button>
              ) : (
                <div
                  aria-current={isActive ? 'step' : undefined}
                  className={isActive ? 'active' : undefined}
                >
                  <strong>{title(n)}</strong>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

const primary = [
  ...nodes,
  { block: 'ki-infrastruktur', id: 'infra' as NodeId, tone: 'stone' as Tone },
];

export const nodeForBlock: Record<string, NodeId> = Object.fromEntries(
  primary.map((n) => [n.block, n.id]),
) as Record<string, NodeId>;

export const toneForBlock: Record<string, Tone> = Object.fromEntries(
  primary.map((n) => [n.block, n.tone]),
) as Record<string, Tone>;
