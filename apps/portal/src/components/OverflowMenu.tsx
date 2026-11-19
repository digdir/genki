import { Button } from '@digdir/designsystemet-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import './overflow-menu.css';

export interface OverflowItem {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  expanded?: boolean;
}

export const OverflowMenu = ({
  label,
  trigger,
  items,
}: {
  label: string;
  trigger: ReactNode;
  items: OverflowItem[];
}) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const entries = () => [
    ...(root.current?.querySelectorAll<HTMLButtonElement>('.overflow-item') ?? []),
  ];

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const step: Record<string, number> = {
      ArrowDown: (at + 1) % list.length,
      ArrowUp: (at - 1 + list.length) % list.length,
      Home: 0,
      End: list.length - 1,
    };
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key in step) {
      event.preventDefault();
      list[step[event.key] ?? 0]?.focus();
    }
  };

  return (
    <div className="overflow-menu" ref={root} onKeyDown={onKeyDown}>
      <Button
        ref={button}
        variant="tertiary"
        data-size="sm"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </Button>
      {open ? (
        <ul id={id} className="overflow-list" aria-label={label}>
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className="overflow-item"
                data-danger={item.danger ? 'true' : undefined}
                aria-expanded={item.expanded}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
