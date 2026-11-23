export interface FramedEdition {
  publisher: string;
  id: string;
  version: number;
  sha256: string;
}

export type BlockFrameUrl = (edition: FramedEdition) => string | undefined;

/** Where a code edition's frame is served; nowhere until a block origin is set up. */
export const blockFrameUrl: BlockFrameUrl = () => undefined;
