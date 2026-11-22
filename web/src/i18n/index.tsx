import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MESSAGES, type Locale, type Messages } from './messages';

export const LOCALE_STORAGE_KEY = 'vibebaton.locale';

export function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export interface I18nContextValue {
  locale: Locale;
  setLocale(next: Locale): void;
  messages: Messages;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  messages: MESSAGES.en,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // Ignore storage errors in restricted contexts.
      }
    }
  }, []);

  const messages = MESSAGES[locale];

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = locale;
    document.title = messages.docTitle;
  }, [locale, messages.docTitle]);

  const value = useMemo(() => ({ locale, setLocale, messages }), [locale, setLocale, messages]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
