import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import BottomSheet from './BottomSheet';
import TemplateChips from './TemplateChips';
import { useFinanceStore } from '../store/useFinanceStore';
import { useTaskStore } from '../store/useTaskStore';
import { useTemplatesStore } from '../store/useTemplatesStore';
import { useWorkQualityStore, todayKey } from '../store/useWorkQualityStore';
import { localDateKey } from '../utils/formatters';
import Glyph from './Glyph';

// v1.5.2 — Quick Log is NCC-native only. Grade (StudyDesk), study Session
// (StudyDesk) and workout Set (LimeLog) were removed: cramming stripped-down
// versions of another app's logger here bloated the sheet and diverged from
// those apps' real forms. Log grades/sessions/sets in StudyDesk / LimeLog.
type QuickTab = 'expense' | 'work' | 'task';

interface QuickLogBottomSheetProps {
  open: boolean;
  onClose: () => void;
}

// `icon` is a Glyph name; it used to be an emoji baked into the label string,
// which meant the glyph could never take the label's colour.
const tabs: { key: QuickTab; label: string; icon: string }[] = [
  { key: 'expense', label: 'Expense', icon: 'expense' },
  { key: 'work', label: 'Work', icon: 'work' },
  { key: 'task', label: 'Task', icon: 'tasks' },
];

export default function QuickLogBottomSheet({ open, onClose }: QuickLogBottomSheetProps) {
  const [tab, setTab] = useState<QuickTab>('expense');
  const refreshTemplates = useTemplatesStore((s) => s.refresh);

  // Refresh on each open so chips reflect anything logged since the last
  // FAB open — the sheet stays mounted, so a one-shot mount effect would
  // not catch subsequent opens.
  useEffect(() => {
    if (open) void refreshTemplates();
  }, [open, refreshTemplates]);

  return (
    <BottomSheet open={open} onClose={onClose} title="Quick Log">
      <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`chip flex-shrink-0 ${tab === t.key ? 'chip-on' : ''}`}
          >
            <Glyph name={t.icon} size={12} />{t.label}
          </button>
        ))}
      </div>
      {tab === 'expense' && <QuickExpense onDone={onClose} />}
      {tab === 'work' && <QuickWork onDone={onClose} />}
      {tab === 'task' && <QuickTask onDone={onClose} />}
      <div className="text-[0.625rem] text-text-muted text-center mt-3">
        DIFS target &lt;15 sec · queued locally
      </div>
    </BottomSheet>
  );
}

function QuickExpense({ onDone }: { onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  // v1.3.1 BUG-13 — Quick Log is now Account-aware. The v1.2 Account refactor
  // requires every expense/income transaction to carry an accountId so the
  // derived balance computation in lib/accountBalance.ts has a source.
  // Quick Log was missed in that refactor and was silently writing accountId
  // undefined, so QuickLog transactions never appeared in any account's
  // running balance. Picker is required (disabled submit until set) to match
  // the AddTransaction posture — no silent defaulting.
  const [accountId, setAccountId] = useState<string>('');
  const categories = useFinanceStore((s) => s.budgetCategories);
  const accounts = useFinanceStore((s) => s.manualAssets);
  const addTransaction = useFinanceStore((s) => s.addTransaction);
  // Only expense-type templates show on this tab (the tab is hard-coded
  // expense). Filtering here is cheaper than maintaining a separate cache.
  // useShallow is required, not an optimisation: zustand 5 compares selector
  // results with Object.is, a fresh filtered array never matches, and since
  // this sheet is mounted in AppShell even while closed, that render loop
  // took down every screen (limecore#21).
  const templates = useTemplatesStore(
    useShallow((s) => s.transactions.filter((t) => t.type === 'expense')),
  );

  // When the user picks a category that has a pre-selected account (the
  // BudgetCategory.linkedManualAssetId hint — actually defaultAccountId
  // per the v1.2 follow-up rename comment), pre-fill the Account picker
  // unless the user has already chosen one explicitly. Same UX contract
  // as the full AddTransaction screen.
  useEffect(() => {
    if (accountId) return;
    const cat = categories.find((c) => c.id === categoryId);
    // HYG-4: A default the user can override cannot be derived: derived, it would
    // re-apply on every render and silently undo their choice. The `if
    // (accountId) return;` guard is what makes it fire once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cat?.linkedManualAssetId) setAccountId(cat.linkedManualAssetId);
  }, [categoryId, categories, accountId]);

  const submit = async () => {
    const n = parseFloat(amount);
    // Reject negative amounts too: a negative expense inverts the account
    // balance and budget math downstream (renders as a red expense that ADDS
    // to the balance). Quick Log has no visible amount-sign control.
    if (!n || n < 0 || !desc.trim() || !accountId) return;
    await addTransaction({
      amount: n,
      description: desc.trim(),
      categoryId: categoryId || undefined,
      accountId,
      // Local calendar day, not UTC. QuickExpense exposes no date field, so a
      // toISOString() slice would silently file a late-night entry under
      // yesterday (fi-FI is UTC+2/+3).
      date: localDateKey(new Date()),
      type: 'expense',
    });
    onDone();
  };

  return (
    <div className="space-y-3">
      {templates.length > 0 && (
        <TemplateChips
          templates={templates}
          onPick={(t) => {
            setAmount(String(t.amount));
            setDesc(t.description);
            if (t.categoryId) setCategoryId(t.categoryId);
            // TransactionTemplate doesn't carry accountId (detection groups
            // across whichever account each occurrence used) — the user
            // still picks the account explicitly. The category's
            // linkedManualAssetId may still pre-fill via the effect below.
          }}
          label={(t) => (
            <>
              <span className="truncate max-w-[110px]">{t.description}</span>
              <span className="opacity-60">·</span>
              <span className="font-medium">{t.amount.toFixed(2)}€</span>
            </>
          )}
        />
      )}
      <div className="flex gap-2">
        <input
          className="input max-w-[110px]"
          inputMode="decimal"
          placeholder="€ Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          className="input"
          placeholder="Description"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </div>
      <select
        className="input"
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
      >
        <option value="">Category…</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.icon ? `${c.icon} ` : ''}{c.name}
          </option>
        ))}
      </select>
      <select
        className="input"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
      >
        <option value="">Account…</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button
        className="btn w-full"
        onClick={submit}
        disabled={!amount || !desc.trim() || !accountId}
      >
        Save Expense
      </button>
    </div>
  );
}

// v1.5 — daily Work self-assessment, also reachable here (the Home
// WorkRatingCard only shows weekday afternoons). One rating per day; tapping
// again before saving just changes the selection. Pre-fills today's rating
// if already logged.
function QuickWork({ onDone }: { onDone: () => void }) {
  const logs = useWorkQualityStore((s) => s.logs);
  const loaded = useWorkQualityStore((s) => s.loaded);
  const load = useWorkQualityStore((s) => s.load);
  const setRating = useWorkQualityStore((s) => s.setRating);

  const today = logs.find((l) => l.date === todayKey());
  const [rating, setRatingState] = useState<number>(today?.rating ?? 0);
  const [note, setNote] = useState<string>(today?.note ?? '');

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const submit = async () => {
    if (rating < 1) return;
    await setRating(rating, note.trim() || null);
    onDone();
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="sec mb-2">How was work today?</div>
        <div className="flex gap-2.5">
          {[1, 2, 3, 4, 5].map((n) => {
            const on = rating === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => setRatingState(n)}
                aria-pressed={on}
                aria-label={`${n} out of 5`}
                className={`press-spring flex-1 h-11 rounded-md border text-lg font-heading font-semibold transition-colors ${
                  on ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-text-muted'
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>
      <textarea
        className="input resize-none h-16 text-sm"
        placeholder="Add a note… (optional)"
        maxLength={120}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button className="btn w-full" onClick={submit} disabled={rating < 1}>
        {today ? 'Update Work Rating' : 'Save Work Rating'}
      </button>
    </div>
  );
}

function QuickTask({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  // Default priority+category from the picked template; falls back to
  // medium/personal (the previous hard-coded behavior) for blank submissions.
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [category, setCategory] = useState<'study' | 'personal' | 'finance' | 'work'>('personal');
  const addTask = useTaskStore((s) => s.addTask);
  const templates = useTemplatesStore((s) => s.tasks);

  const submit = async () => {
    if (!title.trim()) return;
    await addTask({
      title: title.trim(),
      dueDate: due ? new Date(due).toISOString() : undefined,
      priority,
      category,
    });
    onDone();
  };

  return (
    <div className="space-y-3">
      {templates.length > 0 && (
        <TemplateChips
          templates={templates}
          onPick={(t) => {
            setTitle(t.title);
            setPriority(t.priority);
            if (t.category) setCategory(t.category);
          }}
          label={(t) => <span className="truncate max-w-[160px]">{t.title}</span>}
        />
      )}
      <input
        className="input"
        placeholder="What needs to be done?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <input
        className="input"
        type="datetime-local"
        value={due}
        onChange={(e) => setDue(e.target.value)}
      />
      <button className="btn w-full" onClick={submit}>
        Save Task
      </button>
    </div>
  );
}
