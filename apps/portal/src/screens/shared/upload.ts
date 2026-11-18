import type { ChatPart, InputLimits } from '../../api/blocks';

const byExtension: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
};

const shortNames: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word (.docx)',
  'text/plain': 'TXT',
  'text/markdown': 'Markdown',
  'audio/mpeg': 'MP3',
  'audio/mp4': 'M4A',
  'audio/wav': 'WAV',
};

const extensionOf = (name: string) => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

export const mediaTypeOf = (file: Pick<File, 'name' | 'type'>) =>
  file.type || byExtension[extensionOf(file.name)] || '';

export const typeList = (limits: InputLimits) =>
  limits.accepts.map((type) => shortNames[type] ?? type).join(', ');

export const fileProblem = (file: Pick<File, 'name' | 'type' | 'size'>, limits: InputLimits) =>
  !limits.accepts.includes(mediaTypeOf(file))
    ? ('type' as const)
    : file.size > limits.max_bytes
      ? ('size' as const)
      : undefined;

const dataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });

export const filePart = async (file: File, audio: boolean): Promise<ChatPart> => {
  const url = await dataUrl(file);
  const type = mediaTypeOf(file);
  const withType = url.replace(/^data:[^;,]*/, `data:${type}`);
  return audio
    ? {
        type: 'input_audio',
        input_audio: {
          data: withType.slice(withType.indexOf(',') + 1),
          format: extensionOf(file.name),
        },
      }
    : { type: 'file', file: { filename: file.name, file_data: withType } };
};
