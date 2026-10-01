import type { PlanView } from '@ide/protocol';

export const chimeKey = (plan: PlanView | null): string | null => (plan?.status === 'proposed' ? `${plan.id}@${plan.version}` : null);

export function playChime(): void {
  try {
    const context = new AudioContext();
    const start = context.currentTime;
    [660, 880].forEach((frequency, index) => {
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
    // no audio device or autoplay blocked: the plan panel still opens
  }
}
