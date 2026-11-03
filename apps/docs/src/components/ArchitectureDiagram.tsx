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
import { useEffect, useState, type ComponentType, type KeyboardEvent, type SVGProps } from 'react';
import { useFigure } from './Figure';
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
  title: string;
  short: string;
  kind: Kind;
  tone: Tone;
  icon: Icon;
  vertical?: boolean;
  chip?: string;
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
    title: 'Autentisering',
    short: 'Ansattporten, Maskinporten',
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
    title: 'Tilgangsstyring',
    short: 'Altinn-rettigheter',
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
    title: 'Brukergrensesnitt',
    short: 'Arbeidsflate, portal, API',
    kind: 'grey',
    tone: 'mist',
    icon: MonitorIcon,
    chip: 'KI-komponenter',
  },
  {
    id: 'tjenester',
    block: 'definisjoner',
    x: 200,
    y: 142,
    w: 540,
    h: 80,
    title: 'KI-tjenester',
    short: 'Definert i konfigurasjon',
    kind: 'green',
    tone: 'lilac',
    icon: ComponentIcon,
    chip: 'Portal',
  },
  {
    id: 'kjerne',
    block: 'agent-runtime',
    x: 200,
    y: 244,
    w: 540,
    h: 80,
    title: 'Agentisk rammeverk',
    short: 'Oppgaver, arbeidsmåter, guardrails',
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
    title: 'Kunnskap',
    short: 'Egne data, søkbare med RAG',
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
    title: 'Verktøy',
    short: 'MCP, OpenAPI, A2A',
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
    title: 'Kvalitet',
    short: 'Evals og porter',
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
    title: 'Applikasjonsplattform',
    short: 'DIS: Digdirs plattform for fellesløsninger',
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
    title: 'KI-porten',
    short: 'Ruting, residens, kostnad',
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
    title: 'Språkmodeller',
    short: 'Åpne og kommersielle LLM-er',
    kind: 'purple',
    tone: 'ocean',
    icon: SparklesIcon,
    vertical: true,
  },
];

// Infrastruktur for KI: der modellene kjører. Én klikkbar gruppe, byggekloss 'ki-infrastruktur'.
const HOST_H = 68;
// Hver boks lenker til sin byggekloss under 'ki-infrastruktur'.
const hosts: {
  lines: string[];
  y: number;
  icon?: Icon;
  more?: boolean;
  sub: string;
  label: string;
}[] = [
  {
    lines: ['Sigma2'],
    y: 40,
    icon: PackageIcon,
    sub: 'sigma2',
    label: 'Sigma2 og Olivia',
  },
  {
    lines: ['Telenor', 'AI Factory'],
    y: 146,
    icon: CpuIcon,
    sub: 'telenor',
    label: 'Telenor AI Factory',
  },
  { lines: ['Sky'], y: 252, icon: CloudIcon, sub: 'sky', label: 'Sky' },
  {
    lines: ['Egen drift'],
    y: 358,
    icon: HouseIcon,
    sub: 'egen-drift',
    label: 'Egen drift',
  },
  // Ikke begrenset til noen få: norske datasentre, neoclouds og de store skyene.
  {
    lines: ['…'],
    y: 464,
    more: true,
    sub: 'flere',
    label: 'Flere leverandører',
  },
];

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
  const select = (block: string) => {
    if (onSelect) onSelect(block);
    else navigate({ page: 'byggeklosser', id: block });
  };

  // I fullskjerm eier figuren markeringen: piltastene flytter den, Enter åpner. Starter på det aktive laget.
  const fig = useFigure();
  const nav = interactive && fig.isFull && fig.keyboardNav;
  const [cursor, setCursor] = useState<Highlight | undefined>(undefined);
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
      const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      setCursor((cur) => {
        const i = cur ? order.indexOf(cur) : -1;
        if (e.key === 'Enter' || e.key === ' ') {
          if (cur?.startsWith('infra:'))
            navigate({
              page: 'byggeklosser',
              id: 'ki-infrastruktur',
              sub: cur.slice(6),
            });
          else if (cur) {
            const n = nodes.find((x) => x.id === cur);
            if (n) select(n.block);
          }
          return cur;
        }
        if (e.key === 'Home') return order[0];
        if (e.key === 'End') return order[order.length - 1];
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return order[(i + 1) % order.length];
        return order[(i - 1 + order.length) % order.length];
      });
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

  // The list replaces the drawing on narrow screens (see styles.css).
  const listNodes = [
    ...nodes,
    {
      id: 'infra' as NodeId,
      block: 'ki-infrastruktur',
      title: 'Infrastruktur for KI',
      short: 'Sigma2, Telenor AI Factory, sky, egen drift og flere',
      tone: 'stone' as Tone,
    },
  ];

  return (
    <>
      <svg
        className={`diagram fig-dark${compact ? ' compact' : ''}`}
        viewBox="0 0 1140 560"
        role="img"
        aria-label="Målarkitektur: autentisering og tilgangsstyring til venstre, brukergrensesnitt, KI-tjenester, agentisk rammeverk, data, verktøy og kvalitet i midten, applikasjonsplattform under disse, KI-porten og språkmodeller hos Sigma2, egen drift eller sky til høyre"
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" className="gridline" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="1140" height="560" className="bg" rx="14" />
        <rect x="0" y="0" width="1140" height="560" fill="url(#grid)" rx="14" />

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
          return (
            <motion.g
              key={n.id}
              className={`node ${n.kind}${isActive ? ' active' : ''}${dim ? ' dim' : ''}`}
              initial={false}
              animate={{ opacity: dim ? 0.7 : 1, y: 0 }}
              transition={{ duration: 0.2 }}
              tabIndex={interactive ? 0 : -1}
              role={interactive ? 'button' : undefined}
              aria-label={interactive ? `${n.title}. Vis detaljer` : n.title}
              aria-pressed={interactive ? isActive : undefined}
              onClick={interactive ? () => select(n.block) : undefined}
              onKeyDown={interactive ? (e) => onKey(e, n.block) : undefined}
              style={{ pointerEvents: interactive ? 'auto' : 'none' }}
            >
              <rect className="box" x={n.x} y={n.y} width={n.w} height={n.h} rx="8" />
              {n.vertical ? (
                <>
                  <I aria-hidden x={cx - 14} y={n.y + 24} width={28} height={28} className="icon" />
                  <text
                    className="title"
                    transform={`translate(${cx + 8} ${cy + 20}) rotate(-90)`}
                    textAnchor="middle"
                  >
                    {n.title}
                  </text>
                </>
              ) : (
                <>
                  <I
                    aria-hidden
                    x={n.x + (n.w < 200 ? 12 : 22)}
                    y={cy - 15}
                    width={30}
                    height={30}
                    className="icon"
                  />
                  <text
                    className={`title${n.w < 200 ? ' small' : ''}`}
                    x={n.x + (n.w < 200 ? 48 : 68)}
                    y={cy + 9}
                  >
                    {n.title}
                  </text>
                  {n.chip && (
                    <g className="chip">
                      <rect
                        x={n.x + n.w - n.chip.length * 9.5 - 34}
                        y={cy - 16}
                        width={n.chip.length * 9.5 + 20}
                        height="32"
                        rx="6"
                      />
                      <text x={n.x + n.w - 24} y={cy + 5} textAnchor="end">
                        {n.chip}
                      </text>
                    </g>
                  )}
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
            const I = h.icon;
            const two = h.lines.length > 1;
            const go = () =>
              navigate({
                page: 'byggeklosser',
                id: 'ki-infrastruktur',
                sub: h.sub,
              });
            return (
              <g
                key={h.sub}
                className={`node purple host${h.more ? ' more' : ''}${active.has('infra') && (!activeHost || activeHost === h.sub) ? ' active' : ''}`}
                role={interactive ? 'link' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={`${h.label}. Åpne byggeklossen`}
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
                <title>{h.label}</title>
                <rect className="box" x="956" y={h.y} width="164" height={HOST_H} rx="8" />
                {h.more ? (
                  [-16, 0, 16].map((dx) => (
                    <circle key={dx} className="dot" cx={1038 + dx} cy={h.y + HOST_H / 2} r="3.5" />
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
                    {h.lines.map((l, i) => (
                      <text
                        key={l}
                        className={two ? 'title xs' : 'title small'}
                        x="1004"
                        y={two ? h.y + 27 + i * 20 : h.y + HOST_H / 2 + 6}
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
      </svg>

      <ol className="diagram-list fig" aria-label="Lagene i Genki">
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
                  <strong>{n.title}</strong>
                  <span>{n.short}</span>
                </button>
              ) : (
                <div
                  aria-current={isActive ? 'step' : undefined}
                  className={isActive ? 'active' : undefined}
                >
                  <strong>{n.title}</strong>
                  <span>{n.short}</span>
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
