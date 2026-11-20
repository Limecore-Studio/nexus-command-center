import { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore, userInitials } from '../store/useSessionStore';
import SyncDot from './SyncDot';

interface AppHeaderProps {
  title: string;
  back?: string;
  backLabel?: string;
  action?: ReactNode;
  showAvatar?: boolean;
}

/**
 * AppHeader — the title sits directly on the ground with no frame around it,
 * and a rule underneath separates it from the content instead. That rule is
 * doing the job the old floating-over-a-mesh treatment did, with one line.
 *
 * Neither the back chip nor the avatar takes the accent: they are navigation,
 * not readings.
 */
export default function AppHeader({ title, back, backLabel, action, showAvatar = true }: AppHeaderProps) {
  const navigate = useNavigate();
  const user = useSessionStore((s) => s.user);
  const initials = userInitials(user);

  return (
    // v1.2 follow-up — title side gets `flex-1 min-w-0` so it CAN shrink
    // for ellipsis but doesn't get clobbered down to a single letter when
    // the action area is wide (the Finance overview, with 5 action chips,
    // was the offender). Action area is `flex-shrink-0` so it takes only
    // its natural width and stops claiming title space.
    // v1.9 — the gap below the header matches the desktop grid gap, so the
    // first row of cards sits on the same rhythm as every row beneath it.
    <header className="flex items-center justify-between py-3 mb-3 desktop:mb-4 gap-2 border-b border-border-soft">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {back && (
          <button
            onClick={() => navigate(back)}
            className="chip h-8 press-spring flex-shrink-0"
            aria-label={backLabel ?? 'Back'}
          >
            <span aria-hidden>←</span> {backLabel ?? 'Back'}
          </button>
        )}
        <h1 className="font-heading font-bold text-xl tracking-tight truncate">{title}</h1>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {action}
        {/* v1.22 (NCC#290): hidden unless something waits or failed. */}
        <SyncDot />
        {showAvatar && (
          <button
            onClick={() => navigate('/settings')}
            className="w-9 h-9 rounded-full bg-surface2 border border-border flex items-center justify-center font-mono text-[0.625rem] font-medium tracking-wider text-text-muted press-spring flex-shrink-0"
            aria-label="Account"
          >
            {initials}
          </button>
        )}
      </div>
    </header>
  );
}
