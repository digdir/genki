/** The width the preview draws the service at, as on an ordinary laptop screen. */
export const previewWidth = 1280;

/** The zoom that fits the service drawn at {@link previewWidth} to the space, within readable limits. */
export const previewScale = (available: number) =>
  available <= 0
    ? 1
    : Math.min(1.5, Math.max(0.5, Math.floor((available / previewWidth) * 1000) / 1000));
