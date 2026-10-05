import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { McpLevel, McpTransport } from '@ide/protocol';
import { Segmented } from './controls';
import { validateEntryForm, type EntryErrors, type EntryField, type EntryForm } from './entry-form';

const FILE: Record<McpLevel, string> = {
  project: '.ide/mcp.json — committed, so your team gets the server too. Others approve it on their machine.',
  ide: '~/.ide/mcp.json — on this machine only, available in every project.',
};

function Field({ label, help, error, group = false, children }: { label: string; help?: string; error?: string; group?: boolean; children: ReactNode }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className="sw-field">
      <span className="sw-field-label">{label}</span>
      {children}
      {error ? <span className="sw-error" role="alert">{error}</span> : help && <span className="sw-field-help">{help}</span>}
    </Tag>
  );
}

export function McpForm({ form, editing, taken, otherLevelHasName, serverError, saving, busy, onChange, onSave, onCancel }: {
  form: EntryForm;
  editing: string | null;
  taken: string[];
  otherLevelHasName: boolean;
  serverError: string | null;
  saving: boolean;
  busy: boolean;
  onChange: (form: EntryForm) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [touched, setTouched] = useState<Partial<Record<EntryField, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const errors: EntryErrors = validateEntryForm(form, taken, editing);
  const shown = (field: EntryField): string | undefined => (attempted || touched[field] ? errors[field] : undefined);
  const set = (patch: Partial<EntryForm>): void => onChange({ ...form, ...patch });
  const bind = (field: EntryField) => ({
    value: form[field],
    'aria-invalid': shown(field) !== undefined,
    onChange: (event: { target: { value: string } }) => set({ [field]: event.target.value } as Partial<EntryForm>),
    onBlur: () => setTouched((current) => ({ ...current, [field]: true })),
  });
  const submit = (): void => {
    setAttempted(true);
    if (Object.keys(errors).length === 0) onSave();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <form className="sw-form" onKeyDown={onKeyDown} onSubmit={(event) => { event.preventDefault(); submit(); }} noValidate>
      <div className="sw-form-head">
        <b>{editing === null ? 'New server' : `Edit ${editing}`}</b>
        {editing === null ? (
          <Segmented
            label="Where to save the server"
            value={form.level}
            onChange={(level) => set({ level })}
            options={[{ value: 'project', label: 'This project' }, { value: 'ide', label: 'All projects' }]}
          />
        ) : null}
      </div>
      <p className="sw-field-help">{FILE[form.level]}</p>
      <Field label="Name" error={shown('name')} help="Letters, digits, “_” and “-”. The agent sees tools as mcp__name__…">
        <input autoFocus spellCheck={false} placeholder="docs-search" {...bind('name')} />
      </Field>
      {otherLevelHasName && !errors.name && (
        <p className="sw-note">
          {form.level === 'project'
            ? 'A server with this name already exists for all projects. That one takes precedence, so this one stays shadowed.'
            : 'A project server with this name exists. This one takes precedence and the project one is ignored.'}
        </p>
      )}
      <Field label="Transport" group>
        <Segmented
          label="Transport"
          value={form.type}
          onChange={(type: McpTransport) => set({ type })}
          options={[{ value: 'stdio', label: 'Command (stdio)' }, { value: 'http', label: 'URL (http)' }]}
        />
      </Field>
      {form.type === 'stdio' ? (
        <>
          <Field label="Command" error={shown('command')} help="The program that starts the server.">
            <input spellCheck={false} placeholder="npx" className="mono" {...bind('command')} />
          </Field>
          <Field label="Arguments" help="One per line.">
            <textarea rows={2} spellCheck={false} className="mono" value={form.args} onChange={(event) => set({ args: event.target.value })} />
          </Field>
          <Field label="Environment" error={shown('env')} help="NAME=value per line. Write secrets as ${VAR} so they stay out of the file.">
            <textarea rows={2} spellCheck={false} className="mono" {...bind('env')} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" error={shown('url')} help="The server's http or https endpoint.">
            <input spellCheck={false} placeholder="https://example.com/mcp" className="mono" {...bind('url')} />
          </Field>
          <Field label="Headers" error={shown('headers')} help="Name: value per line. Write secrets as ${VAR} so they stay out of the file.">
            <textarea rows={2} spellCheck={false} className="mono" {...bind('headers')} />
          </Field>
        </>
      )}
      <Field label="Timeout (optional)" error={shown('timeout')} help="Milliseconds to wait for a tool call. Empty uses the default.">
        <input inputMode="numeric" spellCheck={false} placeholder="60000" className="mono narrow" {...bind('timeout')} />
      </Field>
      {serverError && <p className="sw-error" role="alert">{serverError}</p>}
      <div className="sw-form-actions">
        <button type="button" className="sw-btn ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="sw-btn primary" disabled={busy}>{saving ? 'Saving…' : editing === null ? 'Add server' : 'Save server'}</button>
      </div>
    </form>
  );
}
