// v1.22 (NCC#278) — exam and assignment countdowns for the Weekly Review.
//
// Suite contract (owner decision 2026-11-20): NCC may READ StudyDesk's
// `assignments` and `exams`, and nothing more. This module only selects: it
// never inserts, updates or deletes them, and nothing here goes through
// NCC's sync queue. RLS (`select using auth.uid() = user_id`) scopes the rows;
// the user_id filter is there as well. Fetched on demand for the review and
// held in memory only, so nothing outlives the account that read it (Design A).
// Old NCC versions never read these tables, so nothing changes for them.
import { supabase } from './supabase';

export interface StudyDeadline {
  id: string;
  kind: 'exam' | 'assignment';
  title: string;
  /** YYYY-MM-DD. */
  dueDate: string;
  subjectId: string;
}

interface Row {
  id: string;
  subject_id: string;
  title: string;
  due_date: string | null;
}

async function read(table: 'exams' | 'assignments', userId: string, from: string, to: string): Promise<Row[]> {
  const { data, error } = await supabase
    .from(table)
    .select('id,subject_id,title,due_date')
    .eq('user_id', userId)
    .eq('done', false)
    .is('deleted_at', null)
    .gte('due_date', from)
    .lte('due_date', to)
    .order('due_date', { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as Row[];
}

/** Open exams and assignments due from `from` through `to` (YYYY-MM-DD),
 *  soonest first. Offline or on any error: none, and the review still shows. */
export async function fetchStudyDeadlines(userId: string, from: string, to: string): Promise<StudyDeadline[]> {
  try {
    const [exams, assignments] = await Promise.all([read('exams', userId, from, to), read('assignments', userId, from, to)]);
    const out: StudyDeadline[] = [];
    for (const r of exams) if (r.due_date) out.push({ id: r.id, kind: 'exam', title: r.title, dueDate: r.due_date, subjectId: r.subject_id });
    for (const r of assignments) if (r.due_date) out.push({ id: r.id, kind: 'assignment', title: r.title, dueDate: r.due_date, subjectId: r.subject_id });
    return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.kind === b.kind ? 0 : a.kind === 'exam' ? -1 : 1));
  } catch (e) {
    console.warn('[review] study deadlines unavailable:', (e as Error).message);
    return [];
  }
}

/** Whole days from `today` to `due`, both YYYY-MM-DD local dates. */
export function daysUntil(due: string, today: string): number {
  const [y1, m1, d1] = today.split('-').map(Number);
  const [y2, m2, d2] = due.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}
