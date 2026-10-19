import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { IDLE, type ImageStore, type ImageView } from './image-store';
import type { ImageSource } from './image-source';

export interface ChatImages {
  store: ImageStore;
  // False while the chat is out of sight: nothing is fetched then.
  live: boolean;
  open: (thumbnail: HTMLElement) => void;
  // A thumbnail changed its height: a chat scrolled to the bottom stays there.
  settle: () => void;
}

export const ChatImagesContext = createContext<ChatImages | null>(null);

export const useChatImages = (): ChatImages | null => useContext(ChatImagesContext);

export function useImageView(store: ImageStore, key: string, source: ImageSource): ImageView {
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, source, listener), [store, key]);
  return useSyncExternalStore(subscribe, () => store.view(key), () => IDLE);
}

interface Watch {
  observer: IntersectionObserver;
  targets: Map<Element, (near: boolean) => void>;
}

const watches = new WeakMap<Element, Watch>();
// Starts fetching a little before an image scrolls into the chat.
const AHEAD = '600px 0px';

export function observeNear(target: Element, onChange: (near: boolean) => void): () => void {
  const root = target.closest('.chat-log');
  if (!root || typeof IntersectionObserver === 'undefined') {
    onChange(true);
    return () => undefined;
  }
  let watch = watches.get(root);
  if (!watch) {
    const targets = new Map<Element, (near: boolean) => void>();
    const observer = new IntersectionObserver((records) => {
      for (const record of records) targets.get(record.target)?.(record.isIntersecting);
    }, { root, rootMargin: AHEAD });
    watches.set(root, (watch = { observer, targets }));
  }
  const held = watch;
  held.targets.set(target, onChange);
  held.observer.observe(target);
  return () => {
    held.targets.delete(target);
    held.observer.unobserve(target);
  };
}
