import {
  ArrowsSquarepathIcon,
  ChatIcon,
  CogIcon,
  ComponentIcon,
  CpuIcon,
  LayersIcon,
  SparklesIcon,
  DatabaseIcon,
  KeyHorizontalIcon,
  ShieldIcon,
  PuzzlePieceIcon,
  RobotSmileIcon,
  TasklistIcon,
  TestFlaskIcon,
} from '@navikt/aksel-icons';
import type { ComponentType, SVGProps } from 'react';

type IconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { title?: string; fontSize?: string | number }
>;

export const blockIcons: Record<string, IconComponent> = {
  'ki-gateway': ArrowsSquarepathIcon,
  'agent-runtime': RobotSmileIcon,
  rag: DatabaseIcon,
  evals: TestFlaskIcon,
  verktoy: PuzzlePieceIcon,
  definisjoner: TasklistIcon,
  kanaler: ChatIcon,
  plattform: LayersIcon,
  sprakmodeller: SparklesIcon,
  'ki-infrastruktur': CpuIcon,
  autentisering: KeyHorizontalIcon,
  tilgangsstyring: ShieldIcon,
};

export const typeIcons: Record<string, IconComponent> = {
  assistenter: ChatIcon,
  chatboter: RobotSmileIcon,
  apper: ComponentIcon,
  agenter: CogIcon,
};

export function TypeIcon({ id, className }: { id: string; className?: string }) {
  const Icon = typeIcons[id] ?? PuzzlePieceIcon;
  return <Icon aria-hidden className={className} />;
}

export function BlockIcon({ id, className }: { id: string; className?: string }) {
  const Icon = blockIcons[id] ?? PuzzlePieceIcon;
  return <Icon aria-hidden className={className} />;
}
