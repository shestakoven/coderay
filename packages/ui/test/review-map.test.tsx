import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewGraph } from '@ide/protocol';
import { ReviewMap, type ReviewMapProps } from '../src/history/review-map/ReviewMap';
import { fitStep } from '../src/history/review-map/review-map-model';

vi.mock('../src/history/review-map/ReviewMapCanvas', () => ({
  ReviewMapCanvas: ({ view }: { view: { parts: { id: string }[] } }) => <div data-testid="canvas">{view.parts.map((p) => p.id).join(',')}</div>,
}));

const graph: ReviewGraph = {
  parts: [
    { id: 'api', title: 'API', status: 'created', steps: [], outside: false, files: [{ path: 'app/api.py', op: '+', added: 4, removed: 0, step: 's1', external: false }], broken: [] },
    { id: 'db', title: 'DB', status: 'untouched', steps: [], outside: false, files: [], broken: [] },
  ],
  links: [{ from: 'api', to: 'db', state: 'new', count: 1, evidence: [] }],
  partial: 'The project map has no components yet, so every change is one part.',
};

const props: ReviewMapProps = {
  graph, loading: false, error: null, plan: null, root: '/p', reviewed: new Set<string>(), selectedPath: null, active: true,
  send: () => true, onSelectPath: () => undefined, onAccept: () => undefined, onOpenChat: () => undefined,
};
const html = (extra: Partial<ReviewMapProps>) => renderToStaticMarkup(<ReviewMap {...props} {...extra} />);

describe('ReviewMap', () => {
  it('draws the graph with context and shows the note that says it is partial', () => {
    const out = html({});
    expect(out).toContain('no components yet');
    expect(out).toContain('>api,db<');
  });

  it('says it is building while there is no graph yet, and shows the error when the request failed', () => {
    expect(html({ graph: null, loading: true })).toContain('Building the map');
    expect(html({ graph: null, error: 'the watchdog is unavailable' })).toContain('the watchdog is unavailable');
  });
});

describe('fitStep', () => {
  it('fits a layout only for the shape that is on screen, and once', () => {
    expect(fitStep(null, 'with', '')).toBe('wait');
    expect(fitStep('with', 'changed', 'with')).toBe('wait');
    expect(fitStep('with', 'with', '')).toBe('first');
    expect(fitStep('changed', 'changed', 'with')).toBe('fit');
    expect(fitStep('changed', 'changed', 'changed')).toBe('done');
  });
});
