import { describe, expect, it } from 'vitest';
import { MODE_LABEL, availableModes, resolveMode, type MapMode, type ModeInput } from '../src/plan-flow/map-mode';

const BOTH: ModeInput = { hasC4: true, hasFlow: true };
const C4_ONLY: ModeInput = { hasC4: true, hasFlow: false };
const FLOW_ONLY: ModeInput = { hasC4: false, hasFlow: true };
const NEITHER: ModeInput = { hasC4: false, hasFlow: false };

describe('availableModes', () => {
  it('offers c4, components and flow, in that order, when the project has a C4 model and the plan has a flow', () => {
    expect(availableModes(BOTH)).toEqual(['c4', 'components', 'flow']);
  });

  it('offers c4 and components when the project has a C4 model but the plan has no flow', () => {
    expect(availableModes(C4_ONLY)).toEqual(['c4', 'components']);
  });

  it('offers components and flow when the plan has a flow but the project has no C4 model', () => {
    expect(availableModes(FLOW_ONLY)).toEqual(['components', 'flow']);
  });

  it('offers only components when there is neither a C4 model nor a flow', () => {
    expect(availableModes(NEITHER)).toEqual(['components']);
  });
});

describe('resolveMode without a preference', () => {
  it('picks c4 when the project has a C4 model and the plan has a flow', () => {
    expect(resolveMode(null, BOTH)).toBe('c4');
  });

  it('picks c4 when the project has a C4 model and the plan has no flow', () => {
    expect(resolveMode(null, C4_ONLY)).toBe('c4');
  });

  it('picks components when the project has no C4 model even if the plan has a flow', () => {
    expect(resolveMode(null, FLOW_ONLY)).toBe('components');
  });

  it('picks components when there is neither a C4 model nor a flow', () => {
    expect(resolveMode(null, NEITHER)).toBe('components');
  });
});

describe('resolveMode with a preferred c4', () => {
  it('keeps c4 when the project has a C4 model and the plan has a flow', () => {
    expect(resolveMode('c4', BOTH)).toBe('c4');
  });

  it('keeps c4 when the project has a C4 model and the plan has no flow', () => {
    expect(resolveMode('c4', C4_ONLY)).toBe('c4');
  });

  it('falls back to components when the project has no C4 model, even with a flow', () => {
    expect(resolveMode('c4', FLOW_ONLY)).toBe('components');
  });

  it('falls back to components when there is neither a C4 model nor a flow', () => {
    expect(resolveMode('c4', NEITHER)).toBe('components');
  });
});

describe('resolveMode with a preferred components', () => {
  it.each([
    ['a C4 model and a flow', BOTH],
    ['a C4 model and no flow', C4_ONLY],
    ['a flow and no C4 model', FLOW_ONLY],
    ['neither a C4 model nor a flow', NEITHER],
  ] as const)('keeps components with %s', (_name, input) => {
    expect(resolveMode('components', input)).toBe('components');
  });
});

describe('resolveMode with a preferred flow', () => {
  it('keeps flow when the project has a C4 model and the plan has a flow', () => {
    expect(resolveMode('flow', BOTH)).toBe('flow');
  });

  it('keeps flow when the plan has a flow and the project has no C4 model', () => {
    expect(resolveMode('flow', FLOW_ONLY)).toBe('flow');
  });

  it('falls back to c4 when the plan has no flow but the project has a C4 model', () => {
    expect(resolveMode('flow', C4_ONLY)).toBe('c4');
  });

  it('falls back to components when the plan has no flow and the project has no C4 model', () => {
    expect(resolveMode('flow', NEITHER)).toBe('components');
  });
});

describe('resolveMode result', () => {
  const preferences: (MapMode | null)[] = [null, 'c4', 'components', 'flow'];
  const inputs = [BOTH, C4_ONLY, FLOW_ONLY, NEITHER];

  it('is always one of the available modes', () => {
    for (const input of inputs) {
      for (const preferred of preferences) {
        expect(availableModes(input)).toContain(resolveMode(preferred, input));
      }
    }
  });
});

describe('MODE_LABEL', () => {
  it('labels the three modes C4, Components and Plan flow', () => {
    expect(MODE_LABEL).toEqual({ c4: 'C4', components: 'Components', flow: 'Plan flow' });
  });
});
