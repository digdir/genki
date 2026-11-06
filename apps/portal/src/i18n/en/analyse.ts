import type { Translation } from '@genai/i18n';
import type { analyse as source } from '../nb/analyse';
import { architectureArea } from './analyse-architecture';

export const analyse = {
  ...architectureArea,
} satisfies Translation<typeof source>;
