import { create } from 'zustand';
import { db } from '../db/database';
import { Task } from '../types/tasks';
import { generateId } from '../utils/uuid';
import { enqueue } from '../db/syncQueue';
import { cancelTaskReminder, scheduleTaskReminder } from '../lib/taskReminders';

export type TaskFilter = 'all' | 'today' | 'overdue' | 'done';

interface TaskStore {
  tasks: Task[];
  filter: TaskFilter;
  setFilter: (f: TaskFilter) => void;
  load: () => Promise<void>;
  addTask: (t: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'completed'>) => Promise<void>;
  updateTask: (id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>) => Promise<void>;
  toggleComplete: (id: string) => Promise<void>;
  /** v1.18.1 (NCC#143) — set, not flip: a no-op when the task is already in
   *  that state. For the notification's "Mark done", which can arrive twice
   *  (live, then again from the native buffer) and must not undo itself. */
  setComplete: (id: string, completed: boolean) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  filter: 'all',

  setFilter(f) {
    set({ filter: f });
  },

  async load() {
    const tasks = await db.tasks.toArray();
    tasks.sort((a, b) => {
      const ad = a.dueDate ?? '9999';
      const bd = b.dueDate ?? '9999';
      return ad.localeCompare(bd);
    });
    set({ tasks });
  },

  async addTask(t) {
    const now = new Date().toISOString();
    const task: Task = {
      ...t,
      id: generateId(),
      completed: false,
      syncStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await db.tasks.add(task);
    await enqueue('task', task.id, 'insert', task);
    await get().load();
    // Fire-and-forget — failure to schedule shouldn't block the user from
    // creating the task. scheduleTaskReminder is itself a no-op if the
    // tasks toggle is off or there's no future dueDate.
    void scheduleTaskReminder(task);
  },

  async updateTask(id, patch) {
    const existing = await db.tasks.get(id);
    if (!existing) return;
    const updated: Task = {
      ...existing,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
      syncStatus: 'pending',
    };
    await db.tasks.put(updated);
    await enqueue('task', id, 'update', updated);
    await get().load();
    // Cancel-then-reschedule. The schedule call uses a stable hash → notif
    // ID, so an unchanged dueDate would just overwrite the same alarm. But
    // if the user cleared the dueDate or marked it completed, the schedule
    // call is a no-op and the cancel is what we needed.
    await cancelTaskReminder(id);
    void scheduleTaskReminder(updated);
  },

  async toggleComplete(id) {
    const task = await db.tasks.get(id);
    if (!task) return;
    await get().setComplete(id, !task.completed);
  },

  async setComplete(id, completed) {
    const task = await db.tasks.get(id);
    if (!task || task.completed === completed) return;
    const updated: Task = {
      ...task,
      completed,
      updatedAt: new Date().toISOString(),
      syncStatus: 'pending',
    };
    await db.tasks.put(updated);
    await enqueue('task', id, 'update', updated);
    await get().load();
    if (updated.completed) {
      // Done → no reason to keep pinging.
      void cancelTaskReminder(id);
    } else {
      // Un-completed (user changed their mind) → re-arm if dueDate still future.
      void scheduleTaskReminder(updated);
    }
  },

  async deleteTask(id) {
    await db.tasks.delete(id);
    await enqueue('task', id, 'delete', { id });
    await get().load();
    void cancelTaskReminder(id);
  },
}));
