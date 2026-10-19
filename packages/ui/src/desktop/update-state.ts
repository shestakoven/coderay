export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready';

// What the desktop shell tells the page about the update of the installed app.
export interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  percent: number | null;
  // Grows each time the shell offers the restart again, such as after a manual check.
  offers: number;
}

export interface DesktopBridge {
  update: {
    get(): Promise<UpdateState | null>;
    onChange(listener: (state: UpdateState) => void): () => void;
    restart(): Promise<void>;
  };
}

declare global {
  interface Window {
    coderayDesktop?: DesktopBridge;
  }
}

// "Later" hides the toast for the offer it answered; a newer offer shows it again.
export const updateToastVisible = (state: UpdateState | null, dismissedOffer: number | null): state is UpdateState =>
  state !== null && state.phase === 'ready' && state.offers !== dismissedOffer;
