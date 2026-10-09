// Headers just long enough for the core to tell an image's type and size; no pixel data.
const u16be = (value: number) => [value >> 8, value & 0xff];
const u16le = (value: number) => [value & 0xff, value >> 8];
const u32be = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const u32le = (value: number) => [...u32be(value)].reverse();
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

export const png = (width: number, height: number): Buffer =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii('IHDR'), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]);

export const gif = (width: number, height: number): Buffer => Buffer.from([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0]);

function exif(orientation: number, order: 'II' | 'MM'): number[] {
  const u16 = order === 'II' ? u16le : u16be;
  const u32 = order === 'II' ? u32le : u32be;
  const body = [...ascii('Exif\0\0'), ...ascii(order), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0];
  return [0xff, 0xe1, ...u16be(body.length + 2), ...body];
}

export function jpeg(width: number, height: number, orientation?: { value: number; order: 'II' | 'MM' }): Buffer {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...(orientation ? exif(orientation.value, orientation.order) : []), ...sof0, 0xff, 0xd9]);
}

const riff = (chunk: number[]): Buffer => Buffer.from([...ascii('RIFF'), ...u32le(chunk.length + 4), ...ascii('WEBP'), ...chunk]);

export const webpLossy = (width: number, height: number): Buffer =>
  riff([...ascii('VP8 '), ...u32le(10), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]);

export function webpLossless(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  return riff([...ascii('VP8L'), ...u32le(5), 0x2f, ...u32le(bits >>> 0)]);
}

export const webpExtended = (width: number, height: number): Buffer => {
  const u24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
  return riff([...ascii('VP8X'), ...u32le(10), 0, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]);
};
