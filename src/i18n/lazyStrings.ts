// v1.21.1 — strings that load with the screen that uses them, not at startup.
//
// The general form of i18n/passwordStrings.ts (limecore#73). en.json is in the
// startup bundle, whose budget only goes down (scripts/check-bundle-size.mjs),
// so copy that only an on-demand screen shows lives in i18n/lazy/<name>.json
// (all ten languages, the same nested shape as en.json) and is merged into
// i18next when that screen's chunk imports i18n/lazy/<name>.ts. keys.test.ts
// counts these keys as present; lazyStrings.test.ts holds every language to
// the English keys.
//
// Only languages that are already loaded get the strings, plus each one as it
// becomes active: i18n/index.ts skips loading a language that already has a
// bundle, so registering one early would leave the rest of the app in English.
import i18n from 'i18next';

export type LazyStrings = Record<string, Record<string, unknown>>;

export function registerLazyStrings(strings: LazyStrings): void {
  const register = (lng: string) => {
    const tree = strings[lng];
    if (!tree || !i18n.hasResourceBundle(lng, 'translation')) return;
    i18n.addResourceBundle(lng, 'translation', tree, true, true);
  };
  const registerAll = () => Object.keys(strings).forEach(register);
  if (i18n.isInitialized) registerAll();
  else i18n.on('initialized', registerAll);
  i18n.on('languageChanged', register);
}
