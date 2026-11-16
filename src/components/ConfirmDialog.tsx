// In-app replacement for window.confirm().
//
// On Android WebView the native dialog is the OS dialog, which means its
// buttons are in the *OS* language rather than the app's — a user running the
// app in Hindi got a translated message with English "OK / Cancel" — it renders
// LTR even under dir="rtl", it shows the package name as its title, and it
// blocks the JS thread. It was the last place the ten-language and RTL work
// visibly leaked.
//
// The API is deliberately promise-based and shaped like the thing it replaces,
// so a call site changes from
//     if (!confirm(msg)) return;
// to
//     if (!(await confirm({ message: msg }))) return;
// and nothing else about the surrounding logic moves.

import {
  createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

interface ConfirmOptions {
  message: string;
  /** Optional heading above the message. */
  title?: string;
  /** Defaults to common.confirm. */
  confirmLabel?: string;
  /** Defaults to common.cancel. */
  cancelLabel?: string;
  /** Renders the confirm button in the danger colour. Default true — every
   *  current caller guards a destructive action. */
  destructive?: boolean;
  /** v1.21.1 — a notice: one button, no cancel. */
  alert?: boolean;
}

type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook is tightly coupled to ConfirmContext defined above, not worth splitting into its own file
export function useConfirm(): Confirm {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>((opts) => {
    setPending(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setPending(null);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 bg-bg/90 z-[60] flex items-end sm:items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          // Dismissing by backdrop is a cancel, matching the native dialog.
          onClick={() => settle(false)}
        >
          <div
            className="card-elevated w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            {pending.title && (
              <h2 className="font-heading font-bold text-base mb-2">{pending.title}</h2>
            )}
            <p className="text-sm text-text mb-4 whitespace-pre-line">{pending.message}</p>
            <div className="flex gap-2 justify-end">
              {!pending.alert && (
                <button
                  className="btn-ghost px-4 py-2 text-sm"
                  onClick={() => settle(false)}
                >
                  {pending.cancelLabel ?? t('common.cancel')}
                </button>
              )}
              <button
                className={`px-4 py-2 text-sm rounded-md font-medium ${
                  pending.destructive === false
                    ? 'bg-primary text-bg'
                    : 'bg-danger text-white'
                }`}
                onClick={() => settle(true)}
                autoFocus
              >
                {pending.confirmLabel ?? t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
