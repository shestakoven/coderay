import { describe, expect, it } from 'vitest';
import { textImagePaths } from '../src/chat/image-paths';

describe('image paths a message mentions', () => {
  it('finds image files named in prose, without the punctuation around them, and only with a directory', () => {
    const prose = {
      'Saved docs/shot.png.': ['docs/shot.png'],
      'see (out/a.JPG), then "b/c.jpeg";': ['out/a.JPG', 'b/c.jpeg'],
      'at ~/Desktop/x.webp!': ['~/Desktop/x.webp'],
      'open file:///tmp/y.gif?': ['file:///tmp/y.gif'],
      '[img/z.png]': ['img/z.png'],
      'a lone shot.png in a sentence': [],
      'https://example.com/a.png and //cdn.test/b.png': [],
      'docs/readme.md and src/app.png.ts': [],
    };
    expect(Object.fromEntries(Object.keys(prose).map((text) => [text, textImagePaths(text)]))).toEqual(prose);
  });
});
