import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_IMAGE_BYTES, type ImageFailure, type ImageRef } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { observeNear, useChatImages, useImageView, type ChatImages } from './chat-images';
import { formatBytes, frameBox, isTooLarge, sourceKeyOf, type ImageSource } from './image-source';
import './chat-images.css';

const MAX_HEIGHT = { large: 280, small: 120 } as const;
// An image whose size the core could not tell: a 16:9 box until it decodes.
const UNKNOWN = { width: 240, height: 135 };
// Even a tiny icon gets a box big enough to click.
const MIN_SIDE = 40;

export interface ChatImageProps {
  source: ImageSource;
  image?: ImageRef;
  title: string;
  // The name Save offers.
  name: string;
  caption?: string;
  size: 'large' | 'small';
  scope?: string;
  // A path the agent mentioned in passing: shown only once it proves to be an image, silent when it is not.
  quiet?: boolean;
}

export function ChatImage(props: ChatImageProps) {
  const images = useChatImages();
  if (!images) return <span className="ci-plain">{props.caption ?? props.title}</span>;
  return <LiveImage {...props} images={images} />;
}

function LiveImage({ source, image, title, name, caption, size, scope, quiet = false, images }: ChatImageProps & { images: ChatImages }) {
  const key = sourceKeyOf(source);
  const view = useImageView(images.store, key, source);
  const slot = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const oversized = isTooLarge(image);
  const { store, live, settle, open } = images;

  useEffect(() => (slot.current ? observeNear(slot.current, setNear) : undefined), []);
  useEffect(() => {
    if (near && live && !oversized) store.want(key, scope);
  }, [near, live, oversized, store, key, scope]);
  useLayoutEffect(() => settle(), [view.status, settle]);

  const path = 'path' in source ? source.path : undefined;
  if (oversized || view.status === 'failed') {
    const reason: ImageFailure = view.status === 'failed' ? view.reason : 'too-large';
    const silent = quiet && (reason === 'missing' || reason === 'not-image');
    return (
      <span ref={slot} className="ci-slot">
        {!silent && <Failure reason={reason} bytes={image?.bytes} path={path} onRetry={() => store.retry(key)} />}
      </span>
    );
  }
  if (quiet && view.status !== 'ready') return <span ref={slot} className="ci-slot" />;

  const known = view.status === 'ready' ? view.image : image;
  const width = known?.width ?? natural?.width;
  const height = known?.height ?? natural?.height;
  // A named file's size is unknown until it is read: a slim line, the height of the failure it may turn into, holds its place.
  if (view.status !== 'ready' && width === undefined) {
    return (
      <span ref={slot} className="ci-slot">
        <span className="ci-pending" aria-busy="true"><Icon name="image" size={14} /><span>{caption ?? title}</span></span>
      </span>
    );
  }
  const box = width !== undefined && height !== undefined ? frameBox(width, height, MAX_HEIGHT[size]) : { ...UNKNOWN, crop: false };
  const loaded = view.status === 'ready' && loadedUrl === view.url;
  // A row of small images sizes each slot; a large one spans its line so a caption may run wider than the image.
  const sized = { width: `min(100%, ${Math.max(box.width, MIN_SIDE)}px)` };
  return (
    <span ref={slot} className={`ci-slot ci-${size}`} style={size === 'small' ? sized : undefined}>
      <button
        type="button"
        className={`ci-thumb${loaded ? ' loaded' : ''}${box.crop ? ' crop' : ''}`}
        style={size === 'large' ? sized : undefined}
        data-chat-image=""
        data-source={key}
        data-title={title}
        data-name={name}
        data-width={width}
        data-height={height}
        data-bytes={known?.bytes}
        aria-label={`Open image ${caption ?? title}`}
        aria-busy={!loaded}
        onClick={(event) => open(event.currentTarget)}
      >
        <span className="ci-frame" style={{ aspectRatio: `${box.width} / ${box.height}` }}>
          {view.status === 'ready' && (
            <img
              key={view.url}
              src={view.url}
              alt=""
              draggable={false}
              decoding="async"
              onLoad={(event) => {
                const element = event.currentTarget;
                if (width === undefined) setNatural({ width: element.naturalWidth, height: element.naturalHeight });
                setLoadedUrl(element.getAttribute('src'));
                settle();
              }}
            />
          )}
        </span>
      </button>
      {caption && <span className="ci-caption">{caption}</span>}
    </span>
  );
}

function failureText(reason: ImageFailure, bytes: number | undefined, named: boolean): string {
  switch (reason) {
    case 'missing':
      return named ? 'Image not found' : 'Image no longer available';
    case 'too-large':
      return `Too large to preview · ${bytes !== undefined ? formatBytes(bytes) : `over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB`}`;
    case 'not-image':
      return 'Not a supported image';
    case 'unreadable':
      return 'Could not load the image';
  }
}

function Failure({ reason, bytes, path, onRetry }: { reason: ImageFailure; bytes?: number; path?: string; onRetry: () => void }) {
  return (
    <span className={`ci-failed ${reason}`} role="note">
      <Icon name="image-off" size={14} />
      <span className="ci-failed-text">
        {failureText(reason, bytes, path !== undefined)}
        {path !== undefined && <> · <span className="ci-path">{path}</span></>}
      </span>
      {reason === 'unreadable' && <button type="button" className="ci-retry" onClick={onRetry}>Retry</button>}
    </span>
  );
}
