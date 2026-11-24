import type { KeyboardEvent } from 'react';
import { Icon, type IconComponent } from './Icon';

export interface LinkTab {
  key: string;
  label: string;
  href: string;
  count?: string | undefined;
  icon?: IconComponent | undefined;
}

const across: Record<string, (at: number, count: number) => number> = {
  ArrowRight: (at, count) => (at + 1) % count,
  ArrowLeft: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

const down: Record<string, (at: number, count: number) => number> = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

export const LinkTabs = ({
  label,
  tabs,
  current,
  className,
  orientation = 'horizontal',
}: {
  label: string;
  tabs: LinkTab[];
  current: string;
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}) => {
  const step = orientation === 'vertical' ? { ...across, ...down } : across;
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    const move = step[event.key];
    if (!move) return;
    event.preventDefault();
    const next = move(index, tabs.length);
    const list = event.currentTarget.closest('[role="tablist"]');
    list?.querySelectorAll<HTMLAnchorElement>('[role="tab"]')[next]?.focus();
    const target = tabs[next];
    if (target?.href.startsWith('#')) window.location.hash = target.href.slice(1);
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation={orientation === 'vertical' ? 'vertical' : undefined}
      className={['link-tabs', className].filter(Boolean).join(' ')}
    >
      {tabs.map((tab, i) => {
        const selected = tab.key === current;
        return (
          <a
            key={tab.key}
            role="tab"
            href={tab.href}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={tab.icon ? 'link-tab-with-icon' : undefined}
          >
            {tab.icon ? <Icon icon={tab.icon} /> : null}
            {tab.count === undefined ? (
              tab.label
            ) : (
              <>
                <span>{tab.label}</span> <span className="link-tab-count">{tab.count}</span>
              </>
            )}
          </a>
        );
      })}
    </div>
  );
};
