import { useTranslation } from 'react-i18next';
import { checkPassword, PASSWORD_MIN_LENGTH } from '../lib/passwordPolicy';
import '../i18n/passwordStrings'; // the auth.pw* strings (loaded on demand)

// v1.20 (limecore#73) — the password rule, shown before the server refuses it.
// Each item ticks as you type. `flagMissing` is set once a submit has failed on
// the rule, so the items still open turn to the danger colour instead of
// waiting quietly in grey. The submit button itself stays enabled.
const LABELS: Record<string, string> = {
  length: 'auth.pwRuleLength',
  lower: 'auth.pwRuleLower',
  upper: 'auth.pwRuleUpper',
  digit: 'auth.pwRuleDigit',
  symbol: 'auth.pwRuleSymbol',
};

export function PasswordChecklist({ password, flagMissing = false, id }: { password: string; flagMissing?: boolean; id?: string }) {
  const { t } = useTranslation();
  return (
    <ul id={id} aria-label={t('auth.pwRulesLabel')} className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[0.625rem] tracking-wide">
      {checkPassword(password).map(({ id: rule, ok }) => (
        <li
          key={rule}
          className={`inline-flex items-center gap-1 transition-colors ${ok ? 'text-success' : flagMissing ? 'text-danger' : 'text-text-muted'}`}
        >
          <span aria-hidden="true" className="inline-block w-[1em] text-center font-bold">{ok ? '✓' : '·'}</span>
          {t(LABELS[rule], { n: PASSWORD_MIN_LENGTH })}
          {ok && <span className="sr-only">{` — ${t('auth.pwRuleMet')}`}</span>}
        </li>
      ))}
    </ul>
  );
}
