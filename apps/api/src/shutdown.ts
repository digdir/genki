export interface Stoppable {
  stop(): void;
  drain(): Promise<void>;
}

export const drainBeforeExit = async (
  kernel: Stoppable,
  cases: Pick<Stoppable, 'drain'>,
  graceMs: number,
) => {
  kernel.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all([cases.drain(), kernel.drain()]), deadline]);
  } finally {
    clearTimeout(timer);
  }
};
