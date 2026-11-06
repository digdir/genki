// Small DOM helpers the blocks share, one copy each. The same file in every block's branch, so
// the branches merge without a conflict.

/** Class names joined, the empty ones left out. */
export const classes = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(' ');

/** A click with the main button and no modifier: the host's to handle. Any other is the browser's. */
export const plainClick = (event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** Whether what is dragged holds files, not text or a link. */
export const hasFiles = (event: { dataTransfer: DataTransfer | null }) =>
  [...(event.dataTransfer?.types ?? [])].includes('Files');
