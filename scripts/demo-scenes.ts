// Draws the film look's scenes: brand backgrounds, screen frame, title, chapter card, board, code and close.
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Image, SKRSContext2D } from '@napi-rs/canvas';
import {
  definitionIdPattern,
  itemCue,
  itemText,
  type BoardMark,
  type BoardScene,
  type CloseScene,
  type CodeScene,
  type DemoScene,
  type TitleScene,
} from '../packages/contracts/src/demo-scenes.ts';
import { filmFrame, frame, type Rect } from './demo-edl.ts';
import { wordsOf } from './demo-voice.ts';

const [W, H] = frame;

export const tokens = {
  accentBase: '#0062BA',
  accentTextDefault: '#002c54',
  accentTextSubtle: '#005db1',
  accentBackgroundTinted: '#eef4fa',
  accentSurfaceTinted: '#ddeaf6',
  accentBorderSubtle: '#99c0e3',
  neutralTextDefault: '#1f2c3d',
  neutralTextSubtle: '#545e6b',
  neutralBorderSubtle: '#b8bcc1',
  neutralBackgroundDefault: '#ffffff',
  darkAccentBackgroundDefault: '#0c1927',
  darkAccentBackgroundTinted: '#102033',
  darkAccentSurfaceTinted: '#172f4b',
  darkAccentBorderSubtle: '#285182',
  darkAccentTextDefault: '#e7edf4',
  darkAccentTextSubtle: '#8eaacb',
  darkAccentBase: '#4c91cf',
  darkNeutralBackgroundDefault: '#13181f',
  brand1Base: '#F45F63',
  brand2Base: '#E5AA20',
  brand3Base: '#1E98F5',
} as const;

export type Backdrop = 'light' | 'dark';

export const backdropOf = (template: DemoScene['template'] | 'chapter'): Backdrop =>
  template === 'screen' || template === 'board' ? 'light' : 'dark';

export const filmLayout = {
  frame: filmFrame,
  eyebrow: { x: 120, y: 54, size: 28 },
  title: { x: 120, y: 104, size: 52 },
  question: { y: 420, size: 80 },
  narrator: { x: 1716, y: 890, width: 168, height: 160 },
  caption: { bottom: 64, size: 40, maxWidth: 1300 },
  board: { x: 120, y: 235, column: 540, gap: 40 },
  code: { head: { x: 120, y: 250, width: 640 }, panel: { x: 820, y: 170, width: 980 } },
} as const;

export const sectionLabel = (index: number, chapter: string, language: string) =>
  `${language.startsWith('en') ? 'Part' : 'Del'} ${index} · ${chapter}`;

export interface TimedWord {
  text: string;
  at: number;
}

const plain = (word: string) => wordsOf(word)[0] ?? '';

export const cueTimes = (words: TimedWord[], cues: (string | undefined)[], from: number) => {
  let next = 0;
  let last = from;
  return cues.map((cue) => {
    const wanted = cue ? plain(cue) : '';
    const hit = wanted
      ? words.findIndex((w, i) => i >= next && plain(w.text).startsWith(wanted))
      : -1;
    if (hit >= 0) {
      next = hit + 1;
      last = (words[hit] as TimedWord).at;
      return last;
    }
    last += cue ? 0.12 : 0;
    return last;
  });
};

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 4);
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const appear = (t: number, at: number, seconds = 0.45, rise = 20) => ({
  alpha: smooth((t - at) / (seconds * 0.7)),
  dy: (1 - ease((t - at) / seconds)) * rise,
});

const fontsOf = {
  regular: (size: number) => `400 ${size}px Inter`,
  medium: (size: number) => `500 ${size}px Inter`,
  semibold: (size: number) => `600 ${size}px Inter`,
  bold: (size: number) => `700 ${size}px Inter`,
  mono: (size: number) => `400 ${size}px Menlo, "DejaVu Sans Mono", monospace`,
};

export const softHyphen = '­';

export const wrapText = (ctx: SKRSContext2D, text: string, maxWidth: number) => {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line
      ? `${line} ${word.replaceAll(softHyphen, '')}`
      : word.replaceAll(softHyphen, '');
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      if (!line && ctx.measureText(candidate).width > maxWidth && word.includes(softHyphen)) {
        const [head, ...tail] = word.split(softHyphen);
        lines.push(`${head ?? ''}-`);
        line = tail.join('');
      } else line = candidate;
    } else {
      lines.push(line);
      line = word.replaceAll(softHyphen, '');
    }
  }
  if (line) lines.push(line);
  return lines;
};

export interface Assets {
  lockupDark: Image;
  emblem: Image;
}

export interface Draw {
  ctx: SKRSContext2D;
  assets: Assets;
  language: string;
}

const withAlpha = (ctx: SKRSContext2D, alpha: number, paint: () => void) => {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  paint();
  ctx.restore();
};

const text = (
  ctx: SKRSContext2D,
  value: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: 'left' | 'center' | 'right' = 'left',
) => {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(value, x, y);
};

const pill = (ctx: SKRSContext2D, r: Rect, radius: number, fill: string, stroke?: string) => {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
};

export const paintBackdrop = (ctx: SKRSContext2D, kind: Backdrop) => {
  const base = ctx.createLinearGradient(0, 0, W * 0.4, H);
  if (kind === 'light') {
    base.addColorStop(0, tokens.neutralBackgroundDefault);
    base.addColorStop(1, tokens.accentBackgroundTinted);
  } else {
    base.addColorStop(0, tokens.darkAccentBackgroundTinted);
    base.addColorStop(1, tokens.darkAccentBackgroundDefault);
  }
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  const glows =
    kind === 'light'
      ? ([
          [W * 0.92, H * 0.05, 900, 'rgba(0,98,186,0.10)'],
          [W * 0.05, H * 1.0, 800, 'rgba(30,152,245,0.08)'],
        ] as const)
      : ([
          [W * 0.85, H * 0.1, 1000, 'rgba(0,98,186,0.45)'],
          [W * 0.1, H * 0.95, 900, 'rgba(30,152,245,0.16)'],
        ] as const);
  for (const [x, y, r, color] of glows) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
};

export const paintEyebrow = (draw: Draw, label: string, t: number, dark = false) => {
  const { ctx } = draw;
  const { x, y, size } = filmLayout.eyebrow;
  const a = appear(t, 0.05, 0.5, 10);
  withAlpha(ctx, a.alpha, () => {
    ctx.save();
    ctx.letterSpacing = `${size * 0.06}px`;
    text(
      ctx,
      label.toUpperCase(),
      x,
      y + a.dy,
      fontsOf.bold(size),
      dark ? tokens.brand3Base : tokens.accentTextSubtle,
    );
    ctx.restore();
  });
};

export const paintSceneTitle = (draw: Draw, title: string, t: number, at: number) => {
  const { ctx } = draw;
  const { x, y, size } = filmLayout.title;
  const a = appear(t, at, 0.6, 14);
  withAlpha(ctx, a.alpha, () => {
    ctx.save();
    ctx.letterSpacing = `${-size * 0.02}px`;
    text(ctx, title, x, y + a.dy, fontsOf.semibold(size), tokens.accentTextDefault);
    ctx.restore();
  });
};

export const paintQuestion = (
  draw: Draw,
  question: string,
  t: number,
  at: number,
  until: number,
) => {
  const { ctx } = draw;
  const { y, size } = filmLayout.question;
  const a = appear(t, at, 0.6, 18);
  const out = smooth((t - (until - 0.45)) / 0.4);
  withAlpha(ctx, a.alpha * (1 - out), () => {
    ctx.save();
    ctx.letterSpacing = `${-size * 0.025}px`;
    ctx.font = fontsOf.semibold(size);
    const lines = wrapText(ctx, question, W - 240);
    lines.forEach((line, i) =>
      text(
        ctx,
        line,
        W / 2,
        y + a.dy - out * 14 + i * size * 1.12,
        fontsOf.semibold(size),
        tokens.accentTextDefault,
        'center',
      ),
    );
    ctx.restore();
  });
};

export const frameEntrance = (t: number, at: number) => appear(t, at, 0.8, 24);

export const paintFrameShell = (ctx: SKRSContext2D, r: Rect, alpha: number, dy: number) =>
  withAlpha(ctx, alpha, () => {
    ctx.save();
    ctx.shadowColor = 'rgba(0,44,84,0.14)';
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 20;
    pill(ctx, { ...r, y: r.y + dy }, 12, tokens.neutralBackgroundDefault);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x - 0.5, r.y + dy - 0.5, r.width + 1, r.height + 1, 12.5);
    ctx.lineWidth = 1;
    ctx.strokeStyle = tokens.neutralBorderSubtle;
    ctx.stroke();
    ctx.restore();
  });

export const paintTag = (ctx: SKRSContext2D, label: string, r: Rect, dy: number) => {
  ctx.save();
  ctx.font = fontsOf.regular(28);
  const w = ctx.measureText(label).width + 28;
  const x = r.x + r.width - 16 - w;
  const y = r.y + dy + r.height - 14 - 46;
  pill(ctx, { x, y, width: w, height: 46 }, 23, 'rgba(19,24,31,0.8)');
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 14, y + 24);
  ctx.restore();
};

export const paintRing = (ctx: SKRSContext2D, r: Rect, alpha: number) =>
  withAlpha(ctx, alpha, () => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x - 6, r.y - 6, r.width + 12, r.height + 12, 12);
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(244,95,99,0.22)';
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = tokens.brand1Base;
    ctx.stroke();
    ctx.restore();
  });

export const mascotCrop = { x: 0, y: 0, width: 385, height: 358 };

export const paintNarrator = (draw: Draw, shown: number) => {
  const { ctx, assets } = draw;
  const n = filmLayout.narrator;
  if (shown <= 0) return;
  const dy = (1 - ease(shown)) * 260;
  ctx.drawImage(
    assets.lockupDark,
    mascotCrop.x,
    mascotCrop.y,
    mascotCrop.width,
    mascotCrop.height,
    n.x,
    n.y + dy,
    n.width,
    (n.width * mascotCrop.height) / mascotCrop.width,
  );
};

export const paintCaption = (ctx: SKRSContext2D, caption: string, alpha: number) =>
  withAlpha(ctx, alpha, () => {
    const { bottom, size, maxWidth } = filmLayout.caption;
    ctx.font = fontsOf.regular(size);
    const lines = wrapText(ctx, caption, maxWidth - 52);
    const lineHeight = size * 1.3;
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 52;
    const height = lines.length * lineHeight + 24;
    const y = H - bottom - height;
    pill(ctx, { x: W / 2 - width / 2, y, width, height }, 12, 'rgba(19,24,31,0.86)');
    lines.forEach((l, i) =>
      text(
        ctx,
        l,
        W / 2,
        y + 12 + i * lineHeight + (lineHeight - size) / 2,
        fontsOf.regular(size),
        '#ffffff',
        'center',
      ),
    );
  });

export interface ChapterCard {
  chapters: string[];
  current: number;
}

export const chapterRows = (count: number) => {
  const gap = Math.min(150, 620 / Math.max(1, count - 1));
  return { top: count > 4 ? 200 : 380, gap, size: Math.min(84, gap * 0.56) };
};

export const paintChapterCard = (draw: Draw, card: ChapterCard, t: number, seconds: number) => {
  const { ctx } = draw;
  const enter = appear(t, 0.05, 0.45, 16);
  const leave = smooth((t - (seconds - 0.34)) / 0.3);
  withAlpha(ctx, enter.alpha * (1 - leave), () => {
    const x = 300;
    const { top, gap, size } = chapterRows(card.chapters.length);
    const y = top + enter.dy - leave * 16;
    card.chapters.forEach((title, i) => {
      const n = i + 1;
      const dimmed = n !== card.current;
      const fade = n < card.current ? 1 - 0.68 * smooth((t - 0.35) / 0.4) : dimmed ? 0.32 : 1;
      withAlpha(ctx, fade, () => {
        text(ctx, String(n), x, y + i * gap + size * 0.36, fontsOf.bold(40), tokens.brand3Base);
        ctx.save();
        ctx.letterSpacing = `${-size * 0.025}px`;
        text(ctx, title, x + 100, y + i * gap, fontsOf.semibold(size), '#ffffff');
        ctx.restore();
      });
    });
    const bar = ease((t - 0.35) / 0.6);
    ctx.fillStyle = tokens.brand3Base;
    ctx.beginPath();
    ctx.roundRect(x + 100, y + (card.current - 1) * gap + size * 1.33, 600 * bar, 5, 3);
    ctx.fill();
  });
};

export interface SceneClock {
  t: number;
  start: number;
  end: number;
  words: TimedWord[];
}

const centreTiles = [
  [560, 330],
  [1100, 330],
  [560, 590],
  [1100, 590],
  [290, 460],
  [1370, 460],
] as const;

export const paintTitleScene = (draw: Draw, scene: TitleScene, clock: SceneClock) => {
  const { ctx, assets } = draw;
  const { t, start, end } = clock;
  const local = t - start;
  const items = scene.items ?? [];
  const at = cueTimes(clock.words, items.map(itemCue), start + 0.3);
  const leave = smooth((t - (end - 0.32)) / 0.3);
  ctx.save();
  ctx.globalAlpha *= 1 - leave;
  if (scene.logo) {
    const firstItem = items.length ? (at[0] as number) : Infinity;
    const lift = ease((t - (firstItem - 0.8)) / 0.6);
    const reveal = appear(local, 0.05, 0.6, 20);
    const h = 240 * (1 - 0.2 * lift);
    const w = (h * assets.lockupDark.width) / assets.lockupDark.height;
    withAlpha(ctx, reveal.alpha, () =>
      ctx.drawImage(assets.lockupDark, W / 2 - w / 2, 250 + reveal.dy - lift * 110, w, h),
    );
    if (scene.subtitle) {
      const sub = appear(local, 0.9, 0.45, 20);
      withAlpha(ctx, sub.alpha, () =>
        text(
          ctx,
          scene.subtitle as string,
          W / 2,
          590 + sub.dy - lift * 170,
          fontsOf.regular(40),
          tokens.darkAccentTextSubtle,
          'center',
        ),
      );
    }
    const width = items.length * 244 - 24;
    const left = W / 2 - width / 2;
    items.forEach((item, i) => {
      const a = appear(t, (at[i] as number) - 0.4, 0.5, -20);
      withAlpha(ctx, a.alpha, () => {
        pill(
          ctx,
          { x: left + i * 244, y: 690 + a.dy, width: 220, height: 84 },
          12,
          tokens.brand3Base,
        );
        text(
          ctx,
          itemText(item),
          left + i * 244 + 110,
          690 + a.dy + 26,
          fontsOf.bold(28),
          tokens.accentTextDefault,
          'center',
        );
      });
    });
    if (scene.base && items.length) {
      const a = appear(t, (at[0] as number) - 0.5, 0.45, 20);
      withAlpha(ctx, a.alpha, () => {
        pill(ctx, { x: left, y: 794 + a.dy, width, height: 96 }, 14, tokens.darkAccentTextDefault);
        text(
          ctx,
          scene.base as string,
          W / 2,
          794 + a.dy + 30,
          fontsOf.bold(30),
          tokens.accentTextDefault,
          'center',
        );
      });
    }
  } else {
    if (scene.title) {
      const a = appear(local, 0.05, 0.45, 20);
      withAlpha(ctx, a.alpha, () => {
        ctx.save();
        ctx.letterSpacing = `${-64 * 0.02}px`;
        text(ctx, scene.title as string, 120, 110 + a.dy, fontsOf.semibold(64), '#ffffff');
        ctx.restore();
      });
    }
    if (scene.centre) {
      const a = appear(t, (at[0] ?? start + 0.4) - 0.6, 0.45, 0);
      const s = 0.9 + 0.1 * ease((t - ((at[0] ?? start + 0.4) - 0.6)) / 0.45);
      withAlpha(ctx, a.alpha, () => {
        ctx.save();
        ctx.translate(960, 525);
        ctx.scale(s, s);
        pill(ctx, { x: -150, y: -55, width: 300, height: 110 }, 14, tokens.brand3Base);
        text(
          ctx,
          scene.centre as string,
          0,
          -20,
          fontsOf.bold(34),
          tokens.accentTextDefault,
          'center',
        );
        ctx.restore();
      });
    }
    const row = !scene.centre;
    const rowWidth = items.length * 300 - 40;
    items.forEach((item, i) => {
      const [x, y] = row ? [W / 2 - rowWidth / 2 + i * 300, 460] : (centreTiles[i] ?? [560, 850]);
      const a = appear(t, (at[i] as number) - 0.08, 0.35, 14);
      withAlpha(ctx, a.alpha, () => {
        pill(
          ctx,
          { x, y: y + a.dy, width: 260, height: 66 },
          33,
          tokens.darkAccentSurfaceTinted,
          tokens.darkAccentBorderSubtle,
        );
        text(
          ctx,
          itemText(item),
          x + 130,
          y + a.dy + 15,
          fontsOf.semibold(32),
          '#ffffff',
          'center',
        );
      });
    });
    if (scene.subtitle) {
      const a = appear(local, 0.6, 0.45, 20);
      withAlpha(ctx, a.alpha, () =>
        text(
          ctx,
          scene.subtitle as string,
          150,
          830 + a.dy,
          fontsOf.regular(40),
          tokens.darkAccentTextSubtle,
        ),
      );
    }
  }
  ctx.restore();
};

const markColour: Record<BoardMark, string> = {
  done: tokens.accentBase,
  now: tokens.brand3Base,
  next: tokens.brand2Base,
};

const paintMark = (ctx: SKRSContext2D, mark: BoardMark, x: number, y: number) => {
  ctx.save();
  ctx.translate(x + 15, y + 15);
  ctx.beginPath();
  if (mark === 'next') {
    ctx.setLineDash([5, 4]);
    ctx.arc(0, 0, 12.5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = markColour.next;
    ctx.stroke();
  } else {
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fillStyle = markColour[mark];
    ctx.fill();
    ctx.beginPath();
    if (mark === 'done') {
      ctx.moveTo(-6, 0.6);
      ctx.lineTo(-2, 4.6);
      ctx.lineTo(6.2, -3.6);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    } else {
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  }
  ctx.restore();
};

export const boardColumnX = (i: number) =>
  filmLayout.board.x + i * (filmLayout.board.column + filmLayout.board.gap);

export const paintBoardScene = (draw: Draw, scene: BoardScene, clock: SceneClock) => {
  const { ctx } = draw;
  const { t, start, end } = clock;
  const leave = smooth((t - (end - 0.32)) / 0.3);
  const cues = scene.columns.flatMap((c) => c.items.map(itemCue));
  const at = cueTimes(clock.words, cues, start + 0.3);
  ctx.save();
  ctx.globalAlpha *= 1 - leave;
  paintSceneTitleAt(draw, scene.title, t, start + 0.1, 58);
  let k = 0;
  scene.columns.forEach((column, ci) => {
    const x = boardColumnX(ci);
    const times = column.items.map(() => at[k++] as number);
    const head = appear(t, (times[0] as number) - 0.2);
    withAlpha(ctx, head.alpha, () => {
      paintMark(ctx, column.mark, x, filmLayout.board.y + head.dy + 6);
      text(
        ctx,
        column.title,
        x + 44,
        filmLayout.board.y + head.dy,
        fontsOf.bold(40),
        tokens.accentTextDefault,
      );
      ctx.fillStyle = markColour[column.mark];
      ctx.fillRect(x, filmLayout.board.y + head.dy + 66, filmLayout.board.column, 3);
    });
    let y = filmLayout.board.y + 69 + 24;
    column.items.forEach((item, ii) => {
      ctx.font = fontsOf.regular(33);
      const lines = wrapText(ctx, itemText(item), filmLayout.board.column - 44);
      const a = appear(t, (times[ii] as number) - 0.15, 0.45, 0);
      const dx = -12 * (1 - ease((t - ((times[ii] as number) - 0.15)) / 0.45));
      withAlpha(ctx, a.alpha * head.alpha, () => {
        paintMark(ctx, column.mark, x + dx, y + 3);
        lines.forEach((l, li) =>
          text(ctx, l, x + 44 + dx, y + li * 42, fontsOf.regular(33), tokens.neutralTextDefault),
        );
      });
      y += lines.length * 42 + 24;
    });
  });
  ctx.restore();
};

const paintSceneTitleAt = (draw: Draw, title: string, t: number, at: number, size: number) => {
  const { ctx } = draw;
  const a = appear(t, at, 0.42, 20);
  withAlpha(ctx, a.alpha, () => {
    ctx.save();
    ctx.letterSpacing = `${-size * 0.02}px`;
    text(
      ctx,
      title,
      filmLayout.title.x,
      filmLayout.title.y + a.dy,
      fontsOf.semibold(size),
      tokens.accentTextDefault,
    );
    ctx.restore();
  });
};

export const maxDefinitionBytes = 64 * 1024;

const examplesDir = new URL('../packages/definitions/examples/', import.meta.url);

const exampleFile = (id: string) => {
  if (!definitionIdPattern.test(id)) return undefined;
  const file = new URL(`${id}.yaml`, examplesDir);
  return file.href.startsWith(examplesDir.href) ? file : undefined;
};

export const exampleExists = (id: string) => {
  const file = exampleFile(id);
  return file !== undefined && existsSync(file);
};

export const definitionExcerpt = (id: string, lines = 13) => {
  const file = exampleFile(id);
  if (!file) throw new Error(`${id} is not an example definition`);
  if (statSync(file).size > maxDefinitionBytes)
    throw new Error(`The example ${id} is more than ${maxDefinitionBytes} bytes`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .slice(0, lines)
    .map((l) => (l.length > 52 ? `${l.slice(0, 51)}…` : l));
};

const yamlKey = /^(\s*)(- )?([\w-]+)(:)(.*)$/;

export const paintCodeScene = (
  draw: Draw,
  scene: CodeScene,
  clock: SceneClock,
  excerpt: string[],
) => {
  const { ctx } = draw;
  const { t, start, end } = clock;
  const leave = smooth((t - (end - 0.32)) / 0.3);
  const { head, panel } = filmLayout.code;
  const cue = cueTimes(
    clock.words,
    [plain(scene.title.replaceAll(softHyphen, ''))],
    start + 0.6,
  )[0] as number;
  ctx.save();
  ctx.globalAlpha *= 1 - leave;
  const a = appear(t, start + 0.2);
  withAlpha(ctx, a.alpha, () => {
    let y = head.y + a.dy;
    if (scene.eyebrow) {
      ctx.save();
      ctx.letterSpacing = `${28 * 0.06}px`;
      text(ctx, scene.eyebrow.toUpperCase(), head.x, y, fontsOf.bold(28), tokens.brand3Base);
      ctx.restore();
      y += 28 + 14;
    }
    ctx.font = fontsOf.semibold(72);
    ctx.save();
    ctx.letterSpacing = `${-72 * 0.025}px`;
    for (const line of wrapText(ctx, scene.title, head.width)) {
      text(ctx, line, head.x, y, fontsOf.semibold(72), '#ffffff');
      y += 76;
    }
    ctx.restore();
    if (scene.text) {
      y += 30;
      ctx.font = fontsOf.regular(36);
      for (const line of wrapText(ctx, scene.text, head.width)) {
        text(ctx, line, head.x, y, fontsOf.regular(36), tokens.darkAccentTextSubtle);
        y += 48.6;
      }
    }
  });
  const p = appear(t, cue - 0.2, 0.7, 0);
  const dx = 30 * (1 - ease((t - (cue - 0.2)) / 0.7));
  withAlpha(ctx, p.alpha, () => {
    const height = 64 + 44 + excerpt.length * 42;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 20;
    pill(
      ctx,
      { x: panel.x + dx, y: panel.y, width: panel.width, height },
      12,
      tokens.darkNeutralBackgroundDefault,
    );
    ctx.restore();
    text(
      ctx,
      `examples/${scene.definition}.yaml, ${draw.language.startsWith('en') ? 'excerpt' : 'utdrag'}`,
      panel.x + dx + 24,
      panel.y + 16,
      fontsOf.mono(26),
      tokens.darkAccentTextSubtle,
    );
    ctx.fillStyle = tokens.darkAccentBorderSubtle;
    ctx.fillRect(panel.x + dx, panel.y + 63, panel.width, 1);
    excerpt.forEach((line, i) => {
      const y = panel.y + 64 + 22 + i * 42;
      const m = yamlKey.exec(line);
      let x = panel.x + dx + 28;
      const put = (value: string, color: string) => {
        text(ctx, value, x, y, fontsOf.mono(28), color);
        x += ctx.measureText(value).width;
      };
      if (m) {
        put(`${m[1] ?? ''}${m[2] ?? ''}`, tokens.darkAccentTextDefault);
        put(m[3] ?? '', tokens.brand3Base);
        put(`${m[4] ?? ''}${m[5] ?? ''}`, tokens.darkAccentTextDefault);
      } else put(line, tokens.darkAccentTextDefault);
    });
  });
  ctx.restore();
};

export const paintCloseScene = (draw: Draw, scene: CloseScene, clock: SceneClock) => {
  const { ctx, assets } = draw;
  const { t, start } = clock;
  const local = t - start;
  const lock = appear(local, 0, 0.7, 20);
  const h = 214;
  const w = (h * assets.lockupDark.width) / assets.lockupDark.height;
  withAlpha(ctx, lock.alpha, () =>
    ctx.drawImage(assets.lockupDark, W / 2 - w / 2, 270 + lock.dy, w, h),
  );
  if (scene.question) {
    const q = appear(local, 0.3);
    withAlpha(ctx, q.alpha, () =>
      text(
        ctx,
        scene.question as string,
        W / 2,
        560 + q.dy,
        fontsOf.regular(44),
        tokens.darkAccentTextSubtle,
        'center',
      ),
    );
  }
  const actionWord = scene.action?.split(/\s+/)[0];
  const cue = cueTimes(clock.words, [actionWord ?? scene.address], start + 1.2)[0] as number;
  const c = appear(t, cue - 0.15, 0.6, 16);
  withAlpha(ctx, c.alpha, () => {
    ctx.font = fontsOf.bold(48);
    const pillWidth = ctx.measureText(scene.address).width + 80;
    ctx.font = fontsOf.regular(44);
    const actionWidth = scene.action ? ctx.measureText(scene.action).width + 24 : 0;
    const left = W / 2 - (actionWidth + pillWidth) / 2;
    if (scene.action)
      text(ctx, scene.action, left, 650 + c.dy + 26, fontsOf.regular(44), '#ffffff');
    pill(
      ctx,
      { x: left + actionWidth, y: 650 + c.dy, width: pillWidth, height: 98 },
      49,
      '#ffffff',
    );
    text(
      ctx,
      scene.address,
      left + actionWidth + 40,
      650 + c.dy + 24,
      fontsOf.bold(48),
      tokens.accentTextDefault,
    );
  });
  const owner = appear(t, clock.end - Math.max(1.5, (clock.end - start) * 0.25));
  withAlpha(ctx, owner.alpha, () => {
    const label = draw.language.startsWith('en')
      ? 'Norwegian Digitalisation Agency'
      : 'Digitaliseringsdirektoratet';
    ctx.font = fontsOf.regular(30);
    const width = 44 + 16 + ctx.measureText(label).width;
    const left = W / 2 - width / 2;
    ctx.drawImage(assets.emblem, left, 900 + owner.dy, 44, 44);
    text(ctx, label, left + 60, 900 + owner.dy + 6, fontsOf.regular(30), '#ffffff');
  });
};

export const paintScene = (
  draw: Draw,
  scene: DemoScene,
  clock: SceneClock,
  excerpt: string[] = [],
) => {
  if (scene.template === 'title') paintTitleScene(draw, scene, clock);
  else if (scene.template === 'board') paintBoardScene(draw, scene, clock);
  else if (scene.template === 'code') paintCodeScene(draw, scene, clock, excerpt);
  else if (scene.template === 'close') paintCloseScene(draw, scene, clock);
};
