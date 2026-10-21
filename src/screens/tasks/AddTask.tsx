import { useEffect, useState } from 'react';
import { useConfirm } from '../../components/ConfirmDialog';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AppHeader from '../../components/AppHeader';
import TemplateChips from '../../components/TemplateChips';
import { useTaskStore } from '../../store/useTaskStore';
import { useTemplatesStore } from '../../store/useTemplatesStore';
import type { TaskTemplate } from '../../types/templates';
import { TaskCategory, TaskPriority } from '../../types/tasks';
import { toDateTimeLocalValue } from '../../utils/formatters';
import { dueInstant } from '../../lib/taskDue';

// `dot` restores what the labels lost. The three tiers used to be spelled with
// red/yellow/green emoji circles baked into the translated strings, which meant
// the one part of the UI that encoded severity was also the one part no palette
// could reach. The word carries the tier and a semantic dot carries the colour,
// in the app's own red/amber/green rather than the platform's.
const priorities: { key: TaskPriority; labelKey: string; dot: string }[] = [
  { key: 'high', labelKey: 'addtask.prHigh', dot: 'bg-danger' },
  { key: 'medium', labelKey: 'addtask.prMedium', dot: 'bg-warning' },
  { key: 'low', labelKey: 'addtask.prLow', dot: 'bg-success' },
];

const categories: { key: TaskCategory; labelKey: string }[] = [
  { key: 'study', labelKey: 'addtask.catStudy' },
  { key: 'personal', labelKey: 'addtask.catPersonal' },
  { key: 'finance', labelKey: 'addtask.catFinance' },
  { key: 'work', labelKey: 'addtask.catWork' },
];

export default function AddTask() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get('id');

  const tasks = useTaskStore((s) => s.tasks);
  const addTask = useTaskStore((s) => s.addTask);
  const updateTask = useTaskStore((s) => s.updateTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const templates = useTemplatesStore((s) => s.tasks);
  const refreshTemplates = useTemplatesStore((s) => s.refresh);

  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [category, setCategory] = useState<TaskCategory>('personal');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editId) return;
    const t = tasks.find((x) => x.id === editId);
    if (!t) return;
    // HYG-4: Seeding an editable form from the record being edited — see
    // AddTransaction for why this cannot be derived.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(t.title);
    // v1.18.1 (NCC#193) - a date-only due value is a local day, not UTC
    // midnight (which showed as 03:00 in Helsinki).
    const dueAt = t.dueDate ? dueInstant(t.dueDate) : null;
    setDue(dueAt ? toDateTimeLocalValue(dueAt.toISOString()) : '');
    setPriority(t.priority);
    setCategory(t.category ?? 'personal');
    setNotes(t.notes ?? '');
  }, [editId, tasks]);

  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const payload = {
      title: title.trim(),
      dueDate: due ? new Date(due).toISOString() : undefined,
      priority,
      category,
      notes: notes.trim() || undefined,
    };
    if (editId) {
      await updateTask(editId, payload);
    } else {
      await addTask(payload);
    }
    setSaving(false);
    navigate('/tasks');
  };

  const onDelete = async () => {
    if (!editId) return;
    if (!(await confirm({ message: t('addtask.deleteConfirm') }))) return;
    await deleteTask(editId);
    navigate('/tasks');
  };

  const showTemplates = !editId && templates.length > 0;

  const applyTemplate = (t: TaskTemplate) => {
    setTitle(t.title);
    setPriority(t.priority);
    if (t.category) setCategory(t.category);
    // Due date intentionally not pre-filled — recurring tasks land on
    // different dates each time, so we leave it for the user to set.
  };

  return (
    <>
      <AppHeader
        title={editId ? t('addtask.editTitle') : t('addtask.newTitle')}
        back="/tasks"
        backLabel={t('nav.tasks')}
        showAvatar={false}
      />
      <div className="space-y-3">
        {showTemplates && (
          <TemplateChips
            templates={templates}
            onPick={applyTemplate}
            label={(t) => <span className="truncate max-w-[180px]">{t.title}</span>}
          />
        )}
        <div>
          <div className="sec mb-2">{t('addtask.taskName')}</div>
          <input
            className="input"
            placeholder={t('addtask.taskNamePlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        <div>
          <div className="sec mb-2">{t('addtask.dueDateTime')}</div>
          <input
            className="input"
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>

        <div>
          <div className="sec mb-2">{t('addtask.priority')}</div>
          <div className="flex gap-2 flex-wrap">
            {priorities.map((p) => (
              <button
                key={p.key}
                onClick={() => setPriority(p.key)}
                className={`chip ${priority === p.key ? 'chip-on' : ''}`}
              >
                <span aria-hidden className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.dot}`} />
                {t(p.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="sec mb-2">{t('addtask.category')}</div>
          <div className="flex gap-2 flex-wrap">
            {categories.map((c) => (
              <button
                key={c.key}
                onClick={() => setCategory(c.key)}
                className={`chip ${category === c.key ? 'chip-on' : ''}`}
              >
                {t(c.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="sec mb-2">{t('addtask.notes')}</div>
          <textarea
            className="input min-h-[80px]"
            placeholder={t('addtask.notesPlaceholder')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <button className="btn w-full" onClick={submit} disabled={saving || !title.trim()}>
          {saving ? t('addtask.saving') : editId ? t('addtask.saveChanges') : t('addtask.saveTask')}
        </button>
        {editId && (
          <button className="btn-ghost w-full text-danger border-danger/40" onClick={onDelete}>
            {t('addtask.deleteTask')}
          </button>
        )}
        <div className="text-[0.625rem] text-text-muted text-center">
          {t('addtask.queued')}
        </div>
      </div>
    </>
  );
}
