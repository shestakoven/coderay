import { describe, expect, it } from 'vitest';
import { userMessageText } from '../src/chat/image-source';

describe('userMessageText', () => {
  it('hides the attachment count line only when the message shows its images', () => {
    const cases: [text: string, images: number, shown: string][] = [
      ['look at this\n[2 images attached]', 2, 'look at this'],
      ['[1 image attached]', 1, ''],
      ['[1 image attached]', 0, '[1 image attached]'],
      ['I wrote [3 images attached] myself', 3, 'I wrote [3 images attached] myself'],
    ];
    expect(cases.map(([text, images]) => userMessageText(text, images))).toEqual(cases.map(([, , shown]) => shown));
  });
});
