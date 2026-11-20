// v1.22 (NCC#278) — when the Home "your week in review" card shows: on
// Sunday from 16:00 local, once per week until dismissed. Same moment as the
// opt-in Sunday notification (18:00), a little earlier so it is there when the
// evening starts. The card itself is components/WeeklyReviewCard (lazy).
import { localDateKey } from '../utils/formatters';

const KEY = 'nexus.reviewCard.dismissedWeek';

/** The Sunday this card is about, as YYYY-MM-DD, or null when it isn't due. */
export function reviewCardWeek(now: Date = new Date()): string | null {
  if (now.getDay() !== 0 || now.getHours() < 16) return null;
  return localDateKey(now);
}

export function reviewCardDue(now: Date = new Date()): boolean {
  const week = reviewCardWeek(now);
  if (!week) return false;
  try {
    return localStorage.getItem(KEY) !== week;
  } catch {
    return false;
  }
}

export function dismissReviewCard(now: Date = new Date()): void {
  const week = reviewCardWeek(now) ?? localDateKey(now);
  try {
    localStorage.setItem(KEY, week);
  } catch {
    /* private mode: it shows again next launch */
  }
}
