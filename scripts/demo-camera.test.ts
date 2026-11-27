import { describe, expect, it } from 'vitest';
import { cameraPath, content, pointerAt, rest, springStep, viewOf } from './demo-camera.ts';

describe('spring camera', () => {
  it('settles on its target without overshooting', () => {
    let state = { position: 0, velocity: 0 };
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      state = springStep(state.position, state.velocity, 1, 7 / 0.9, 1 / 240);
      peak = Math.max(peak, state.position);
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(state.position).toBeGreaterThan(0.99);
  });

  it('moves smoothly: no frame jumps more than a small step during a zoom', () => {
    const target = { x: 200, y: 200, width: 600, height: 300 };
    const views = cameraPath([{ at: 1, zoom: 1.6, target }], [], 4, 60, [1920, 1080], 1);
    const steps = views.slice(1).map((v, i) => Math.abs(Math.log(v.zoom / (views[i]?.zoom ?? 1))));
    expect(Math.max(...steps)).toBeLessThan(0.03);
    expect(views.at(-1)?.zoom).toBeCloseTo(1.6, 2);
  });

  it('holds still before a move starts and after it has settled', () => {
    const views = cameraPath(
      [{ at: 2, zoom: 1.4, target: { x: 0, y: 0, width: 800, height: 400 } }],
      [],
      5,
      30,
      [1920, 1080],
      1,
    );
    expect(views[30]).toEqual(rest);
    const last = views.at(-1);
    const before = views.at(-2);
    expect(Math.abs((last?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(0.05);
  });

  it('keeps the frame inside the app window when it zooms near an edge', () => {
    const view = viewOf({ x: 0, y: 0, width: 300, height: 200 }, 1.6, [1920, 1080]);
    expect(view.x - 960 / view.zoom).toBeGreaterThanOrEqual(content.x - 1e-9);
    expect(view.y - 540 / view.zoom).toBeGreaterThanOrEqual(content.y - 1e-9);
  });
});

describe('drawn pointer', () => {
  const move = { at: 1, seconds: 1, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };

  it('glides along an eased path and arrives exactly', () => {
    expect(pointerAt([move], [], 1, { x: 0, y: 0 }).at.x).toBeCloseTo(0);
    expect(pointerAt([move], [], 2, { x: 0, y: 0 }).at.x).toBeCloseTo(100);
    const early = pointerAt([move], [], 1.1, { x: 0, y: 0 }).at.x;
    const middle = pointerAt([move], [], 1.5, { x: 0, y: 0 }).at.x;
    expect(early).toBeLessThan(5);
    expect(middle).toBeCloseTo(50, 0);
  });

  it('hides itself when it has been idle, and shows a ripple on a click', () => {
    expect(pointerAt([move], [], 2.5, { x: 0, y: 0 }).opacity).toBe(1);
    expect(pointerAt([move], [], 6, { x: 0, y: 0 }).opacity).toBe(0);
    expect(pointerAt([move], [{ at: 2.1, x: 100, y: 0 }], 2.2, { x: 0, y: 0 }).ripple).toBeCloseTo(
      0.2,
    );
  });
});
