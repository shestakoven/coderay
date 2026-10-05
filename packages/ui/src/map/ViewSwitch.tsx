import { MODE_LABEL, type MapMode } from '../plan-flow/map-mode';

export function ViewSwitch({ modes, mode, onMode }: { modes: MapMode[]; mode: MapMode; onMode: (mode: MapMode) => void }) {
  return (
    <div className="map-view" role="tablist" aria-label="Map view">
      {modes.map((candidate) => (
        <button key={candidate} role="tab" aria-selected={mode === candidate} className={mode === candidate ? 'on' : ''} onClick={() => onMode(candidate)}>{MODE_LABEL[candidate]}</button>
      ))}
    </div>
  );
}
