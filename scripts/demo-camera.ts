// The film's camera and pointer: a critically damped spring towards each shot, sampled per frame.
import { contentWidth, frame, type Shot } from './demo-edl.ts';
import type { Click, Move } from './demo-events.ts';
import type { Box, Point } from './demo-pointer.ts';

export const content = { x: 110, y: 74, width: contentWidth, height: 956 };

export interface View {
  zoom: number;
  x: number;
  y: number;
}

export const rest: View = { zoom: 1, x: frame[0] / 2, y: frame[1] / 2 };

export const springStep = (
  position: number,
  velocity: number,
  target: number,
  omega: number,
  dt: number,
) => {
  const d = position - target;
  const decay = Math.exp(-omega * dt);
  const kick = velocity + omega * d;
  return {
    position: target + (d + kick * dt) * decay,
    velocity: (velocity - omega * kick * dt) * decay,
  };
};

export const onScreen = (p: Point, viewport: [number, number]): Point => {
  const k = content.width / viewport[0];
  return { x: content.x + p.x * k, y: content.y + p.y * k };
};

export const viewOf = (target: Box | undefined, zoom: number, viewport: [number, number]): View => {
  if (!target || zoom <= 1) return rest;
  const centre = onScreen(
    { x: target.x + target.width / 2, y: target.y + target.height / 2 },
    viewport,
  );
  const clamp = (v: number, lo: number, hi: number) =>
    lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
  return {
    zoom,
    x: clamp(
      centre.x,
      content.x + frame[0] / 2 / zoom,
      content.x + content.width - frame[0] / 2 / zoom,
    ),
    y: clamp(
      centre.y,
      content.y + frame[1] / 2 / zoom,
      content.y + content.height - frame[1] / 2 / zoom,
    ),
  };
};

export const clickPull = 1.06;

const goalAt = (
  shots: Shot[],
  clicks: { at: number; x: number; y: number }[],
  t: number,
  viewport: [number, number],
) => {
  const shot = shots.findLast((s) => s.at <= t);
  const view = viewOf(shot?.target, shot?.zoom ?? 1, viewport);
  if (view.zoom > 1) return view;
  const click = clicks.find((c) => t >= c.at - 0.45 && t <= c.at + 0.3);
  if (!click) return view;
  const p = onScreen(click, viewport);
  return { zoom: clickPull, x: rest.x + (p.x - rest.x) * 0.35, y: rest.y + (p.y - rest.y) * 0.35 };
};

export const settleSeconds = 0.9;

export const cameraPath = (
  shots: Shot[],
  clicks: { at: number; x: number; y: number }[],
  seconds: number,
  fps: number,
  viewport: [number, number],
  substeps = 4,
): View[] => {
  const omega = 7 / settleSeconds;
  const dt = 1 / fps / substeps;
  const state = { z: 0, x: rest.x, y: rest.y, vz: 0, vx: 0, vy: 0 };
  const views: View[] = [];
  const total = Math.ceil(seconds * fps * substeps) + substeps;
  for (let i = 0; i <= total; i++) {
    const goal = goalAt(shots, clicks, i * dt, viewport);
    const z = springStep(state.z, state.vz, Math.log(goal.zoom), omega, dt);
    const x = springStep(state.x, state.vx, goal.x, omega, dt);
    const y = springStep(state.y, state.vy, goal.y, omega, dt);
    Object.assign(state, {
      z: z.position,
      vz: z.velocity,
      x: x.position,
      vx: x.velocity,
      y: y.position,
      vy: y.velocity,
    });
    views.push({ zoom: Math.exp(state.z), x: state.x, y: state.y });
  }
  return views;
};

export const speedOf = (a: View, b: View) =>
  Math.hypot((b.x - a.x) * b.zoom, (b.y - a.y) * b.zoom) +
  Math.abs(Math.log(b.zoom / a.zoom)) * frame[0];

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export interface Pointer {
  at: Point;
  opacity: number;
  ripple?: number;
}

export const idleHide = 1.6;

export const pointerAt = (moves: Move[], clicks: Click[], t: number, start: Point): Pointer => {
  let at = start;
  let last = -Infinity;
  for (const m of moves) {
    if (t < m.at) break;
    const p = Math.min(1, (t - m.at) / m.seconds);
    const e = smoother(p);
    const dx = m.to.x - m.from.x;
    const dy = m.to.y - m.from.y;
    const arc = Math.sin(Math.PI * e) * 0.06;
    at = { x: m.from.x + dx * e - dy * arc, y: m.from.y + dy * e + dx * arc };
    last = Math.max(last, m.at + m.seconds);
  }
  const next = moves.find((m) => m.at > t);
  for (const c of clicks) if (c.at <= t) last = Math.max(last, c.at);
  const shown = Math.min(1, Math.max(0, 1 - (t - last - idleHide) / 0.3));
  const coming = next ? Math.min(1, Math.max(0, 1 - (next.at - t) / 0.3)) : 0;
  const recent = clicks.findLast((c) => c.at <= t && t - c.at < 0.5);
  return {
    at,
    opacity: Math.max(shown, coming),
    ...(recent ? { ripple: (t - recent.at) / 0.5 } : {}),
  };
};
