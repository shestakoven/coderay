import { BLOCKS, type BlockId } from './categories';
import { Segmented, Setting, Toggle } from './controls';
import { FONT_SIZES, type Appearance, type Density } from './appearance';

const FONT_LABEL: Record<number, string> = { 12: 'Small', 13: 'Default', 14: 'Large', 15: 'Larger', 16: 'Largest' };

export const APPEARANCE_BLOCKS: BlockId[] = ['density', 'font-size', 'reduced-motion', 'canvas-dots'];

export function AppearanceBlock({ id, value, systemReducesMotion, onChange }: {
  id: BlockId;
  value: Appearance;
  systemReducesMotion: boolean;
  onChange: (next: Appearance) => void;
}) {
  const block = BLOCKS.find((candidate) => candidate.id === id)!;
  const reduced = value.reducedMotion ?? systemReducesMotion;
  const control = (() => {
    if (id === 'density') {
      return (
        <Segmented<Density>
          label="Density"
          value={value.density}
          onChange={(density) => onChange({ ...value, density })}
          options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
        />
      );
    }
    if (id === 'font-size') {
      return (
        <Segmented<string>
          label="Text size"
          value={String(value.fontSize)}
          onChange={(size) => onChange({ ...value, fontSize: Number(size) })}
          options={FONT_SIZES.map((size) => ({ value: String(size), label: FONT_LABEL[size] ?? String(size), hint: `${size}px` }))}
        />
      );
    }
    if (id === 'reduced-motion') {
      return <Toggle checked={reduced} label="Reduce motion" onChange={(next) => onChange({ ...value, reducedMotion: next })} />;
    }
    return <Toggle checked={value.canvasDots} label="Dots on the map" onChange={(next) => onChange({ ...value, canvasDots: next })} />;
  })();
  const note = id === 'reduced-motion' && value.reducedMotion === null ? ' Following your system setting until you change it.' : '';
  return <Setting id={id} title={block.title} help={`${block.help}${note}`} aside={control} />;
}
