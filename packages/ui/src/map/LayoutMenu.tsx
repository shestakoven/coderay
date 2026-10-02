import { useState } from 'react';
import { LAYOUT_CHOICES, type LayoutSettings } from './layout-settings';

const FIELDS: { key: keyof LayoutSettings; label: string; names: Record<string, string> }[] = [
  { key: 'direction', label: 'Direction', names: { RIGHT: 'Right', DOWN: 'Down', LEFT: 'Left', UP: 'Up' } },
  { key: 'algorithm', label: 'Algorithm', names: { layered: 'Layered', force: 'Force', stress: 'Stress', radial: 'Radial', mrtree: 'Tree' } },
  { key: 'edgeStyle', label: 'Edges', names: { smoothstep: 'Rounded', step: 'Orthogonal', straight: 'Straight', default: 'Curved' } },
  { key: 'detail', label: 'Detail', names: { compact: 'Compact', normal: 'Normal', full: 'Full' } },
  { key: 'density', label: 'Spacing', names: { tight: 'Tight', normal: 'Normal', loose: 'Loose' } },
];

export function LayoutMenu({ settings, onChange, fields }: { settings: LayoutSettings; onChange: (settings: LayoutSettings) => void; fields?: (keyof LayoutSettings)[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="map-layout">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Layout
      </button>
      {open && (
        <div className="map-layout-panel">
          {FIELDS.filter(({ key }) => !fields || fields.includes(key)).map(({ key, label, names }) => (
            <label key={key}>
              <span>{label}</span>
              <select value={settings[key]} onChange={(event) => onChange({ ...settings, [key]: event.target.value })}>
                {LAYOUT_CHOICES[key].map((choice) => (
                  <option key={choice} value={choice}>
                    {names[choice]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
