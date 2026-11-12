import type { ComponentType, SVGAttributes } from 'react';

export type IconComponent = ComponentType<SVGAttributes<SVGSVGElement>>;

/** A decorative Aksel icon at a fixed pixel size; the text beside it carries the meaning. */
export const Icon = ({ icon: Svg, size = 20 }: { icon: IconComponent; size?: number }) => (
  <Svg width={size} height={size} aria-hidden="true" focusable="false" style={{ flexShrink: 0 }} />
);
