// The film's camera and pointer: a critically damped spring towards each shot, sampled per frame.
import { frame, windowStage, type Shot, type Stage } from './demo-edl.ts';
import type { Click, Move } from './demo-events.ts';
import type { Box, Point } from './demo-pointer.ts';

export { filmStage, windowStage, type Stage } from './demo-edl.ts';

export const content = windowStage.page;

export interface View {
  zoom: number;
  x: number;
  y: number;
}

export const restOf = (stage: Stage): View => ({
  zoom: 1,
  x: stage.window.x + stage.window.width / 2,
  y: stage.window.y + stage.window.height / 2,
});

export const rest: View = restOf(windowStage);

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

export const onScreen = (p: Point, viewport: [number, number], stage = windowStage): Point => {
  const { page } = stage;
  const k = page.width / viewport[0];
  return { x: page.x + p.x * k, y: page.y + p.y * k };
};

export const viewOf = (
  target: Box | undefined,
  zoom: number,
  viewport: [number, number],
  stage = windowStage,
): View => {
  if (!target || zoom <= 1) return restOf(stage);
  const { page, window } = stage;
  const centre = onScreen(
    { x: target.x + target.width / 2, y: target.y + target.height / 2 },
    viewport,
    stage,
  );
  const clamp = (v: number, lo: number, hi: number) =>
    lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
  return {
    zoom,
    x: clamp(
      centre.x,
      page.x + window.width / 2 / zoom,
      page.x + page.width - window.width / 2 / zoom,
    ),
    y: clamp(
      centre.y,
      page.y + window.height / 2 / zoom,
      page.y + page.height - window.height / 2 / zoom,
    ),
  };
};

export const placeOf = (p: Point, view: View, stage = windowStage): Point => {
  const centre = restOf(stage);
  return { x: centre.x + (p.x - view.x) * view.zoom, y: centre.y + (p.y - view.y) * view.zoom };
};

export const clickPull = 1.06;

const goalAt = (
  shots: Shot[],
  clicks: { at: number; x: number; y: number }[],
  t: number,
  viewport: [number, number],
  stage: Stage,
) => {
  const shot = shots.findLast((s) => s.at <= t);
  const view = viewOf(shot?.target, shot?.zoom ?? 1, viewport, stage);
  if (view.zoom > 1) return view;
  const click = clicks.find((c) => t >= c.at - 0.45 && t <= c.at + 0.3);
  if (!click) return view;
  const p = onScreen(click, viewport, stage);
  const r = restOf(stage);
  return { zoom: clickPull, x: r.x + (p.x - r.x) * 0.35, y: r.y + (p.y - r.y) * 0.35 };
};

export const settleSeconds = 0.9;

export const cameraPath = (
  shots: Shot[],
  clicks: { at: number; x: number; y: number }[],
  seconds: number,
  fps: number,
  viewport: [number, number],
  substeps = 4,
  stage = windowStage,
): View[] => {
  const omega = 7 / settleSeconds;
  const dt = 1 / fps / substeps;
  const start = restOf(stage);
  const state = { z: 0, x: start.x, y: start.y, vz: 0, vx: 0, vy: 0 };
  const views: View[] = [];
  const total = Math.ceil(seconds * fps * substeps) + substeps;
  for (let i = 0; i <= total; i++) {
    const goal = goalAt(shots, clicks, i * dt, viewport, stage);
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
