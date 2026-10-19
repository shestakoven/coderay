import { describe, expect, it } from 'vitest';
import { clampZoom, fitScale, MAX_SCALE, toggleScale, zoomAt, type Point, type Zoom } from '../src/chat/viewer-zoom';

const image = { width: 1000, height: 800 };
const stage = { width: 500, height: 400 };
const fit = 0.5;
const fitted: Zoom = { scale: fit, x: 0, y: 0 };
// The image pixel, from its centre, that sits under a stage point.
const pixelUnder = (zoom: Zoom, at: Point): Point => ({ x: (at.x - zoom.x) / zoom.scale, y: (at.y - zoom.y) / zoom.scale });

describe('viewer zoom', () => {
  it('keeps the image pixel under the cursor in place as it zooms', () => {
    const at = { x: 100, y: -50 };
    const zoomed = zoomAt(fitted, 2, at, image, stage, fit);
    expect(zoomed.scale).toBe(2);
    expect(pixelUnder(zoomed, at)).toEqual(pixelUnder(fitted, at));
  });

  it('holds the scale between fit and the maximum and the pan inside the image, centring an axis that fits', () => {
    expect([
      zoomAt(fitted, 100, { x: 0, y: 0 }, image, stage, fit).scale,
      zoomAt({ scale: 2, x: 300, y: 300 }, 0.01, { x: 0, y: 0 }, image, stage, fit),
      clampZoom({ scale: 1, x: 9999, y: 9999 }, { width: 1000, height: 100 }, stage, 0.5),
      // The window grew past a zoom: the fit it can no longer go below.
      clampZoom({ scale: 0.2, x: 0, y: 0 }, image, stage, fit).scale,
      clampZoom({ scale: 40, x: 0, y: 0 }, image, stage, fit).scale,
    ]).toEqual([MAX_SCALE, fitted, { scale: 1, x: 250, y: 0 }, fit, MAX_SCALE]);
  });

  it('fits a large image inside the margin without enlarging a small one, and Z goes between fit and actual size', () => {
    expect([
      fitScale(image, stage, 10),
      fitScale({ width: 10, height: 10 }, stage, 10),
      toggleScale(fitted, fit),
      toggleScale({ scale: 1, x: 0, y: 0 }, fit),
      toggleScale({ scale: 1, x: 0, y: 0 }, 1),
    ]).toEqual([0.475, 1, 1, fit, 2]);
  });
});
