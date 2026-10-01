import type { PlanView } from '@ide/protocol';

export const chimeKey = (plan: PlanView | null): string | null => (plan?.status === 'proposed' ? `${plan.id}@${plan.version}` : null);

export interface Activity {
  chatId: string | null;
  busy: boolean;
}

// A chat opened or switched to while its agent is idle is not a finished run, and a run the user stopped needs no signal.
export const finishedWorking = (before: Activity | null, after: Activity, stoppedByUser: boolean): boolean =>
  !stoppedByUser && before !== null && before.chatId !== null && before.chatId === after.chatId && before.busy && !after.busy;

function play(frequencies: number[]): void {
  try {
    const context = new AudioContext();
    const start = context.currentTime;
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + index * 0.18;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.32);
    });
    setTimeout(() => void context.close(), 800);
  } catch {
    // no audio device or autoplay blocked: the UI still shows the state
  }
}

export const playChime = (): void => play([660, 880]);

export const playDone = (): void => play([880, 660]);
