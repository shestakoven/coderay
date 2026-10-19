import { describe, expect, it } from 'vitest';
import type { ClientMessage, ImageFailure, ImageRef } from '@ide/protocol';
import { ImageStore } from '../src/chat/image-store';

type Get = Extract<ClientMessage, { type: 'image.get' }>;

const ref = (id: string, bytes = 10): ImageRef => ({ id, mediaType: 'image/png', bytes, width: 2, height: 2 });

function setup() {
  const sent: Get[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const store = new ImageStore((message) => {
    sent.push(message as Get);
    return true;
  }, {
    create: () => {
      created.push(`blob:${created.length + 1}`);
      return created.at(-1)!;
    },
    revoke: (url) => void revoked.push(url),
  });
  store.setOnline(true);
  const show = (key: string, scope?: string) => {
    const source = key.startsWith('i:') ? { id: key.slice(2) } : { path: key.slice(2) };
    const unsubscribe = store.subscribe(key, source, () => undefined);
    store.want(key, scope);
    return unsubscribe;
  };
  const answer = (at: number, image: ImageRef) => store.handle({ type: 'image.data', key: sent[at]!.key, image, data: btoa('png') });
  const fail = (at: number, reason: ImageFailure) => store.handle({ type: 'image.failed', key: sent[at]!.key, reason });
  return { store, sent, created, revoked, show, answer, fail };
}

describe('ImageStore requests', () => {
  it('asks once for an image however many thumbnails show it', () => {
    const { store, sent, show, answer } = setup();
    show('i:aa');
    show('i:aa');
    answer(0, ref('aa'));
    expect([sent.length, store.view('i:aa')]).toEqual([1, { status: 'ready', url: 'blob:1', image: ref('aa') }]);
  });

  it('shows the bytes it holds for a file the agent named under the image\'s id without asking again', () => {
    const { store, sent, show, answer } = setup();
    show('p:docs/a.png');
    answer(0, ref('aa'));
    show('i:aa');
    expect([sent.length, store.view('i:aa')]).toEqual([1, { status: 'ready', url: 'blob:1', image: ref('aa') }]);
  });

  it('asks again once for an unreadable image, and fails at once for every other reason', () => {
    const outcome = (reason: ImageFailure) => {
      const { store, sent, show, fail } = setup();
      show('p:a.png');
      fail(0, reason);
      if (sent.length > 1) fail(1, reason);
      return { asked: sent.length, view: store.view('p:a.png') };
    };
    expect((['unreadable', 'missing', 'too-large', 'not-image'] as const).map(outcome)).toEqual([
      { asked: 2, view: { status: 'failed', reason: 'unreadable' } },
      { asked: 1, view: { status: 'failed', reason: 'missing' } },
      { asked: 1, view: { status: 'failed', reason: 'too-large' } },
      { asked: 1, view: { status: 'failed', reason: 'not-image' } },
    ]);
  });

  it('gives every request its own key and ignores an answer to an earlier one', () => {
    const { store, sent, show, answer, fail } = setup();
    show('p:a.png');
    fail(0, 'unreadable');
    answer(0, ref('stale'));
    expect([new Set(sent.map((message) => message.key)).size, store.view('p:a.png')]).toEqual([2, { status: 'loading' }]);
    answer(1, ref('fresh'));
    expect(store.view('p:a.png')).toMatchObject({ status: 'ready', image: ref('fresh') });
  });

  it('fails a path too long to ask for as missing without asking', () => {
    const { store, sent, show } = setup();
    show(`p:${'a/'.repeat(2100)}x.png`);
    expect([sent.length, store.view(`p:${'a/'.repeat(2100)}x.png`)]).toEqual([0, { status: 'failed', reason: 'missing' }]);
  });

  it('asks for at most six images at a time and first again for those the socket lost', () => {
    const { store, sent, show, answer } = setup();
    for (let index = 1; index <= 8; index += 1) show(`p:${index}.png`);
    expect(sent.map((message) => message.path)).toEqual(['1.png', '2.png', '3.png', '4.png', '5.png', '6.png']);
    store.setOnline(false);
    store.setOnline(true);
    answer(6, ref('one'));
    expect(sent.slice(6).map((message) => message.path)).toEqual(['1.png', '2.png', '3.png', '4.png', '5.png', '6.png', '7.png']);
  });

  it('reads a shown file again for a newer message, keeping the old image until the new one comes', () => {
    const { store, sent, show, answer } = setup();
    show('p:shot.png', 'message-1');
    answer(0, ref('before'));
    store.want('p:shot.png', 'message-2');
    expect([sent.length, store.view('p:shot.png')]).toMatchObject([2, { status: 'ready', image: ref('before') }]);
    answer(1, ref('after'));
    expect(store.view('p:shot.png')).toMatchObject({ status: 'ready', image: ref('after') });
  });
});

describe('ImageStore cache', () => {
  it('revokes the object URL of an image nobody shows once the cache is over budget, and forgets it', () => {
    const { store, revoked, show, answer } = setup();
    const hide = show('i:big1');
    answer(0, ref('big1', 60 * 1024 * 1024));
    hide();
    show('i:big2');
    answer(1, ref('big2', 60 * 1024 * 1024));
    expect([revoked, store.view('i:big1'), store.view('i:big2').status]).toEqual([['blob:1'], { status: 'idle' }, 'ready']);
  });
});
