import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ImageFailure, ImageMediaType } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { isMac } from '../project/shortcuts';
import { formatBytes, imageMeta, saveName, sourceOfKey } from './image-source';
import { IDLE, type ImageStore, type ImageView } from './image-store';
import { canPan, clampZoom, fitScale, isFitted, toggleScale, wheelFactor, zoomAt, ZOOM_STEP, type Point, type Size, type Zoom } from './viewer-zoom';
import './chat-images.css';

const FOCUSABLE = 'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';
const CLOSE_MS = 120;
const PLACEHOLDER: Size = { width: 320, height: 180 };

interface Shown {
  key: string;
  title: string;
  name: string;
  width?: number;
  height?: number;
  bytes?: number;
}

type CopyState = 'idle' | 'busy' | 'done' | 'failed';

interface Drag {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  onImage: boolean;
}

const numberOf = (value: string | undefined): number | undefined => (value ? Number(value) : undefined);

const shownOf = (thumbnail: HTMLElement): Shown => ({
  key: thumbnail.dataset.source ?? '',
  title: thumbnail.dataset.title || 'Image',
  name: thumbnail.dataset.name || 'image',
  width: numberOf(thumbnail.dataset.width),
  height: numberOf(thumbnail.dataset.height),
  bytes: numberOf(thumbnail.dataset.bytes),
});

const galleryOf = (log: HTMLElement): HTMLElement[] => [...log.querySelectorAll<HTMLElement>('[data-chat-image]')];

const reducedMotion = (): boolean => document.documentElement.dataset.motion === 'reduce';

const FAILURES: Record<ImageFailure, string> = {
  missing: 'The image is no longer there',
  'too-large': 'Too large to preview',
  'not-image': 'Not a supported image',
  unreadable: 'Could not load the image',
};

function useEntry(store: ImageStore, key: string): ImageView {
  const subscribe = useCallback((listener: () => void) => {
    const source = sourceOfKey(key);
    return source ? store.subscribe(key, source, listener) : () => undefined;
  }, [store, key]);
  return useSyncExternalStore(subscribe, () => store.view(key), () => IDLE);
}

async function pngBlob(url: string, mediaType: ImageMediaType): Promise<Blob> {
  const blob = await (await fetch(url)).blob();
  if (mediaType === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('The image could not be encoded.'))), 'image/png'));
}

// The chat's images in a full-window viewer: zoom, pan, and every image of the chat one arrow key away.
export function ImageViewer({ log, from, store, onClose }: { log: HTMLElement; from: HTMLElement; store: ImageStore; onClose: (thumbnail: HTMLElement) => void }) {
  const [items, setItems] = useState(() => galleryOf(log));
  const [current, setCurrent] = useState(from);
  // Null keeps the image fitted to the window as the window changes.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [smooth, setSmooth] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [stageSize, setStageSize] = useState<Size | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [copy, setCopy] = useState<CopyState>('idle');
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const drag = useRef<Drag | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const mac = useState(isMac)[0];
  const shown = shownOf(current);
  const view = useEntry(store, shown.key);
  const index = items.indexOf(current);
  const ready = view.status === 'ready' ? view : null;

  useEffect(() => {
    const observer = new MutationObserver(() => setItems((before) => {
      const next = galleryOf(log);
      return next.length === before.length && next.every((item, at) => item === before[at]) ? before : next;
    }));
    observer.observe(log, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [log]);

  useEffect(() => store.want(shown.key), [store, shown.key]);
  useEffect(() => {
    for (const neighbour of [items[index - 1], items[index + 1]]) {
      if (neighbour?.dataset.source) store.want(neighbour.dataset.source);
    }
  }, [store, items, index]);
  useEffect(() => {
    setZoom(null);
    setNatural(null);
    setSmooth(false);
  }, [shown.key]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setStageSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    dialog.current?.focus();
    return () => window.clearTimeout(closeTimer.current);
  }, []);

  const size: Size | null = ready?.image.width && ready.image.height
    ? { width: ready.image.width, height: ready.image.height }
    : natural ?? (shown.width && shown.height ? { width: shown.width, height: shown.height } : null);
  const margin = stageSize && stageSize.width < 560 ? 12 : 32;
  const fit = size && stageSize ? fitScale(size, stageSize, margin) : 1;
  const fitted: Zoom = { scale: fit, x: 0, y: 0 };
  const active = zoom && size && stageSize ? clampZoom(zoom, size, stageSize, fit) : fitted;
  const pannable = size !== null && stageSize !== null && canPan(active, size, stageSize);
  const loaded = ready !== null && loadedUrl === ready.url && size !== null;

  const update = (change: (zoom: Zoom) => Zoom, animate: boolean): void => {
    if (!size || !stageSize) return;
    setSmooth(animate);
    setZoom((previous) => {
      const next = change(previous ? clampZoom(previous, size, stageSize, fit) : fitted);
      return isFitted(next, fit) ? null : next;
    });
  };
  const zoomTo = (scale: number, at: Point, animate: boolean): void => {
    if (size && stageSize) update((base) => zoomAt(base, scale, at, size, stageSize, fit), animate);
  };
  const pointIn = (event: { clientX: number; clientY: number }): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const toggle = (at: Point = { x: 0, y: 0 }): void => zoomTo(toggleScale(active, fit), at, true);
  const go = (step: number): void => {
    const next = items[index + step];
    if (next) setCurrent(next);
  };
  const close = (): void => {
    if (closing) return;
    if (reducedMotion()) {
      onClose(current);
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => onClose(current), CLOSE_MS);
  };
  const copyImage = (): void => {
    if (!ready || copy === 'busy') return;
    const failed = (): void => {
      setCopy('failed');
      window.setTimeout(() => setCopy('idle'), 2200);
    };
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      failed();
      return;
    }
    setCopy('busy');
    navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(ready.url, ready.image.mediaType) })]).then(() => {
      setCopy('done');
      window.setTimeout(() => setCopy('idle'), 1600);
    }, failed);
  };
  const save = (): void => {
    if (!ready) return;
    const link = document.createElement('a');
    link.href = ready.url;
    link.download = saveName(shown.name, ready.image.mediaType);
    link.click();
  };

  const actions = useRef({ close, go, toggle, copyImage, save, zoomTo, active, fit });
  actions.current = { close, go, toggle, copyImage, save, zoomTo, active, fit };

  useEffect(() => {
    const trap = (event: KeyboardEvent): void => {
      const element = dialog.current;
      if (!element) return;
      const focusable = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const at = document.activeElement;
      if (!element.contains(at) || (event.shiftKey && (at === first || at === element))) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && at === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      const act = actions.current;
      const modified = event.metaKey || event.ctrlKey;
      const key = event.key;
      if (key === 'Tab') {
        trap(event);
        return;
      }
      if (key === 'Escape') act.close();
      else if (!modified && !event.altKey && key === 'ArrowLeft') act.go(-1);
      else if (!modified && !event.altKey && key === 'ArrowRight') act.go(1);
      else if (key === '+' || key === '=') act.zoomTo(act.active.scale * ZOOM_STEP, { x: 0, y: 0 }, true);
      else if (key === '-' || key === '_') act.zoomTo(act.active.scale / ZOOM_STEP, { x: 0, y: 0 }, true);
      else if (key === '0') act.zoomTo(act.fit, { x: 0, y: 0 }, true);
      else if (!modified && key === '1') act.zoomTo(1, { x: 0, y: 0 }, true);
      else if (!modified && (key === 'z' || key === 'Z')) act.toggle();
      else if (modified && !event.shiftKey && key.toLowerCase() === 'c' && !window.getSelection()?.toString()) act.copyImage();
      else if (modified && key.toLowerCase() === 's') act.save();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const wheel = useRef<(event: WheelEvent) => void>(() => undefined);
  wheel.current = (event) => {
    event.preventDefault();
    if (!size || !stageSize || !ready) return;
    if (event.ctrlKey || event.metaKey) zoomTo(active.scale * wheelFactor(event.deltaY, event.deltaMode), pointIn(event), false);
    else if (pannable) update((base) => clampZoom({ ...base, x: base.x - event.deltaX, y: base.y - event.deltaY }, size, stageSize, fit), false);
  };
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const listener = (event: WheelEvent) => wheel.current(event);
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, onImage: event.target === picture.current };
    if (pannable) event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = drag.current;
    if (!held || held.id !== event.pointerId) return;
    if (!held.moved && Math.hypot(event.clientX - held.startX, event.clientY - held.startY) > 4) {
      held.moved = true;
      if (pannable) setDragging(true);
    }
    if (held.moved && pannable && size && stageSize) {
      const dx = event.clientX - held.x;
      const dy = event.clientY - held.y;
      update((base) => clampZoom({ ...base, x: base.x + dx, y: base.y + dy }, size, stageSize, fit), false);
    }
    held.x = event.clientX;
    held.y = event.clientY;
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = drag.current;
    drag.current = null;
    setDragging(false);
    if (!held || held.moved || held.id !== event.pointerId) return;
    if (held.onImage) {
      if (loaded) toggle(pointIn(event));
    } else if (event.target === event.currentTarget) close();
  };

  const zoomed = !isFitted(active, fit);
  const cursor = dragging ? 'grabbing' : zoomed ? 'zoom-out' : toggleScale(active, fit) !== fit ? 'zoom-in' : 'default';
  const meta = imageMeta(size?.width, size?.height, ready?.image.bytes ?? shown.bytes);
  const placeholder = size && stageSize ? { width: size.width * fit, height: size.height * fit } : PLACEHOLDER;
  const modifier = mac ? '⌘' : 'Ctrl';
  const copyLabel = copy === 'done' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy';

  return createPortal(
    <div
      ref={dialog}
      className={`iv${closing ? ' closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer: ${shown.title}`}
      tabIndex={-1}
    >
      <header className="iv-bar">
        <div className="iv-title" aria-live="polite">
          <b title={shown.title}>{shown.title}</b>
          {meta && <span className="iv-meta">{meta}</span>}
        </div>
        {items.length > 1 && index >= 0 && <span className="iv-count" aria-label={`Image ${index + 1} of ${items.length}`}>{index + 1} / {items.length}</span>}
        <span className="iv-spacer" />
        <button type="button" className="iv-btn iv-zoom" onClick={() => toggle()} disabled={!loaded} data-tip={zoomed ? 'Fit to window' : 'Actual size'} data-keys="Z" aria-label={zoomed ? 'Fit to window' : 'Actual size'}>
          {Math.round(active.scale * 100)}%
        </button>
        <button type="button" className={`iv-btn${copy === 'done' ? ' done' : copy === 'failed' ? ' failed' : ''}`} onClick={copyImage} disabled={!ready} data-tip="Copy image" data-keys={`${modifier} C`} aria-label={copyLabel}>
          <Icon name={copy === 'done' ? 'check' : copy === 'failed' ? 'alert' : 'copy'} size={15} />
          <span className="iv-label">{copyLabel}</span>
        </button>
        <button type="button" className="iv-btn" onClick={save} disabled={!ready} data-tip="Save image" data-keys={`${modifier} S`} aria-label="Save image">
          <Icon name="download" size={15} />
          <span className="iv-label">Save</span>
        </button>
        <i className="iv-divider" />
        <button type="button" className="iv-btn iv-close" onClick={close} data-tip="Close" data-keys="Esc" aria-label="Close">
          <Icon name="close" size={17} />
        </button>
      </header>
      <div
        ref={stage}
        className={`iv-stage${dragging ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        {ready && (
          <img
            ref={picture}
            key={ready.url}
            className={`iv-img${loaded ? ' loaded' : ''}${smooth ? ' smooth' : ''}${active.scale >= 3 ? ' pixelated' : ''}`}
            src={ready.url}
            alt={shown.title}
            draggable={false}
            style={size ? { width: size.width, height: size.height, transform: `translate(-50%, -50%) translate(${active.x}px, ${active.y}px) scale(${active.scale})`, cursor } : undefined}
            onLoad={(event) => {
              const element = event.currentTarget;
              if (!size) setNatural({ width: element.naturalWidth, height: element.naturalHeight });
              setLoadedUrl(element.getAttribute('src'));
            }}
          />
        )}
        {view.status === 'failed' ? (
          <div className="iv-failed" role="alert">
            <Icon name="image-off" size={22} />
            <b>{FAILURES[view.reason]}</b>
            {view.reason === 'too-large' && shown.bytes !== undefined && <span>{formatBytes(shown.bytes)}</span>}
            {view.reason === 'unreadable' && <button type="button" className="iv-retry" onClick={() => store.retry(shown.key)}>Retry</button>}
          </div>
        ) : !loaded && (
          <div className="iv-loading" style={{ width: placeholder.width, height: placeholder.height }} role="status" aria-label="Loading the image">
            <span className="iv-spinner" />
          </div>
        )}
        {items.length > 1 && (
          <>
            <button type="button" className="iv-nav prev" onClick={() => go(-1)} disabled={index <= 0} aria-label="Previous image" data-tip="Previous" data-keys="←">
              <Icon name="chevron-left" size={22} />
            </button>
            <button type="button" className="iv-nav next" onClick={() => go(1)} disabled={index < 0 || index >= items.length - 1} aria-label="Next image" data-tip="Next" data-keys="→">
              <Icon name="chevron-right" size={22} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
