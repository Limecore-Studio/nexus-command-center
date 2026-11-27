import type { ReactNode } from 'react';
interface StatCardProps {
  value: string | number;
  label: string;
  sub?: string;
  highlight?: boolean;
  tone?: 'default' | 'danger' | 'success' | 'warning';
  /** v1.22 (limecore#131): e.g. an "Open in StudyDesk" link under the reading. */
  action?: ReactNode;
}

const toneClass: Record<string, string> = {
  default: 'text-text-faint',
  danger: 'text-danger',
  success: 'text-success',
  warning: 'text-warning',
};

/**
 * One measured value with its label underneath.
 *
 * v1.10: `highlight` used to draw an amber ring around the whole panel. It now
 * colours the FIGURE instead. The distinction matters — the accent marks the
 * live reading, and the reading is the number, not the box it sits in. It also
 * keeps the amber count down: a highlighted card contributes one small bright
 * element rather than a full outlined rectangle.
 *
 * The value is set in the mono readout, so a column of these aligns on the
 * decimal point without any caller arranging it.
 */
export default function StatCard({ value, label, sub, highlight, tone = 'default', action }: StatCardProps) {
  return (
    <div className="stat-box">
      <div className={`readout readout-lg ${highlight ? 'readout-live' : ''}`}>{value}</div>
      <div className="sec mt-1.5">{label}</div>
      {sub && <div className={`text-[0.625rem] mt-0.5 ${toneClass[tone]}`}>{sub}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
