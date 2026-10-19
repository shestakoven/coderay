export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

// `x`/`y` move the image's centre away from the stage's centre, in screen pixels.
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export const MAX_SCALE = 16;
export const ZOOM_STEP = 1.25;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// The whole image inside the stage with a margin around it, never enlarged.
export function fitScale(image: Size, stage: Size, margin: number): number {
  const width = Math.max(1, stage.width - margin * 2);
  const height = Math.max(1, stage.height - margin * 2);
  return Math.min(1, width / image.width, height / image.height);
}

// An image smaller than the stage stays centred on that axis; a larger one cannot be dragged past its edges.
export function clampZoom(zoom: Zoom, image: Size, stage: Size, fit: number): Zoom {
  const scale = clamp(zoom.scale, fit, MAX_SCALE);
  const spanX = Math.max(0, (image.width * scale - stage.width) / 2);
  const spanY = Math.max(0, (image.height * scale - stage.height) / 2);
  return { scale, x: clamp(zoom.x, -spanX, spanX), y: clamp(zoom.y, -spanY, spanY) };
}

// Scales so the image point under `at` (relative to the stage centre) stays under it.
export function zoomAt(zoom: Zoom, scale: number, at: Point, image: Size, stage: Size, fit: number): Zoom {
  const next = clamp(scale, fit, MAX_SCALE);
  const ratio = next / zoom.scale;
  return clampZoom({ scale: next, x: at.x - (at.x - zoom.x) * ratio, y: at.y - (at.y - zoom.y) * ratio }, image, stage, fit);
}

export const canPan = (zoom: Zoom, image: Size, stage: Size): boolean =>
  image.width * zoom.scale > stage.width + 0.5 || image.height * zoom.scale > stage.height + 0.5;

export const isFitted = (zoom: Zoom, fit: number): boolean => Math.abs(zoom.scale - fit) < 1e-3;

// Fit and actual size; an image that fits at actual size toggles to double instead.
export const toggleScale = (zoom: Zoom, fit: number): number => (isFitted(zoom, fit) ? (fit < 1 ? 1 : 2) : fit);

// A pinch sends small deltas, a mouse wheel notch about a hundred: both zoom smoothly, neither jumps.
export const wheelFactor = (deltaY: number, deltaMode: number): number => Math.exp(-clamp(deltaY * (deltaMode === 1 ? 16 : 1), -60, 60) * 0.01);
