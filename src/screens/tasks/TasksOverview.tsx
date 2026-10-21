import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import StatCard from '../../components/StatCard';
import RowActions from '../../components/RowActions';
import ShareModal from '../../components/ShareModal';
import HeatmapCalendar from '../../components/HeatmapCalendar';
import { useTaskStore, TaskFilter } from '../../store/useTaskStore';
import { useSessionStore } from '../../store/useSessionStore';
import { isOverdue, isToday, formatShortDate, localDateKey, formatLocale } from '../../utils/formatters';
import { Task } from '../../types/tasks';
import { SHARING_ENABLED, listTaskShares, shareTaskByEmail, revokeTaskShare } from '../../lib/sharing';
import Glyph from '../../components/Glyph';

const filterKeys: { key: TaskFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'tasks.filterAll' },
  { key: 'today', labelKey: 'tasks.filterToday' },
  { key: 'overdue', labelKey: 'tasks.filterOverdue' },
  { key: 'done', labelKey: 'tasks.filterDone' },
];

export default function TasksOverview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tasks = useTaskStore((s) => s.tasks);
  const filter = useTaskStore((s) => s.filter);
  const setFilter = useTaskStore((s) => s.setFilter);
  const toggleComplete = useTaskStore((s) => s.toggleComplete);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const currentUserId = useSessionStore((s) => s.user?.id);
  const [sharing, setSharing] = useState<Task | null>(null);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (filter === 'today') return !t.completed && t.dueDate && isToday(t.dueDate);
      if (filter === 'overdue') return !t.completed && t.dueDate && isOverdue(t.dueDate);
      if (filter === 'done') return t.completed;
      return true;
    });
  }, [tasks, filter]);

  const groups = useMemo(() => {
    const overdue: Task[] = [];
    const today: Task[] = [];
    const upcoming: Task[] = [];
    const done: Task[] = [];
    for (const t of filtered) {
      if (t.completed) {
        done.push(t);
      } else if (t.dueDate && isOverdue(t.dueDate)) {
        overdue.push(t);
      } else if (t.dueDate && isToday(t.dueDate)) {
        today.push(t);
      } else {
        upcoming.push(t);
      }
    }
    return { overdue, today, upcoming, done };
  }, [filtered]);

  const dueToday = tasks.filter((t) => !t.completed && t.dueDate && isToday(t.dueDate)).length;
  const overdueCount = tasks.filter((t) => !t.completed && t.dueDate && isOverdue(t.dueDate)).length;

  // Heatmap: completed-tasks-per-day. We have no completedAt field, so we
  // use updatedAt as a proxy when completed=true. Imperfect — editing a
  // task's title would move it — but the best signal available without a
  // schema change. Most users finish what they edit, so the noise is low.
  const completedByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (!t.completed) continue;
      const key = localDateKey(new Date(t.updatedAt));
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [tasks]);

  const onEdit = (id: string) => navigate(`/tasks/add?id=${id}`);
  const onShare = (task: Task) => setSharing(task);

  const itemProps = (t: Task) => ({
    task: t,
    onToggle: toggleComplete,
    onEdit,
    onDelete: deleteTask,
    onShare,
    sharedFromOther: !!(t.ownerId && currentUserId && t.ownerId !== currentUserId),
  });

  return (
    <>
      <AppHeader
        title={t('nav.tasks')}
        action={
          <button
            onClick={() => navigate('/tasks/add')}
            className="chip press-spring"
          >
            + {t('tasks.new')}
          </button>
        }
      />
      {/* v1.9 Item 14 — desktop arrangement. Below 1201px this is the same
          single `space-y-3` stack it has always been. Above it, the task-group
          cards tile two-up while the things that are controls or summaries for
          the whole screen — the stat row, the year heatmap, the filter chips —
          span both columns, because splitting those across a column boundary
          would read as two unrelated widgets. */}
      <div className="space-y-3 desktop:space-y-0 desk-grid">
        <div className="grid grid-cols-2 gap-2 desk-span">
          <StatCard value={dueToday} label={t('tasks.dueToday')} highlight />
          <StatCard
            value={overdueCount}
            label={t('tasks.overdue')}
            sub={overdueCount > 0 ? t('tasks.actionNeeded') : t('tasks.allClear')}
            tone={overdueCount > 0 ? 'danger' : 'success'}
          />
        </div>

        {tasks.some((t) => t.completed) && (
          <div className="card desk-span">
            <div className="flex items-center justify-between mb-2">
              <span className="font-heading font-semibold text-sm">{t('tasks.completionStreak')}</span>
              <span className="text-[0.5625rem] uppercase tracking-wider text-text-muted">{t('tasks.days365')}</span>
            </div>
            <HeatmapCalendar data={completedByDay} tint="primary" unit="task" />
          </div>
        )}

        <div className="flex gap-2 overflow-x-auto no-scrollbar desk-span">
          {filterKeys.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`chip flex-shrink-0 ${filter === f.key ? 'chip-on' : ''}`}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>

        {groups.overdue.length > 0 && (
          <div className="card">
            <div className="text-[0.625rem] font-heading font-semibold uppercase tracking-wider text-danger mb-2">
              {t('tasks.overdue')}
            </div>
            {groups.overdue.map((t) => (
              <TaskItem key={t.id} {...itemProps(t)} />
            ))}
          </div>
        )}

        {groups.today.length > 0 && (
          <div className="card">
            <div className="text-[0.625rem] font-heading font-semibold uppercase tracking-wider text-warning mb-2">
              {t('tasks.filterToday')}
            </div>
            {groups.today.map((t) => (
              <TaskItem key={t.id} {...itemProps(t)} />
            ))}
          </div>
        )}

        {groups.upcoming.length > 0 && (
          <div className="card">
            <div className="text-[0.625rem] font-heading font-semibold uppercase tracking-wider text-text-muted mb-2">
              {t('tasks.upcoming')}
            </div>
            {groups.upcoming.map((t) => (
              <TaskItem key={t.id} {...itemProps(t)} />
            ))}
          </div>
        )}

        {groups.done.length > 0 && filter === 'done' && (
          <div className="card">
            <div className="text-[0.625rem] font-heading font-semibold uppercase tracking-wider text-success mb-2">
              {t('tasks.completed')}
            </div>
            {groups.done.map((t) => (
              <TaskItem key={t.id} {...itemProps(t)} />
            ))}
          </div>
        )}

        {filtered.length === 0 && (
          <div className="card text-center text-xs text-text-muted py-6">
            {t('tasks.noTasks')}
          </div>
        )}
      </div>
      {sharing && (
        <ShareModal
          title={t('tasks.shareTitle', { title: sharing.title })}
          subjectId={sharing.id}
          onClose={() => setSharing(null)}
          list={listTaskShares}
          invite={shareTaskByEmail}
          revoke={revokeTaskShare}
        />
      )}
    </>
  );
}

function TaskItem({
  task,
  onToggle,
  onEdit,
  onDelete,
  onShare,
  sharedFromOther,
}: {
  task: Task;
  onToggle: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onShare: (t: Task) => void;
  sharedFromOther: boolean;
}) {
  const { t } = useTranslation();
  const tagText =
    task.completed
      ? { text: t('tasks.done'), tone: 'green' }
      : task.dueDate && isOverdue(task.dueDate)
      ? { text: formatShortDate(task.dueDate), tone: 'red' }
      : task.dueDate && isToday(task.dueDate)
      ? { text: timeOf(task.dueDate), tone: 'amber' }
      : task.dueDate
      ? { text: formatShortDate(task.dueDate), tone: 'muted' }
      : null;

  const toneClasses: Record<string, string> = {
    red: 'bg-danger/15 text-danger border-danger/30',
    green: 'bg-success/15 text-success border-success/30',
    amber: 'bg-warning/15 text-warning border-warning/30',
    muted: 'bg-surface2 text-text-muted border-border',
  };

  return (
    <div className="flex items-center gap-2 py-1.5">
      <button
        onClick={() => onToggle(task.id)}
        className={`w-4 h-4 rounded-sm border flex-shrink-0 flex items-center justify-center text-[0.625rem] ${
          task.completed
            ? 'bg-success border-success text-bg'
            : 'border-border bg-surface2'
        }`}
        aria-label={task.completed ? t('tasks.markIncomplete') : t('tasks.completeTask')}
      >
        {task.completed && <Glyph name="check" size={12} />}
      </button>
      <span className={`flex-1 text-sm truncate ${task.completed ? 'line-through text-text-muted' : ''}`}>
        {task.title}
      </span>
      {sharedFromOther && (
        <span className="text-[0.5625rem] px-1.5 py-0.5 rounded-sm bg-primary/15 text-primary border border-primary/30 whitespace-nowrap">
          {t('tasks.shared')}
        </span>
      )}
      {tagText && (
        <span className={`text-[0.625rem] px-1.5 py-0.5 rounded-sm border whitespace-nowrap ${toneClasses[tagText.tone]}`}>
          {tagText.text}
        </span>
      )}
      <RowActions
        onShare={SHARING_ENABLED && !sharedFromOther ? () => onShare(task) : undefined}
        onEdit={() => onEdit(task.id)}
        onDelete={!sharedFromOther ? () => onDelete(task.id) : undefined}
        confirmMsg={t('tasks.deleteConfirm', { title: task.title })}
      />
    </div>
  );
}

function timeOf(iso: string): string {
  return new Intl.DateTimeFormat(formatLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
