import { useEffect, type RefObject } from 'react';

// Closes a popup on Escape or on a press outside it; the control that opened it carries data-menu-anchor and aria-expanded and toggles it itself, while another popup's anchor closes it.
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: (reason: 'escape' | 'outside') => void): void {
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!ref.current?.contains(target) && target.closest('[data-menu-anchor]')?.getAttribute('aria-expanded') !== 'true') onClose('outside');
    };
    const key = (event: KeyboardEvent) => {
      // An Escape that ends an input method's composition is the composition's own.
      if (event.key === 'Escape' && !event.isComposing) {
        event.stopPropagation();
        onClose('escape');
      }
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [ref, onClose]);
}
