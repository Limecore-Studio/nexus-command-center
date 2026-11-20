// Building blocks shared by the Settings screen and its section files.
// Moved out of Settings.tsx unchanged (limecore#12).

import { haptic } from '../../lib/haptic';
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="sec mb-2">{title}</div>
      <div className="card space-y-1">{children}</div>
    </div>
  );
}

export function Toggle({
  label,
  sub,
  value,
  onChange,
  locked,
}: {
  label: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  locked?: boolean;
}) {
  return (
    <div className="py-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {sub && <div className="text-[0.625rem] text-text-muted">{sub}</div>}
      </div>
      {/* The track stays neutral and the KNOB carries the accent. Settings
          has a dozen of these; filling each whole track amber put a dozen
          accent slabs on one screen and made the accent mean "a switch exists"
          rather than "this is live". A 20px amber dot still reads as on at a
          glance, and ten of them read as a panel of switches rather than as
          ten alarms. */}
      {/* The outline is an inset ring, not a border: a 1px border took layout
          space, which left an 18px slot for the 20px knob, so the knob sat 1px
          low and touched the right edge when on. With the ring, 44×24 minus
          2px padding is exactly the 40×20 the knob and its 20px travel need.
          The travel flips under RTL, where the knob starts on the right. */}
      <button
        onClick={() => {
          if (locked) return;
          haptic.light(); // v1.22 (limecore#130)
          onChange(!value);
        }}
        className={`w-11 h-6 rounded-full p-0.5 bg-surface2 ring-1 ring-inset transition flex-shrink-0 ${
          value ? 'ring-primary' : 'ring-border'
        } ${locked ? 'opacity-60' : ''}`}
        disabled={locked}
        aria-pressed={value}
      >
        <div
          className={`w-5 h-5 rounded-full transition-transform ${
            value ? 'translate-x-5 rtl:-translate-x-5 bg-primary' : 'bg-text-faint'
          }`}
        />
      </button>
    </div>
  );
}
