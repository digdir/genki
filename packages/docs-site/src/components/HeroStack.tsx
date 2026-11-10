import { localName, serviceTypeById } from '@genai/docs-content';
import { useLocale } from '@genai/i18n/react';
import { ChatIcon, CogIcon, ComponentIcon, RobotSmileIcon } from '@navikt/aksel-icons';
import { motion } from 'motion/react';
import type { ComponentType, KeyboardEvent, SVGProps } from 'react';
import { useT } from '../i18n';
import { navigate, type Route } from '../router';

type Kind = 'green' | 'blue' | 'grey' | 'purple';

type Slab = {
  id: string;
  label: 'slabServices' | 'slabPlatform' | 'slabModels' | 'slabInfra';
  kind: Kind;
  cy: number;
  to: Route;
};

const W = 240;
const D = 80;
const T = 22;
const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const VIEW_W = 520;
const CX = VIEW_W / 2 - ((W - D) / 2) * COS;
const LINK_V = 14;

const px = (u: number, v: number) => CX + (u - v) * COS;
const py = (cy: number, u: number, v: number) => cy + (u + v) * SIN;

const slabs: Slab[] = [
  {
    id: 'tjenester',
    label: 'slabServices',
    kind: 'green',
    cy: 120,
    to: { page: 'byggeklosser', id: 'definisjoner' },
  },
  { id: 'genki', label: 'slabPlatform', kind: 'blue', cy: 230, to: { page: 'byggeklosser' } },
  {
    id: 'modeller',
    label: 'slabModels',
    kind: 'purple',
    cy: 340,
    to: { page: 'byggeklosser', id: 'sprakmodeller' },
  },
  {
    id: 'infra',
    label: 'slabInfra',
    kind: 'purple',
    cy: 450,
    to: { page: 'byggeklosser', id: 'ki-infrastruktur' },
  },
];

const bottom = py(slabs[slabs.length - 1].cy, W, D) + T;
const MARGIN = 28;
const VIEW_H = bottom + MARGIN;

const uses: {
  id: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  x: number;
  u: number;
}[] = [
  { id: 'assistenter', icon: ChatIcon, x: 95, u: 30 },
  { id: 'chatboter', icon: RobotSmileIcon, x: 205, u: 90 },
  { id: 'apper', icon: ComponentIcon, x: 315, u: 150 },
  { id: 'agenter', icon: CogIcon, x: 425, u: 210 },
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

const onTopFace = (cy: number) =>
  `matrix(${COS} ${SIN} ${-COS} ${SIN} ${px(W / 2, D / 2)} ${py(cy, W / 2, D / 2)})`;

const activate = (go: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    go();
  }
};

export function HeroStack({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const slabLeft = px(0, D);
  const slabRight = px(W, 0);
  const view = compact
    ? {
        x: slabLeft - 16,
        y: slabs[0].cy - 16,
        w: slabRight - slabLeft + 32,
        h: bottom - slabs[0].cy + 32,
      }
    : { x: 0, y: 0, w: VIEW_W, h: VIEW_H };
  return (
    <svg
      className={`stack-figure fig-dark${compact ? ' compact' : ''}`}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      role="group"
      aria-label={t('docsFigure.heroLabel')}
    >
      <rect x={view.x} y={view.y} width={view.w} height={view.h} rx="16" className="bg" />

      {compact
        ? null
        : uses.map((u, i) => {
            const I = u.icon;
            const type = serviceTypeById(u.id);
            const label = type ? localName(type, locale) : u.id;
            return (
              <motion.g
                key={u.id}
                className="use"
                data-nav={i}
                role="link"
                tabIndex={0}
                aria-label={t('docsFigure.readType', { name: label })}
                onClick={() => navigate({ page: 'typer', id: u.id })}
                onKeyDown={activate(() => navigate({ page: 'typer', id: u.id }))}
                initial={false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <title>{label}</title>
                <rect x={u.x - 22} y={28} width="44" height="44" rx="10" />
                <I aria-hidden x={u.x - 13} y={37} width={26} height={26} />
                <text x={u.x} y={92} textAnchor="middle">
                  {label}
                </text>
              </motion.g>
            );
          })}

      {slabs.map((s, i) => {
        const label = t(`docsLabels.${s.label}`);
        return (
          <motion.g
            key={s.id}
            className={`slab ${s.kind}`}
            data-nav={(compact ? 0 : uses.length) + i}
            role="link"
            tabIndex={0}
            aria-label={t('docsFigure.readMore', { name: label })}
            onClick={() => navigate(s.to)}
            onKeyDown={activate(() => navigate(s.to))}
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <SlabShape cy={s.cy} />
            <text
              className="label"
              transform={onTopFace(s.cy)}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {label}
            </text>
          </motion.g>
        );
      })}

      {compact ? null : (
        <g className="use use-links" aria-hidden="true">
          {uses.map((u) => {
            const tx = px(u.u, LINK_V);
            const ty = py(slabs[0].cy, u.u, LINK_V);
            return (
              <g key={u.id}>
                <path d={`M ${u.x} 100 V 112 L ${tx} ${ty - 10} V ${ty}`} />
                <circle cx={tx} cy={ty} r="3" />
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}
