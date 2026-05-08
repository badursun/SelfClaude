'use client';

import { create } from 'zustand';
import en from '../locales/en.json';
import tr from '../locales/tr.json';

export type TranslationKey = keyof typeof en;
export type Locale = 'en' | 'tr';

const LOCALE_KEY = 'selfclaude.locale';
const CATALOGS: Record<Locale, Record<string, unknown>> = { en, tr };
const SUPPORTED: Locale[] = ['en', 'tr'];

function loadSavedLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  const saved = localStorage.getItem(LOCALE_KEY);
  return SUPPORTED.includes(saved as Locale) ? (saved as Locale) : 'en';
}

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: loadSavedLocale(),
  setLocale: (locale) => {
    localStorage.setItem(LOCALE_KEY, locale);
    document.documentElement.lang = locale;
    set({ locale });
  },
}));

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
