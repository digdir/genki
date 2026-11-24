import { EmptyState } from '@genai/ui-blocks';
import { useT } from './i18n.js';

/** A placeholder where the layout pins a block this host cannot draw. */
export const BlockPlaceholder = ({ blockRef, level = 3 }: { blockRef: string; level?: 2 | 3 }) => {
  const t = useT();
  return (
    <EmptyState
      title={t('assembly.unavailableBlock')}
      description={t('assembly.unavailableBlockHelp', { ref: blockRef })}
      level={level}
    />
  );
};
