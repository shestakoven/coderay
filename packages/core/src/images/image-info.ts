import type { ImageMediaType } from '@ide/protocol';

export interface ImageInfo {
  mediaType: ImageMediaType;
  width?: number;
  height?: number;
}

type Size = [width: number, height: number];

// The SOF markers that carry a frame's size; C4, C8 and CC share the range but are other segments.
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const EXIF_ORIENTATION = 0x0112;

// The type comes from the magic bytes alone, never from a name or a claimed type; the size is best-effort.
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mediaType = sniff(view);
  if (mediaType === null) return null;
  const size = dimensions(view, mediaType);
  return size && size[0] > 0 && size[1] > 0 ? { mediaType, width: size[0], height: size[1] } : { mediaType };
}

function sniff(view: DataView): ImageMediaType | null {
  const length = view.byteLength;
  if (length >= 8 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) return 'image/png';
  if (length >= 3 && view.getUint16(0) === 0xffd8 && view.getUint8(2) === 0xff) return 'image/jpeg';
  if (length >= 6 && (tag(view, 0, 6) === 'GIF87a' || tag(view, 0, 6) === 'GIF89a')) return 'image/gif';
  if (length >= 12 && tag(view, 0, 4) === 'RIFF' && tag(view, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

function dimensions(view: DataView, mediaType: ImageMediaType): Size | null {
  try {
    switch (mediaType) {
      case 'image/png':
        return tag(view, 12, 4) === 'IHDR' ? [view.getUint32(16), view.getUint32(20)] : null;
      case 'image/gif':
        return [view.getUint16(6, true), view.getUint16(8, true)];
      case 'image/jpeg':
        return jpegSize(view);
      case 'image/webp':
        return webpSize(view);
    }
  } catch (error) {
    // A header cut short reads past the end.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function jpegSize(view: DataView): Size | null {
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    if (marker === 0xe1) {
      const segment = new DataView(view.buffer, view.byteOffset + offset + 4, Math.min(length - 2, view.byteLength - offset - 4));
      orientation = exifOrientation(segment) ?? orientation;
    }
    if (JPEG_FRAMES.has(marker)) {
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      // Browsers turn a photo by its EXIF orientation, so 5 to 8 show it on its side.
      return orientation >= 5 && orientation <= 8 ? [height, width] : [width, height];
    }
    offset += 2 + length;
  }
  return null;
}

// Reads only the APP1 segment it is given: a broken EXIF block loses the orientation, not the size.
function exifOrientation(segment: DataView): number | null {
  try {
    if (tag(segment, 0, 6) !== 'Exif\0\0') return null;
    const order = tag(segment, 6, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const little = order === 'II';
    const ifd = 6 + segment.getUint32(10, little);
    const entries = segment.getUint16(ifd, little);
    for (let index = 0; index < entries; index += 1) {
      const entry = ifd + 2 + index * 12;
      if (segment.getUint16(entry, little) === EXIF_ORIENTATION) return segment.getUint16(entry + 8, little);
    }
    return null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function webpSize(view: DataView): Size | null {
  switch (tag(view, 12, 4)) {
    case 'VP8 ':
      if (view.getUint8(23) !== 0x9d || view.getUint8(24) !== 0x01 || view.getUint8(25) !== 0x2a) return null;
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    case 'VP8L': {
      if (view.getUint8(20) !== 0x2f) return null;
      const bits = view.getUint32(21, true);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    case 'VP8X':
      return [uint24(view, 24) + 1, uint24(view, 27) + 1];
    default:
      return null;
  }
}

const uint24 = (view: DataView, at: number): number => view.getUint16(at, true) | (view.getUint8(at + 2) << 16);

function tag(view: DataView, at: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(view.getUint8(at + index));
  return text;
}
