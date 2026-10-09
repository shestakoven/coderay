import { MAX_IMAGE_BYTES, type ImageMediaType, type ImageRef } from '@ide/protocol';

// An image of the chat: a blob the core keeps for this chat, or a file the agent named.
export type ImageSource = { id: string } | { path: string };

export const MAX_REQUEST_KEY = 4096;

export const sourceKeyOf = (source: ImageSource): string => ('id' in source ? `i:${source.id}` : `p:${source.path}`);

export const requestKeyOf = (sourceKey: string, serial: number): string => `${sourceKey}#${serial}`;

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const isTooLarge = (image: ImageRef | undefined): boolean => image !== undefined && image.bytes > MAX_IMAGE_BYTES;

export function imageMeta(width: number | undefined, height: number | undefined, bytes: number | undefined): string {
  const parts: string[] = [];
  if (width !== undefined && height !== undefined) parts.push(`${width}×${height}`);
  if (bytes !== undefined) parts.push(formatBytes(bytes));
  return parts.join(' · ');
}

export function baseName(path: string): string {
  const plain = path.replace(/^file:\/\/[^/]*/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const last = plain.slice(plain.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const EXTENSIONS: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// A file name to save under: unsafe characters dropped, the extension matching the bytes.
export function saveName(name: string, mediaType: ImageMediaType): string {
  const extension = EXTENSIONS[mediaType];
  const clean = name.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[\s.]+$/g, '');
  const stem = clean.replace(/\.(?:png|jpe?g|gif|webp)$/i, '') || 'image';
  return `${stem}.${extension}`;
}

// The chat carries the attachment count as text for claude; the thumbnails say it better.
const ATTACHED = /(?:^|\n)\[\d+ images? attached\]$/;

export const userMessageText = (text: string, images: number): string => (images > 0 ? text.replace(ATTACHED, '') : text);

export interface FrameBox {
  width: number;
  height: number;
  crop: boolean;
}

// The thumbnail's box at most `maxHeight` tall, never upscaled; a sliver of a tall image shows its top instead.
export function frameBox(width: number, height: number, maxHeight: number): FrameBox {
  const scale = Math.min(1, maxHeight / height);
  const scaledWidth = width * scale;
  const cropWidth = Math.round(maxHeight * 0.6);
  if (scale < 1 && scaledWidth < cropWidth) {
    return { width: Math.min(width, cropWidth), height: maxHeight, crop: true };
  }
  return { width: Math.max(1, Math.round(scaledWidth)), height: Math.max(1, Math.round(height * scale)), crop: false };
}

export const sourceOfKey = (key: string): ImageSource | null => {
  if (key.startsWith('i:')) return { id: key.slice(2) };
  if (key.startsWith('p:')) return { path: key.slice(2) };
  return null;
};

const shortTool = (tool: string): string => (tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool);

// What the viewer calls an image a tool returned, and the name Save offers for it.
export function toolImageName(tool: string, targets: string[], index: number, count: number): string {
  const target = targets.length === 1 ? targets[0]! : '';
  const base = /\.(?:png|jpe?g|gif|webp)$/i.test(target) ? baseName(target) : shortTool(tool);
  return count > 1 ? `${base} ${index + 1}` : base;
}

export const attachmentName = (index: number, count: number): string => (count > 1 ? `Attachment ${index + 1}` : 'Attachment');
