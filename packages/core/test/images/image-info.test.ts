import { describe, expect, it } from 'vitest';
import { imageInfo } from '../../src/images/image-info';
import { gif, jpeg, png, webpExtended, webpLossless, webpLossy } from './bytes';

describe('imageInfo', () => {
  it('reads the type and the shown size of every supported format from its header', () => {
    const cases = {
      png: png(64, 40),
      gif: gif(3, 5),
      jpeg: jpeg(300, 200),
      'jpeg mirrored upright (orientation 4)': jpeg(300, 200, { value: 4, order: 'II' }),
      'jpeg on its side (orientation 5)': jpeg(300, 200, { value: 5, order: 'II' }),
      'jpeg on its side (orientation 6, little-endian exif)': jpeg(300, 200, { value: 6, order: 'II' }),
      'jpeg on its side (orientation 8, big-endian exif)': jpeg(300, 200, { value: 8, order: 'MM' }),
      // The top two bits of each VP8 dimension are a scale, not part of the size.
      'webp lossy': webpLossy(0xc000 | 300, 0x4000 | 150),
      'webp lossless': webpLossless(1000, 16383),
      'webp extended': webpExtended(70_000, 3),
    };
    expect(Object.fromEntries(Object.entries(cases).map(([name, bytes]) => [name, imageInfo(bytes)]))).toEqual({
      png: { mediaType: 'image/png', width: 64, height: 40 },
      gif: { mediaType: 'image/gif', width: 3, height: 5 },
      jpeg: { mediaType: 'image/jpeg', width: 300, height: 200 },
      'jpeg mirrored upright (orientation 4)': { mediaType: 'image/jpeg', width: 300, height: 200 },
      'jpeg on its side (orientation 5)': { mediaType: 'image/jpeg', width: 200, height: 300 },
      'jpeg on its side (orientation 6, little-endian exif)': { mediaType: 'image/jpeg', width: 200, height: 300 },
      'jpeg on its side (orientation 8, big-endian exif)': { mediaType: 'image/jpeg', width: 200, height: 300 },
      'webp lossy': { mediaType: 'image/webp', width: 300, height: 150 },
      'webp lossless': { mediaType: 'image/webp', width: 1000, height: 16383 },
      'webp extended': { mediaType: 'image/webp', width: 70_000, height: 3 },
    });
  });

  it('refuses bytes that are not an image and keeps only the type of an image whose size it cannot read', () => {
    const cases = {
      text: Buffer.from('not an image at all, just text'),
      'png signature cut short': png(1, 1).subarray(0, 7),
      'riff that is not webp': Buffer.from('RIFF\0\0\0\0WAVEfmt '),
      'png cut inside its header': png(64, 40).subarray(0, 18),
      'png of zero width': png(0, 40),
      'jpeg with no frame header': Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00]),
    };
    expect(Object.fromEntries(Object.entries(cases).map(([name, bytes]) => [name, imageInfo(bytes)]))).toEqual({
      text: null,
      'png signature cut short': null,
      'riff that is not webp': null,
      'png cut inside its header': { mediaType: 'image/png' },
      'png of zero width': { mediaType: 'image/png' },
      'jpeg with no frame header': { mediaType: 'image/jpeg' },
    });
  });
});
