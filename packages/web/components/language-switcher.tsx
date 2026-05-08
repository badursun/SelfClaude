'use client';

import { useTranslation, type Locale } from '../lib/i18n';

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
};

export function LanguageSwitcher() {
  const { locale, setLocale, supportedLocales, t } = useTranslation();

  return (
    <div className="flex items-center gap-3">
      <label className="text-xs text-zinc-400 whitespace-nowrap">
        {t('languageSwitcher.label')}
      </label>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="bg-zinc-800 text-zinc-200 text-sm rounded px-2 py-1 border border-zinc-700 focus:outline-none focus:border-zinc-500"
      >
        {supportedLocales.map((loc) => (
          <option key={loc} value={loc}>
            {LOCALE_LABELS[loc]}
          </option>
        ))}
      </select>
    </div>
  );
}
