export type ComposerAttachmentStatus = 'uploading' | 'ready' | 'failed';

/** Why a file was not attached. Only `failed` is worth trying again. */
export type ComposerAttachmentError = 'too-large' | 'wrong-type' | 'failed' | 'unavailable';

/** One file the question is being written with. */
export interface ComposerAttachment {
  /** The host's key for the file, stable from the moment it was picked. */
  id: string;
  name: string;
  status: ComposerAttachmentStatus;
  /** 0 to 100 while uploading. */
  progress?: number | undefined;
  error?: ComposerAttachmentError | undefined;
}

export interface ComposerAttachments {
  items: readonly ComposerAttachment[];
  /** Takes picked or dropped files. Without it the paperclip is drawn switched off, as coming soon. */
  onAdd?: ((files: File[]) => void) | undefined;
  onRemove: (id: string) => void;
  onRetry?: ((id: string) => void) | undefined;
  /** The file picker's `accept`, such as `.pdf,.docx`. */
  accept?: string | undefined;
  /** The file types as the reader knows them, such as `['PDF', '.docx']`. */
  fileTypes?: readonly string[] | undefined;
  maxMegabytes?: number | undefined;
}
