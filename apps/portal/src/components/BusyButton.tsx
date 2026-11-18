import { Button, type ButtonProps } from '@digdir/designsystemet-react';
import type { MouseEvent } from 'react';

export type BusyButtonProps = Omit<ButtonProps, 'loading'> & {
  busy: boolean;
  busyLabel: string;
};

export const BusyButton = ({ busy, busyLabel, children, onClick, ...rest }: BusyButtonProps) => (
  <>
    <Button
      {...rest}
      loading={busy}
      aria-disabled={busy || rest['aria-disabled'] || undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      <span className="busy-label">
        <span className={busy ? 'busy-label-off' : undefined} aria-hidden={busy || undefined}>
          {children}
        </span>
        <span className={busy ? undefined : 'busy-label-off'} aria-hidden={!busy || undefined}>
          {busyLabel}
        </span>
      </span>
    </Button>
    <span role="status" className="visually-hidden">
      {busy ? busyLabel : ''}
    </span>
  </>
);
