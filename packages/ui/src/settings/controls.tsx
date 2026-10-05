import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../layout/Icon';

export function Toggle({ checked, onChange, label, disabled = false }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="sw-toggle" disabled={disabled} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export function Segmented<T extends string>({ value, options, onChange, label, disabled = false }: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent, index: number): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    (group.current?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div ref={group} className="sw-seg" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={option.value === value ? 'on' : ''}
          disabled={disabled}
          title={option.hint}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => move(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Setting({ id, title, help, aside, children, wide = false }: {
  id: string;
  title: string;
  help: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`sw-setting${wide ? ' wide' : ''}`} id={`setting-${id}`} aria-labelledby={`setting-${id}-title`}>
      <header className="sw-setting-head">
        <div className="sw-setting-text">
          <h3 id={`setting-${id}-title`}>{title}</h3>
          <p>{help}</p>
        </div>
        {aside && <div className="sw-setting-aside">{aside}</div>}
      </header>
      {children && <div className="sw-setting-body">{children}</div>}
    </section>
  );
}

export function Banner({ tone = 'info', title, children, actions }: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const icon: IconName = tone === 'warn' || tone === 'error' ? 'alert' : tone === 'ok' ? 'check' : 'info';
  return (
    <div className={`sw-banner ${tone}`} role={tone === 'error' || tone === 'warn' ? 'alert' : 'status'}>
      <span className="sw-banner-icon"><Icon name={icon} size={16} /></span>
      <div className="sw-banner-text">
        {title && <b>{title}</b>}
        {children && <div>{children}</div>}
      </div>
      {actions && <div className="sw-banner-actions">{actions}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="sw-kbd">{children}</kbd>;
}

export function IconButton({ icon, label, onClick, disabled = false, tone, pressed }: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger' | 'ok';
  pressed?: boolean;
}) {
  return (
    <button type="button" className={`sw-icon-btn${tone ? ` ${tone}` : ''}`} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={16} />
    </button>
  );
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'error' | 'muted' }) {
  return <i className={`sw-dot t-${tone}`} aria-hidden="true" />;
}
