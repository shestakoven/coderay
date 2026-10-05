import { useEffect, useRef } from 'react';

// One tooltip for the whole window: any element with data-tip (and optionally data-sub and data-keys) gets it.
export function Tooltips() {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: number | undefined;
    const tip = element.current;
    if (!tip) return;
    const hide = () => {
      window.clearTimeout(timer);
      tip.classList.remove('on');
    };
    const over = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-tip]');
      if (!target) {
        hide();
        return;
      }
      window.clearTimeout(timer);
      // Once one tooltip is up, moving to the next control swaps it at once instead of waiting again.
      const show = () => {
        tip.replaceChildren();
        const text = document.createElement('div');
        text.textContent = target.dataset.tip ?? '';
        if (target.dataset.sub) {
          const sub = document.createElement('small');
          sub.textContent = target.dataset.sub;
          text.append(sub);
        }
        tip.append(text);
        for (const key of (target.dataset.keys ?? '').split(' ').filter(Boolean)) {
          const chip = document.createElement('kbd');
          chip.textContent = key;
          tip.append(chip);
        }
        const rect = target.getBoundingClientRect();
        tip.style.left = '0px';
        tip.style.top = '0px';
        const x = Math.min(Math.max(8, rect.left + rect.width / 2 - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8);
        const below = rect.bottom + 8;
        tip.style.left = `${x}px`;
        tip.style.top = `${below + tip.offsetHeight > window.innerHeight - 8 ? rect.top - tip.offsetHeight - 8 : below}px`;
        tip.classList.add('on');
      };
      if (tip.classList.contains('on')) show();
      else timer = window.setTimeout(show, 420);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mousedown', hide);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mousedown', hide);
      window.removeEventListener('blur', hide);
      window.clearTimeout(timer);
    };
  }, []);
  return <div className="ptip" ref={element} role="tooltip" />;
}
