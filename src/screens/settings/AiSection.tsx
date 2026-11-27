// v1.22 (limecore#122, Design H) — AI on the user's own Gemini key.
//
// The key (masked, with set and clear), the model name, a Test that makes one
// tiny request, and what happens to the data. The AI switch is rendered by the
// caller and stays locked off until a key is set: no key, no AI request.
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { maskKey } from '../../api/keys';
import Glyph from '../../components/Glyph';
import {
  clearAiKey,
  DEFAULT_AI_MODEL,
  generate,
  getAiKey,
  getAiModel,
  setAiKey,
  setAiModel,
  type AiError,
} from '../../lib/aiProvider';

export default function AiSection({
  enabled,
  onEnabled,
  toggle,
}: {
  enabled: boolean;
  onEnabled: (on: boolean) => void | Promise<void>;
  toggle: (locked: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  // undefined while the stored key is still loading: the switch-off below
  // must wait for the answer, or it turned AI off on every visit.
  const [key, setKey] = useState<string | undefined>(undefined);
  const [model, setModel] = useState(DEFAULT_AI_MODEL);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<'ok' | AiError | null>(null);

  useEffect(() => {
    void getAiKey().then((k) => setKey(k ?? ''));
    void getAiModel().then(setModel);
  }, []);

  // No key means AI is off, whatever was switched on before.
  useEffect(() => {
    if (key === '' && enabled) void onEnabled(false);
  }, [key, enabled, onEnabled]);

  const saveKey = async () => {
    const v = draft.trim();
    await setAiKey(v);
    setKey(v);
    setEditing(false);
    setDraft('');
    setResult(null);
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    const res = await generate({ prompt: 'Reply with the single word: ok', maxTokens: 5, temperature: 0, model });
    setResult(res.ok ? 'ok' : res.error);
    setTesting(false);
  };

  return (
    <div className="space-y-1">
      <div className="py-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm">{t('ai.keyLabel')}</div>
          <div className={`text-[0.625rem] ${key ? 'text-text-muted' : 'text-warning'}`}>
            {key ? maskKey(key) : t('settings.notSet')}
          </div>
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button className="chip-micro py-1 press-spring" onClick={() => setEditing((e) => !e)}>
            {key ? t('common.edit') : t('settings.set')}
          </button>
          {key && (
            <button
              className="chip-micro py-1 active:text-danger active:border-danger"
              aria-label={t('common.delete')}
              onClick={async () => {
                await clearAiKey();
                setKey('');
                setResult(null);
              }}
            >
              <Glyph name="close" size={11} />
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="flex gap-2 pb-2">
          <input
            className="input text-sm"
            type="password"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t('ai.keyLabel')}
          />
          <button className="btn px-3 py-2 text-xs" disabled={!draft.trim()} onClick={() => void saveKey()}>
            {t('common.save')}
          </button>
        </div>
      )}
      <div className="text-[0.625rem] text-text-muted px-1 leading-relaxed">{t('ai.keyHelp')}</div>

      <label className="block pt-2">
        <span className="text-sm">{t('ai.model')}</span>
        <input
          className="input text-sm mt-1"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => void setAiModel(model)}
          spellCheck={false}
          autoCapitalize="off"
        />
        <span className="block text-[0.625rem] text-text-muted mt-1">{t('ai.modelHint', { model: DEFAULT_AI_MODEL })}</span>
      </label>

      <div className="flex items-center gap-2 py-2">
        <button className="chip-micro py-1" disabled={!key || testing} onClick={() => void test()}>
          {testing ? t('ai.testing') : t('ai.test')}
        </button>
        {result && (
          <span role="status" className={`text-[0.625rem] ${result === 'ok' ? 'text-success' : 'text-warning'}`}>
            {result === 'ok' ? t('ai.testOk') : t(`ai.err.${result}`)}
          </span>
        )}
      </div>

      {toggle(!key)}
      {key === '' && <div className="text-[0.625rem] text-text-muted px-1">{t('ai.needKey')}</div>}
      {/* Consent has to be informed where it is given, so this sits on the
          switch and not only in the policy. */}
      <div className="text-[0.625rem] text-text-muted px-1 pb-1 leading-relaxed">{t('ai.terms')}</div>
    </div>
  );
}
