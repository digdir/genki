import { useState } from 'react';

export const useEditBuffer = <Buffer, Slice>(
  slice: Slice,
  read: (slice: Slice) => Buffer,
  write: (buffer: Buffer) => Slice,
  onChange: (slice: Slice) => void,
): [Buffer, (buffer: Buffer) => void] => {
  const seen = JSON.stringify(slice);
  const [state, setState] = useState(() => ({ buffer: read(slice), seen }));
  let current = state;
  if (seen !== state.seen) {
    current = { buffer: read(slice), seen };
    setState(current);
  }
  const update = (buffer: Buffer) => {
    const next = write(buffer);
    setState({ buffer, seen: JSON.stringify(next) });
    onChange(next);
  };
  return [current.buffer, update];
};
