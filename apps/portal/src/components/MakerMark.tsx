import type { ReactNode } from 'react';
import './maker-mark.css';

const petals = [0, 60, 120, 180, 240, 300];
const rays = [0, 45, 90, 135, 180, 225, 270, 315];
const pixelM = [
  [0, 0],
  [4, 0],
  [0, 1],
  [1, 1],
  [3, 1],
  [4, 1],
  [0, 2],
  [2, 2],
  [4, 2],
  [0, 3],
  [4, 3],
  [0, 4],
  [4, 4],
];

const marks: Record<string, ReactNode> = {
  openai: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6">
      {petals.map((angle) => (
        <rect
          key={angle}
          x="9.5"
          y="2.5"
          width="5"
          height="11"
          rx="2.5"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </g>
  ),
  anthropic: (
    <g stroke="#d97757" strokeWidth="2.4" strokeLinecap="round">
      {rays.map((angle, i) => (
        <line
          key={angle}
          x1="12"
          y1="12"
          x2="12"
          y2={i % 2 ? 4.5 : 2.5}
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </g>
  ),
  meta: (
    <path
      d="M12 12c-2.2-3.6-4-5.5-6-5.5S2.5 8.8 2.5 12s1.5 5.5 3.5 5.5 3.8-1.9 6-5.5 4-5.5 6-5.5 3.5 2.3 3.5 5.5-1.5 5.5-3.5 5.5-3.8-1.9-6-5.5z"
      fill="none"
      stroke="#1877f2"
      strokeWidth="2.2"
    />
  ),
  alibaba: (
    <g fill="none" stroke="#7c6cf2" strokeWidth="2" strokeLinejoin="round">
      <path d="M12 2.5 20.2 7.2v9.6L12 21.5l-8.2-4.7V7.2z" />
      <path d="M12 12V7m0 5 4.3 2.5M12 12l-4.3 2.5" strokeLinecap="round" />
    </g>
  ),
  'mistral ai': (
    <g fill="#fa520f">
      {pixelM.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={2 + (x ?? 0) * 4} y={2 + (y ?? 0) * 4} width="4" height="4" />
      ))}
    </g>
  ),
  google: (
    <path
      d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z"
      fill="#4285f4"
    />
  ),
  microsoft: (
    <g>
      <rect x="2.5" y="2.5" width="9" height="9" fill="#f25022" />
      <rect x="12.5" y="2.5" width="9" height="9" fill="#7fba00" />
      <rect x="2.5" y="12.5" width="9" height="9" fill="#00a4ef" />
      <rect x="12.5" y="12.5" width="9" height="9" fill="#ffb900" />
    </g>
  ),
  nbailab: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 6.5C10 5 6.5 4.5 3 5v13c3.5-.5 7 0 9 1.5 2-1.5 5.5-2 9-1.5V5c-3.5-.5-7 0-9 1.5z" />
      <path d="M12 6.5v13" />
    </g>
  ),
};

const neutral = (
  <path
    d="M12 3.5c.5 4.3 3.7 7.5 8 8-4.3.5-7.5 3.7-8 8-.5-4.3-3.7-7.5-8-8 4.3-.5 7.5-3.7 8-8z"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinejoin="round"
  />
);

export const hasMakerMark = (maker: string | undefined) =>
  !!maker && Object.hasOwn(marks, maker.toLowerCase());

export const MakerMark = ({
  maker,
  size = 'md',
}: {
  maker?: string | undefined;
  size?: 'sm' | 'md';
}) => (
  <span
    aria-hidden
    className={`maker-mark maker-mark-${size}${hasMakerMark(maker) ? '' : ' maker-mark-neutral'}`}
  >
    <svg viewBox="0 0 24 24" focusable="false">
      {maker && hasMakerMark(maker) ? marks[maker.toLowerCase()] : neutral}
    </svg>
  </span>
);
