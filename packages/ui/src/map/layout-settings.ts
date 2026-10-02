export type Direction = 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';
export type Algorithm = 'layered' | 'force' | 'stress' | 'radial' | 'mrtree';
export type EdgeStyle = 'smoothstep' | 'step' | 'straight' | 'default';
export type Detail = 'compact' | 'normal' | 'full';
export type Density = 'tight' | 'normal' | 'loose';

export interface LayoutSettings {
  direction: Direction;
  algorithm: Algorithm;
  edgeStyle: EdgeStyle;
  detail: Detail;
  density: Density;
}

export const DEFAULT_LAYOUT: LayoutSettings = {
  direction: 'RIGHT',
  algorithm: 'layered',
  edgeStyle: 'smoothstep',
  detail: 'normal',
  density: 'normal',
};

export const LAYOUT_CHOICES: { [K in keyof LayoutSettings]: readonly LayoutSettings[K][] } = {
  direction: ['RIGHT', 'DOWN', 'LEFT', 'UP'],
  algorithm: ['layered', 'force', 'stress', 'radial', 'mrtree'],
  edgeStyle: ['smoothstep', 'step', 'straight', 'default'],
  detail: ['compact', 'normal', 'full'],
  density: ['tight', 'normal', 'loose'],
};

const SPACING: Record<Density, { node: number; layer: number }> = {
  tight: { node: 16, layer: 48 },
  normal: { node: 32, layer: 90 },
  loose: { node: 56, layer: 150 },
};

export const NODE_SIZES: Record<Detail, { component: { width: number; height: number }; file: { width: number; height: number } }> = {
  compact: { component: { width: 170, height: 44 }, file: { width: 130, height: 28 } },
  normal: { component: { width: 240, height: 72 }, file: { width: 170, height: 34 } },
  full: { component: { width: 280, height: 112 }, file: { width: 200, height: 40 } },
};

export function elkOptions(settings: LayoutSettings): Record<string, string> {
  const { node, layer } = SPACING[settings.density];
  const options: Record<string, string> = {
    'elk.algorithm': settings.algorithm,
    'elk.direction': settings.direction,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.spacing.nodeNode': String(node),
  };
  if (settings.algorithm === 'layered') {
    options['elk.layered.spacing.nodeNodeBetweenLayers'] = String(layer);
    options['elk.layered.crossingMinimization.strategy'] = 'LAYER_SWEEP';
    options['elk.layered.considerModelOrder.strategy'] = 'NONE';
  } else if (settings.algorithm === 'mrtree') {
    options['elk.mrtree.spacing.nodeNode'] = String(node);
  } else if (settings.algorithm === 'radial') {
    options['elk.radial.radius'] = String(layer);
  } else if (settings.algorithm === 'force') {
    options['elk.force.repulsion'] = String(node * 0.3);
  } else {
    options['elk.stress.desiredEdgeLength'] = String(layer + 100);
  }
  return options;
}

const STORAGE_KEY = 'ide.map-layout';

export function loadLayout(storage: Pick<Storage, 'getItem'> | undefined): LayoutSettings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const value = JSON.parse(raw) as Partial<Record<keyof LayoutSettings, unknown>>;
    const pick = <K extends keyof LayoutSettings>(key: K): LayoutSettings[K] =>
      (LAYOUT_CHOICES[key] as readonly unknown[]).includes(value[key]) ? (value[key] as LayoutSettings[K]) : DEFAULT_LAYOUT[key];
    return {
      direction: pick('direction'),
      algorithm: pick('algorithm'),
      edgeStyle: pick('edgeStyle'),
      detail: pick('detail'),
      density: pick('density'),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(storage: Pick<Storage, 'setItem'> | undefined, settings: LayoutSettings): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable or full: the setting only lasts for this session
  }
}

export function handlePositions(direction: Direction): { target: 'left' | 'right' | 'top' | 'bottom'; source: 'left' | 'right' | 'top' | 'bottom' } {
  switch (direction) {
    case 'RIGHT': return { target: 'left', source: 'right' };
    case 'LEFT': return { target: 'right', source: 'left' };
    case 'DOWN': return { target: 'top', source: 'bottom' };
    case 'UP': return { target: 'bottom', source: 'top' };
  }
}
