import { IMAGE_MEDIA_TYPES, MAX_CHAT_IMAGES, MAX_CLIENT_FRAME_BYTES, type ChatImage } from '@ide/protocol';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BASE64 = MAX_CLIENT_FRAME_BYTES - 1024 * 1024;

export interface Attachment extends ChatImage {
  id: string;
  name: string;
}

export interface AttachResult {
  attachments: Attachment[];
  problem: string | null;
}

const isImageType = (type: string): type is ChatImage['mediaType'] => (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);

export const imageFiles = (files: Iterable<File>): File[] => [...files].filter((file) => file.type.startsWith('image/'));

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function addAttachments(current: Attachment[], files: File[]): Promise<AttachResult> {
  const attachments = [...current];
  let problem: string | null = null;
  for (const file of files) {
    if (attachments.length >= MAX_CHAT_IMAGES) {
      problem = `At most ${MAX_CHAT_IMAGES} images per message.`;
      break;
    }
    const total = attachments.reduce((sum, item) => sum + item.data.length, 0);
    if (!isImageType(file.type)) problem = `${file.name || 'Image'}: only PNG, JPEG, GIF and WebP are supported.`;
    else if (file.size > MAX_IMAGE_BYTES) problem = `${file.name || 'Image'} is larger than 5 MB.`;
    else if (total + Math.ceil(file.size / 3) * 4 > MAX_TOTAL_BASE64) problem = 'Images together are too large to send.';
    else attachments.push({ id: crypto.randomUUID(), name: file.name || 'image', mediaType: file.type, data: await toBase64(file) });
  }
  return { attachments, problem };
}
