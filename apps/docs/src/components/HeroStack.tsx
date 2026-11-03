import { ChatIcon, CogIcon, ComponentIcon, RobotSmileIcon } from '@navikt/aksel-icons';
import { motion } from 'motion/react';
import type { ComponentType, SVGProps } from 'react';
import { navigate, type Route } from '../router';

type Kind = 'green' | 'blue' | 'grey' | 'purple';

type Slab = { id: string; label: string; kind: Kind; cy: number; to: Route };

const W = 240; // width along the first isometric axis
const D = 80; // depth along the second axis
const T = 22; // thickness
const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const CX = 260; // x of the slab's back corner

// Isometric projection of a point (u, v) on a slab's top face.
const px = (u: number, v: number) => CX + (u - v) * COS;
const py = (cy: number, u: number, v: number) => cy + (u + v) * SIN;

const slabs: Slab[] = [
  {
    id: 'tjenester',
    label: 'KI-tjenester',
    kind: 'green',
    cy: 120,
    to: { page: 'byggeklosser', id: 'definisjoner' },
  },
  {
    id: 'genki',
    label: 'Fellesløsning for KI',
    kind: 'blue',
    cy: 230,
    to: { page: 'byggeklosser' },
  },
  {
    id: 'modeller',
    label: 'Språkmodeller',
    kind: 'purple',
    cy: 340,
    to: { page: 'byggeklosser', id: 'sprakmodeller' },
  },
  {
    id: 'infra',
    label: 'Infrastruktur for KI',
    kind: 'purple',
    cy: 450,
    to: { page: 'byggeklosser', id: 'ki-infrastruktur' },
  },
];

// Typene KI-tjenester, hver med egen side under #/typer.
const uses: {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  x: number;
  u: number;
  v: number;
}[] = [
  {
    id: 'assistenter',
    label: 'Assistenter',
    icon: ChatIcon,
    x: 95,
    u: 30,
    v: 60,
  },
  {
    id: 'chatboter',
    label: 'Chatboter',
    icon: RobotSmileIcon,
    x: 205,
    u: 90,
    v: 40,
  },
  { id: 'apper', label: 'Apper', icon: ComponentIcon, x: 315, u: 160, v: 40 },
  { id: 'agenter', label: 'Agenter', icon: CogIcon, x: 425, u: 225, v: 20 },
];

function SlabShape({ cy }: { cy: number }) {
  const top = [
    [px(0, 0), py(cy, 0, 0)],
    [px(W, 0), py(cy, W, 0)],
    [px(W, D), py(cy, W, D)],
    [px(0, D), py(cy, 0, D)],
  ];
  const pts = (p: number[][]) => p.map(([x, y]) => `${x},${y}`).join(' ');
  const left = [top[3], top[2], [top[2][0], top[2][1] + T], [top[3][0], top[3][1] + T]];
  const right = [top[2], top[1], [top[1][0], top[1][1] + T], [top[2][0], top[2][1] + T]];
  return (
    <>
      <polygon className="face left" points={pts(left)} />
      <polygon className="face right" points={pts(right)} />
      <polygon className="face top" points={pts(top)} />
    </>
  );
}

export function HeroStack() {
  const centerX = px(W / 2, D / 2);
  const bottom = [...slabs].reverse();
  return (
    <svg
      className="stack-figure fig-dark"
      viewBox="0 0 520 640"
      role="group"
      aria-label="Lagene: assistenter, chatboter, apper og agenter bruker KI-tjenester, som kjører på fellesløsningen for generativ KI, oppå infrastruktur for KI og språkmodeller. Klikk på et lag for å lese mer."
    >
      <rect x="0" y="0" width="520" height="640" rx="16" className="bg" />

      {/* Vertical thread through all layers */}
      <line className="thread" x1={centerX} y1={120} x2={centerX} y2={py(450, W / 2, D / 2)} />

      {bottom.map((s) => {
        return (
          <motion.g
            key={s.id}
            className={`slab ${s.kind}`}
            data-nav={uses.length + slabs.indexOf(s)}
            role="link"
            tabIndex={0}
            aria-label={`${s.label}: les mer`}
            onClick={() => navigate(s.to)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(s.to);
              }
            }}
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <SlabShape cy={s.cy} />
            <text className="label" x={centerX} y={py(s.cy, W / 2, D / 2) + 7} textAnchor="middle">
              {s.label}
            </text>
          </motion.g>
        );
      })}

      {uses.map((u) => {
        const tx = px(u.u, u.v);
        const ty = py(120, u.u, u.v);
        const I = u.icon;
        return (
          <motion.g
            key={u.id}
            className="use"
            data-nav={uses.indexOf(u)}
            role="link"
            tabIndex={0}
            aria-label={`${u.label}: les om denne typen KI-tjeneste`}
            onClick={() => navigate({ page: 'typer', id: u.id })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate({ page: 'typer', id: u.id });
              }
            }}
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <title>{u.label}</title>
            <path d={`M ${u.x} 98 V 112 L ${tx} ${ty - 10} V ${ty}`} />
            <circle cx={tx} cy={ty} r="3" />
            <rect x={u.x - 22} y={28} width="44" height="44" rx="10" />
            <I aria-hidden x={u.x - 13} y={37} width={26} height={26} />
            <text x={u.x} y={90} textAnchor="middle">
              {u.label}
            </text>
          </motion.g>
        );
      })}
    </svg>
  );
}
