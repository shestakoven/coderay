import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DetailsSlot {
  element: HTMLElement | null;
  onShown: () => void;
  onHidden: () => void;
}

export const DetailsSlotContext = createContext<DetailsSlot>({ element: null, onShown: () => {}, onHidden: () => {} });

export function DetailsAside({ className = 'details', inline = false, children }: { className?: string; inline?: boolean; children: ReactNode }) {
  const slot = useContext(DetailsSlotContext);
  const portal = !inline && slot.element !== null;
  const { onShown, onHidden } = slot;
  useEffect(() => {
    if (!portal) return;
    onShown();
    return onHidden;
  }, [portal, onShown, onHidden]);
  const aside = <aside className={portal ? className.replace(/\bdetails\b/, 'details in-panel') : className}>{children}</aside>;
  return portal && slot.element ? createPortal(aside, slot.element) : aside;
}
