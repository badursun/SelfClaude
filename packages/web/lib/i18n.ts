'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import en from '../locales/en.json';
import tr from '../locales/tr.json';

export type TranslationKey = keyof typeof en;
export type Locale = 'en' | 'tr';

const LOCALE_KEY = 'selfclaude.locale';
const CATALOGS: Record<Locale, Record<string, unknown>> = { en, tr };
const SUPPORTED: Locale[] = ['en', 'tr'];

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/**
 * The store ALWAYS starts as `en` — both on the server and on the
 * client's first render. Hydrating from localStorage in the initial
 * state would make the client's first render disagree with the
 * server's HTML (the server has no localStorage), tripping React's
 * hydration mismatch check on every translated string.
 *
 * The real locale (whatever the user picked last) is applied via
 * `useEffect` in `useTranslation()` after hydration completes — see
 * the module-level `hydrationStarted` guard below.
 */
export const useI18nStore = create<I18nState>((set) => ({
  locale: 'en',
  setLocale: (locale) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOCALE_KEY, locale);
      document.documentElement.lang = locale;
    }
    set({ locale });
  },
}));

/**
 * Run-once gate: the first `useTranslation()` mount on the client
 * reads the saved locale and feeds it back through `setLocale`.
 * Subsequent mounts skip the effect body — the store is already in
 * the right state, and reading localStorage every mount would cost
 * for no reason.
 */
let hydrationStarted = false;
function hydrateLocaleFromStorage(setLocale: (l: Locale) => void): void {
  if (hydrationStarted || typeof window === 'undefined') return;
  hydrationStarted = true;
  const saved = localStorage.getItem(LOCALE_KEY);
  if (saved && SUPPORTED.includes(saved as Locale)) {
    setLocale(saved as Locale);
  }
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    key in vars ? String(vars[key]) : `{${key}}`,
  );
}

function resolveValue(catalog: Record<string, unknown>, key: string): string {
  const val = catalog[key] ?? (en as Record<string, unknown>)[key];
  if (typeof val === 'string') return val;
  return key;
}

export function useTranslation() {
  const { locale, setLocale } = useI18nStore();
  // Run-once on the client to swap from the SSR-safe default ("en")
  // to the user's saved locale. This is the second half of the
  // hydration-safety story; see `hydrateLocaleFromStorage` above.
  useEffect(() => {
    hydrateLocaleFromStorage(setLocale);
  }, [setLocale]);
  const catalog = CATALOGS[locale as Locale] ?? en;

  function t(key: TranslationKey, vars?: Record<string, string | number>): string {
    const template = resolveValue(catalog as Record<string, unknown>, key as string);
    return vars ? interpolate(template, vars) : template;
  }

  function tArray(key: TranslationKey): string[] {
    const val = (catalog as Record<string, unknown>)[key as string]
      ?? (en as Record<string, unknown>)[key as string];
    if (Array.isArray(val)) return val as string[];
    if (typeof val === 'string') return [val];
    return [key as string];
  }

  function plural(
    baseKey: string,
    count: number,
    vars?: Record<string, string | number>,
  ): string {
    const suffix = count === 1 ? '_one' : '_other';
    const template = resolveValue(
      catalog as Record<string, unknown>,
      `${baseKey}${suffix}`,
    );
    return interpolate(template, { count, ...vars });
  }

  return { t, tArray, plural, locale, setLocale, supportedLocales: SUPPORTED };
}

export function getTranslation(key: string): string {
  const locale = useI18nStore.getState().locale;
  const catalog = CATALOGS[locale as Locale] ?? en;
  return resolveValue(catalog as Record<string, unknown>, key);
}
