import { useT } from '../i18n';
import { Icon, icons } from './Icon';

export const StepList = ({
  steps,
  current,
  label,
}: {
  steps: readonly string[];
  current: number;
  label?: string;
}) => {
  const t = useT();
  return (
    <ol aria-label={label ?? t('components.steps')} className="step-list">
      {steps.map((step, i) => {
        const n = i + 1;
        const state = n === current ? 'current' : n < current ? 'done' : 'todo';
        return (
          <li key={step} aria-current={state === 'current' ? 'step' : undefined} data-state={state}>
            <span className="step-list-mark" aria-hidden="true">
              {state === 'done' ? <Icon d={icons.check} size={14} strokeWidth={2} /> : n}
            </span>
            {step}
            {state === 'done' ? (
              <span className="visually-hidden">{t('components.stepDone')}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};
