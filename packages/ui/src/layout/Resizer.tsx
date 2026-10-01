import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { KEY_STEP, KEY_STEP_LARGE } from './sizes';

export function Resizer({ orientation, label, value, min, max, grow, onResize, onReset }: {
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  grow: 1 | -1;
  onResize: (size: number) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ pointer: 0, size: 0 });
  const axis = orientation === 'vertical' ? 'clientX' : 'clientY';

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { pointer: event[axis], size: value };
    setDragging(true);
    document.body.classList.add('resizing', orientation);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    onResize(start.current.size + grow * (event[axis] - start.current.pointer));
  };
  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    document.body.classList.remove('resizing', orientation);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const forward = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const backward = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    if (event.key === forward) onResize(value + grow * step);
    else if (event.key === backward) onResize(value - grow * step);
    else if (event.key === 'Home') onResize(min);
    else if (event.key === 'End') onResize(max);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={`resizer ${orientation}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      title="Drag to resize, double-click to reset"
    />
  );
}
