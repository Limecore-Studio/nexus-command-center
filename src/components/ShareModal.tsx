// Generic sharing modal — works for any sharable resource (budget categories,
// tasks). The caller passes:
//   • title (e.g. "Share Groceries budget")
//   • subject id
//   • a list/invite/revoke function trio so the modal stays resource-agnostic
//
// The modal shows current shares with a revoke button, plus an
// invite-by-email row. All server errors are surfaced inline.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useConfirm } from './ConfirmDialog';
import {
  ShareRow,
  SharePermission,
  describeShareError,
} from '../lib/sharing';
import Glyph from './Glyph';

interface Props {
  title: string;
  subjectId: string;
  onClose: () => void;
  list: (id: string) => Promise<ShareRow[]>;
  invite: (id: string, email: string, permission: SharePermission) => Promise<void>;
  revoke: (id: string, userId: string) => Promise<void>;
}

export default function ShareModal({
  title,
  subjectId,
  onClose,
  list,
  invite,
  revoke,
}: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<SharePermission>('write');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const rows = await list(subjectId);
      setShares(rows);
    } catch (e) {
      setError(describeShareError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // HYG-4: Fetch kickoff, not state synchronisation — the synchronous set inside
    // refresh() is the loading flag going up.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId]);

  const onInvite = async () => {
    setError(null);
    setSuccess(null);
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter an email address.');
      return;
    }
    setWorking(true);
    try {
      await invite(subjectId, trimmed, permission);
      setEmail('');
      setSuccess('Invited.');
      await refresh();
    } catch (e) {
      setError(describeShareError(e));
    } finally {
      setWorking(false);
    }
  };

  const onRevoke = async (userId: string, name: string) => {
    if (!(await confirm({ message: t('common.revokeAccess', { name: name || t('common.thisUser') }) }))) return;
    setWorking(true);
    setError(null);
    setSuccess(null);
    try {
      await revoke(subjectId, userId);
      await refresh();
    } catch (e) {
      setError(describeShareError(e));
    } finally {
      setWorking(false);
    }
  };

  // v1.21.1 (NCC#274): into document.body, like BottomSheet and the sign-out
  // dialog. Inside a screen, PageTransition's transform traps a `fixed`
  // overlay under the tab bar; the overlay scrolls so the email field and
  // the buttons stay reachable with the keyboard open.
  return createPortal(
    <div className="fixed inset-0 bg-bg/90 z-50 overflow-y-auto">
      <div className="min-h-full flex items-end sm:items-center justify-center p-4 safe-bottom">
      <div className="card-elevated w-full max-w-sm">
        <div className="flex items-start justify-between mb-2">
          <h2 className="font-heading font-bold text-base">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-muted active:text-text px-2 -me-2"
          >
            <Glyph name="close" size={14} />
          </button>
        </div>
        <p className="text-[0.625rem] text-text-muted mb-3">
          People you invite see this on their own sign-in. Invite limit: 50 per day.
        </p>

        {/* Current shares */}
        <div className="space-y-1 mb-3">
          {loading && (
            <div className="text-xs text-text-muted py-2">{t('common.loading')}</div>
          )}
          {!loading && shares.length === 0 && (
            <div className="text-xs text-text-muted py-2">
              {t('share.none')}
            </div>
          )}
          {shares.map((s) => (
            <div
              key={s.user_id}
              className="flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0"
            >
              <div className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[0.625rem] font-heading font-bold">
                {initialsOf(s.display_name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">
                  {s.display_name || 'User'}
                </div>
                <div className="text-[0.625rem] text-text-muted">
                  {s.permission === 'write' ? t('share.canEdit') : t('share.readOnly')}
                </div>
              </div>
              <button
                onClick={() => onRevoke(s.user_id, s.display_name ?? '')}
                aria-label="Revoke access"
                disabled={working}
                className="text-danger px-2 py-1 text-sm active:bg-danger/10 rounded-sm"
              >
                <Glyph name="close" size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* Invite */}
        <div className="space-y-2">
          <input
            className="input"
            type="email"
            inputMode="email"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="someone@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={working}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPermission('write')}
              className={`chip flex-1 ${permission === 'write' ? 'chip-on' : ''}`}
            >
              {t('share.canEdit')}
            </button>
            <button
              type="button"
              onClick={() => setPermission('read')}
              className={`chip flex-1 ${permission === 'read' ? 'chip-on' : ''}`}
            >
              {t('share.readOnly')}
            </button>
          </div>
          <button
            className="btn w-full"
            onClick={onInvite}
            disabled={working || !email.trim()}
          >
            {working ? 'Working…' : 'Invite'}
          </button>
        </div>

        {error && (
          <div className="alert alert-warn text-xs mt-3">
            <span className="w-2 h-2 rounded-full bg-danger" />
            <span className="flex-1">{error}</span>
          </div>
        )}
        {success && !error && (
          <div className="text-[0.625rem] text-success mt-2">{success}</div>
        )}
      </div>
      </div>
    </div>,
    document.body,
  );
}

function initialsOf(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
