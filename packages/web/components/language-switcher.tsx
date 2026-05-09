'use client';

import { Globe } from 'lucide-react';
import { useTranslation, type Locale } from '../lib/i18n';

/**
 * Header-mounted locale picker. Designed to sit next to the primary
 * "Open Project" CTA on the home page header — same height + radius
 * as the cyan button, but rendered in a ghost/secondary visual
 * weight (transparent bg, border-on-hover, no fill) so the eye
 * still tracks the CTA as primary.
 *
 * The native `<select>` keeps OS-aware dropdown behaviour (better
 * a11y than a custom overlay); we restyle the closed state only.
 * `appearance-none` strips the platform caret so we can render
 * a Globe icon in its place.
 */

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
};

export function LanguageSwitcher() {
  const { locale, setLocale, supportedLocales } = useTranslation();

  return (
    <div className="relative inline-flex items-center">
      <Globe
        size={14}
        className="absolute left-2.5 text-zinc-400 pointer-events-none"
        aria-hidden="true"
      />
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        aria-label="language"
        className="
          appearance-none
          bg-transparent hover:bg-bg-elevated
          text-zinc-300 hover:text-zinc-100
          text-sm font-medium
          rounded-md
          pl-8 pr-7 py-2
          border border-border hover:border-border-strong
          focus:outline-none focus:ring-1 focus:ring-cyan-500/40 focus:border-cyan-700/40
          cursor-pointer transition-colors
        "
      >
        {supportedLocales.map((loc) => (
          <option key={loc} value={loc} className="bg-zinc-900 text-zinc-200">
            {LOCALE_LABELS[loc]}
          </option>
        ))}
      </select>
      {/* Caret — flat unicode chevron rendered in zinc to match the dark
          theme. Cheaper than an SVG asset and matches the rest of the
          UI's typographic style. */}
      <span
        aria-hidden="true"
        className="absolute right-2 text-[10px] text-zinc-500 pointer-events-none"
      >
        ▾
      </span>
    </div>
  );
}
