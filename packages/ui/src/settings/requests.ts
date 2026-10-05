import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage } from '@ide/protocol';
import type { Toast } from './SaveBar';

export interface SettingsResult {
  requestId: string;
  error: string | null;
}

export interface RunOptions {
  okText?: string;
  // The caller shows the error itself (inside a form), so no toast
  inline?: boolean;
  onSettled?: (error: string | null) => void;
}

const ANSWER_TIMEOUT_MS = 15_000;
const OK_TOAST_MS = 3600;

export type Notify = (tone: Toast['tone'], text: string) => void;

export function useToasts(): { toasts: Toast[]; notify: Notify; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notify = useCallback<Notify>((tone, text) => {
    const id = next.current++;
    setToasts((current) => [...current.slice(-2), { id, tone, text }]);
    if (tone === 'ok') setTimeout(() => dismiss(id), OK_TOAST_MS);
  }, [dismiss]);
  return { toasts, notify, dismiss };
}

type Message = ClientMessage & { requestId: string };

// One request in flight at a time, answered by the core's settings.result with the same id.
export function useRequests(send: (message: ClientMessage) => boolean, lastResult: SettingsResult | null, notify: Notify) {
  const [pending, setPending] = useState<{ requestId: string; options: RunOptions } | null>(null);

  const settle = useCallback((error: string | null, options: RunOptions) => {
    setPending(null);
    options.onSettled?.(error);
    if (error !== null) {
      if (!options.inline) notify('error', error);
    } else if (options.okText) notify('ok', options.okText);
  }, [notify]);

  useEffect(() => {
    if (pending && lastResult?.requestId === pending.requestId) settle(lastResult.error, pending.options);
  }, [lastResult, pending, settle]);

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => settle('The core did not answer. Try again.', pending.options), ANSWER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending, settle]);

  const run = useCallback((message: Message, options: RunOptions = {}): boolean => {
    if (!send(message)) {
      const error = 'Not connected to the core. Check the connection and try again.';
      options.onSettled?.(error);
      if (!options.inline) notify('error', error);
      return false;
    }
    setPending({ requestId: message.requestId, options });
    return true;
  }, [send, notify]);

  return { busy: pending !== null, run };
}
