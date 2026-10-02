import { Background, ControlButton, Controls, MiniMap } from '@xyflow/react';
import { Icon } from '../layout/Icon';

// The two map views (components and C4) share one canvas so they read as the same surface.
export function MapBackground() {
  return <Background gap={24} />;
}

export function MapControls({ onFit, disabled = false }: { onFit: () => void; disabled?: boolean }) {
  return (
    <>
      <Controls showInteractive={false} showZoom={false} showFitView={false}>
        <ControlButton title="Fit View" aria-label="Fit View" disabled={disabled} onClick={onFit}>
          <Icon name="maximize" size={22} />
        </ControlButton>
      </Controls>
      <MiniMap pannable zoomable />
    </>
  );
}
