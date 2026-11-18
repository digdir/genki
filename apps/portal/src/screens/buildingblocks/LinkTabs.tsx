import type { KeyboardEvent } from 'react';

export interface LinkTab {
  key: string;
  label: string;
  href: string;
}

const step: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_, n) => n - 1,
};

export const LinkTabs = ({
  label,
  tabs,
  current,
}: {
  label: string;
  tabs: LinkTab[];
  current: string;
}) => {
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    const move = step[event.key];
    if (!move) return;
    event.preventDefault();
    const next = move(index, tabs.length);
    const list = event.currentTarget.closest('[role="tablist"]');
    list?.querySelectorAll<HTMLAnchorElement>('[role="tab"]')[next]?.focus();
    const target = tabs[next];
    if (target) window.location.hash = target.href.replace(/^#/, '');
  };
  return (
    <div role="tablist" aria-label={label} className="bb-nav bb-tablist">
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
          >
            {tab.label}
          </a>
        );
      })}
    </div>
  );
};

export const BackLink = ({ label, href }: { label: string; href: string }) => (
  <a className="bb-back" href={href}>
    {label}
  </a>
);
