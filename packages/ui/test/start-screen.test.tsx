import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialBrowse } from '../src/project/browse-state';
import { StartScreen } from '../src/project/StartScreen';
import { initialStart, type StartWork } from '../src/project/start-state';

const render = (work: StartWork): string =>
  renderToStaticMarkup(
    <StartScreen
      info={{ root: null, name: '', home: '/home/u', recent: [] }}
      status="open"
      browse={{ state: initialBrowse, dispatch: () => undefined }}
      start={{ ...initialStart, view: 'clone', work }}
      dispatchStart={() => undefined}
      send={() => true}
    />,
  );

const bar = (html: string): string => /<div class="progress[^"]*"[^>]*>(<i[^>]*>)/.exec(html)?.[1] ?? '';

describe('clone progress bar', () => {
  it('has no inline width while the percentage is unknown, so the indeterminate animation shows', () => {
    const html = render({ kind: 'clone', requestId: 'r', phase: null, percent: null });
    expect(html).toContain('class="progress indeterminate"');
    expect(bar(html)).toBe('<i>');
  });

  it('is as wide as the percentage once it is known', () => {
    const html = render({ kind: 'clone', requestId: 'r', phase: 'receiving', percent: 40 });
    expect(html).not.toContain('indeterminate');
    expect(bar(html)).toContain('width:40%');
  });
});
