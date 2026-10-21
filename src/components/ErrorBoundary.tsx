import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '../i18n';
import { buildReport, errorReportsEnabled, sendReport, type ErrorReport, type SendResult } from '../lib/errorReports';
import { downloadExport } from '../lib/dataRights';
import { supabase } from '../lib/supabase';
import { exportAllowed, useAdoptionGate } from '../lib/adoptionGate';

// v1.16 (limecore#16) — no render error is a blank screen any more.
//
// Before this, any throw during render unmounted the whole tree and left a
// white page with no way out but killing the app (the v1.10.0 blank-screen
// release is the precedent). The recovery screen offers the three things that
// help: reload, send this one report, and export your data.
//
// It depends on nothing that might be what broke: no context, no stores, no
// router. Strings go through i18next directly with English fallbacks, so a
// crash in the i18n layer still leaves a readable screen.

const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => {
  try {
    return i18n.t(key, { defaultValue: fallback, ...opts }) as string;
  } catch {
    return fallback;
  }
};

interface State {
  error: unknown;
  report: ErrorReport | null;
  status: SendResult | 'sending' | null;
  exported: boolean;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, report: null, status: null, exported: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    const report = buildReport(error);
    this.setState({ report });
    // With the Settings switch on, the report goes by itself.
    if (errorReportsEnabled()) {
      this.setState({ status: 'sending' });
      void sendReport(report).then((status) => this.setState({ status }));
    }
  }

  private send = () => {
    const { report } = this.state;
    if (!report) return;
    this.setState({ status: 'sending' });
    void sendReport(report, { consent: true }).then((status) => this.setState({ status }));
  };

  private exportData = async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user ?? null;
      await downloadExport(user ? { id: user.id, email: user.email } : null);
      this.setState({ exported: true });
    } catch {
      /* the export has its own failure surface elsewhere; nothing to add here */
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { report, status, exported } = this.state;
    const sent = status === 'sent' || status === 'duplicate';

    return (
      <div className="min-h-full bg-bg text-text flex items-center justify-center p-4 safe-top" role="alert">
        <div className="panel w-full max-w-sm p-5">
          <div className="sec">{tr('crash.eyebrow', 'Error')}</div>
          <h1 className="font-heading font-bold text-lg mt-1.5">{tr('crash.title', 'Something went wrong')}</h1>
          <p className="text-sm text-text-muted mt-2">
            {tr('crash.body', 'This screen hit an error it could not recover from. Your data is safe on this device.')}
          </p>
          {report && (
            <div className="font-mono text-[0.6875rem] text-text-faint mt-3 break-all">
              {report.error_name} · {report.screen}
            </div>
          )}
          <div className="flex flex-col gap-2 mt-5">
            <button type="button" className="btn w-full" onClick={() => window.location.reload()}>
              {tr('crash.reload', 'Reload')}
            </button>
            {sent ? (
              <div className="alert alert-ok justify-center">{tr('crash.sent', 'Report sent. Thank you.')}</div>
            ) : status === 'guest' ? (
              <div className="text-[0.6875rem] text-text-muted text-center">
                {tr('crash.guest', 'Error reports need an account, so nothing was sent.')}
              </div>
            ) : (
              <button
                type="button"
                className="btn-ghost w-full"
                onClick={this.send}
                disabled={!report || status === 'sending'}
              >
                {status === 'sending'
                  ? tr('crash.sending', 'Sending…')
                  : status === 'failed'
                    ? tr('crash.retry', 'Could not send. Try again')
                    : tr('crash.send', 'Send this report')}
              </button>
            )}
            {/* v1.18.1 — hidden while an account has the adoption choice still
                to make; downloadExport refuses then too (exportAllowed). */}
            {exportAllowed(useAdoptionGate.getState().userId) && (
              <button type="button" className="btn-ghost w-full" onClick={this.exportData}>
                {exported ? tr('crash.exported', 'Export downloaded') : tr('crash.export', 'Export my data')}
              </button>
            )}
          </div>
          {!sent && status !== 'guest' && (
            <p className="text-[0.6875rem] text-text-faint mt-4">
              {tr(
                'crash.whatIsSent',
                'A report says which error happened and where in our code. It never includes what you entered.',
              )}
            </p>
          )}
        </div>
      </div>
    );
  }
}
