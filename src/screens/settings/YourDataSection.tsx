import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../components/ConfirmDialog';
import { useSessionStore } from '../../store/useSessionStore';
import { clearAllLocalData } from '../../db/database';
import { downloadExport, deleteAccount } from '../../lib/dataRights';
import { Section } from './parts';
import '../../i18n/lazy/dataRights'; // settings.delete* (loaded with this screen)

// Settings > Your data (GDPR Art. 17 / 20). Split out of Settings.tsx with
// its state (limecore#12).
export default function YourDataSection() {
  const confirm = useConfirm();
  const { t } = useTranslation();
  const user = useSessionStore((s) => s.user);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dataMsg, setDataMsg] = useState<string | null>(null);

  // ── GDPR Art. 20 — portability ────────────────────────────────────────────
  const onExport = async () => {
    setDataMsg(null);
    setExporting(true);
    try {
      const name = await downloadExport(user ? { id: user.id, email: user.email } : null);
      setDataMsg(t('settings.exportDone', { name }));
    } catch (e) {
      setDataMsg(t('settings.exportFailed', { msg: (e as Error).message }));
    } finally {
      setExporting(false);
    }
  };

  // ── GDPR Art. 17 — erasure ────────────────────────────────────────────────
  // Two confirmations, because this is irreversible, there is no recovery
  // window, and one account spans all three apps — so this erases LimeLog and
  // StudyDesk data too, which the second confirmation says explicitly.
  const onDeleteAccount = async () => {
    if (!(await confirm({ message: t('settings.deleteAccountConfirm1') }))) return;
    if (!(await confirm({ message: t('settings.deleteAccountConfirm2') }))) return;
    setDataMsg(null);
    setDeleting(true);
    try {
      const result = await deleteAccount({
        clearLocal: async () => {
          await clearAllLocalData();
          localStorage.clear();
        },
      });
      // v1.21.1 (limecore#102): each outcome says what actually happened.
      if (result.deleted === 'nothing') {
        setDataMsg(t('settings.deleteNeedsSignIn'));
        setDeleting(false);
        return;
      }
      if (result.deleted === 'local') {
        await confirm({ message: t('settings.deleteGuestDone'), confirmLabel: t('settings.deleteOk'), destructive: false, alert: true });
      }
      location.reload();
    } catch (e) {
      setDataMsg(t('settings.deleteAccountFailed', { msg: (e as Error).message }));
      setDeleting(false);
    }
  };

  return (
    <Section title={t('settings.yourData')}>
      <div className="text-[0.625rem] text-text-muted px-1 pb-2 leading-relaxed">
        {t('settings.yourDataNote')}
      </div>
      <button className="btn-ghost w-full" onClick={onExport} disabled={exporting}>
        {exporting ? t('settings.exporting') : t('settings.exportData')}
      </button>
      <button
        className="btn-ghost w-full mt-2 text-danger border-danger/40"
        onClick={onDeleteAccount}
        disabled={deleting}
      >
        {deleting ? t('settings.deletingAccount') : t('settings.deleteAccount')}
      </button>
      <div className="text-[0.625rem] text-text-muted px-1 pt-2 leading-relaxed">
        {t('settings.deleteAccountNote')}
      </div>
      {dataMsg && <div className="text-[0.625rem] text-warning mt-1 px-1">{dataMsg}</div>}
    </Section>
  );
}
