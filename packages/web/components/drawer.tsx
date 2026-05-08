'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';
import type { PendingQuestion } from '@/lib/types';

/**
 * Centered modal for pending `ask_user` questions. Two modes driven by
 * the question text:
 *
 *  - **Single mode** — one textarea. Used when sup asks one question
 *    in plain prose.
 *
 *  - **Multi mode** — when sup writes a numbered list (lines starting
 *    `N.`), the parser splits it into N separate questions and the
 *    modal renders one textarea per question. Operator can answer
 *    each in its own field; on submit the answers are joined back in
 *    the same `N.` shape so sup can map answer → question by index.
 *
 * Per the supervisor prompt, sup is required to bundle related
 * questions into one `ask_user` call (using the numbered list format)
 * rather than firing N separate calls — this keeps round-trips down
 * AND gives the operator a focused multi-input modal in one go.
 *
 * Keyboard: `⌘↵` / `Ctrl+↵` submits, `Esc` dismisses (sends empty
 * string back so sup doesn't deadlock — it gets the empty answer and
 * either re-asks or moves on).
 */
export function Drawer({
  question,
  onAnswer,
}: {
  question: PendingQuestion | null;
  onAnswer: (questionId: string, answer: string) => void;
}) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parseQuestions(question?.question ?? ''), [question?.question]);
  const isMulti = parsed.questions.length >= 2;

  // Drafts: single-mode uses index 0; multi-mode uses one slot per
  // question. Keyed by question.id so a fresh question resets state.
  const [drafts, setDrafts] = useState<string[]>([]);
  const firstFieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!question) return;
    setDrafts(Array(Math.max(1, parsed.questions.length)).fill(''));
    setTimeout(() => firstFieldRef.current?.focus(), 50);
  }, [question?.id, parsed.questions.length]);

  useEffect(() => {
    if (!question) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onAnswer(question.id, '');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [question, onAnswer]);

  if (!question) return null;

  const updateDraft = (idx: number, value: string) => {
    setDrafts((cur) => cur.map((d, i) => (i === idx ? value : d)));
  };

  const buildAnswer = (): string => {
    if (!isMulti) {
      return drafts[0]?.trim() ?? '';
    }
    // Re-emit in the same `N. answer` shape the supervisor sent. Empty
    // slots get a placeholder so the index map is preserved.
    return parsed.questions
      .map((q, i) => {
        const ans = drafts[i]?.trim() ?? '';
        return `${q.num}. ${ans.length > 0 ? ans : t('drawer.noAnswer')}`;
      })
      .join('\n');
  };

  const handleSubmit = () => {
    // Require at least one non-empty draft to avoid accidental empty
    // submits. In multi-mode, all-empty triggers the same empty path.
    const anyAnswered = drafts.some((d) => d.trim().length > 0);
    if (!anyAnswered) return;
    onAnswer(question.id, buildAnswer());
  };

  const handleQuickReply = (opt: string) => {
    onAnswer(question.id, opt);
  };

  const allFilled =
    !isMulti
      ? (drafts[0]?.trim().length ?? 0) > 0
      : drafts.every((d) => d.trim().length > 0);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onAnswer(question.id, '');
      }}
    >
      <div
        className={cn(
          'w-[min(720px,100%)] max-h-[90vh] flex flex-col rounded-lg border border-yellow-700/50 bg-bg shadow-2xl shadow-yellow-900/20 overflow-hidden',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-yellow-700/40 bg-yellow-950/30 flex items-center gap-2">
          <HelpCircle size={16} className="text-yellow-400 shrink-0" />
          <h2 className="flex-1 text-[13px] font-mono font-semibold text-yellow-200">
            {t('drawer.title')}
            {isMulti && (
              <span className="ml-2 text-[10px] uppercase tracking-widest font-mono text-yellow-400">
                {t('drawer.questionCount', { count: parsed.questions.length })}
              </span>
            )}
            {question.urgency === 'high' && (
              <span className="ml-2 text-[10px] uppercase tracking-widest font-bold text-red-400">
                {t('drawer.urgent')}
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={() => onAnswer(question.id, '')}
            className="text-yellow-500/60 hover:text-yellow-200 w-7 h-7 flex items-center justify-center rounded hover:bg-yellow-900/30"
            aria-label={t('common.dismiss')}
            title={t('drawer.dismiss.title')}
          >
            <X size={14} />
          </button>
        </header>

        {/* Body — single mode: one prose block. Multi: intro + N labelled textareas. */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {!isMulti ? (
            <div className="px-5 py-4">
              <p className="text-[13px] leading-relaxed font-mono text-zinc-100 whitespace-pre-wrap break-words">
                {question.question}
              </p>
              {question.options && question.options.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {question.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => handleQuickReply(opt)}
                      className="px-3 py-1.5 text-[12px] font-mono rounded border border-yellow-700/50 bg-yellow-950/40 text-yellow-100 hover:bg-yellow-900/40"
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="px-5 py-4 space-y-4">
              {parsed.intro.length > 0 && (
                <p className="text-[12px] leading-relaxed font-mono text-zinc-300 whitespace-pre-wrap break-words">
                  {parsed.intro}
                </p>
              )}
              {parsed.questions.map((q, i) => (
                <div key={`${q.num}-${i}`} className="space-y-1.5">
                  <label className="block">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="shrink-0 text-[10px] font-mono uppercase tracking-widest font-bold text-yellow-400 tabular-nums">
                        Q{q.num}
                      </span>
                      <span className="text-[12px] leading-relaxed font-mono text-zinc-100 whitespace-pre-wrap break-words">
                        {q.text}
                      </span>
                    </div>
                    <textarea
                      ref={i === 0 ? firstFieldRef : undefined}
                      value={drafts[i] ?? ''}
                      onChange={(e) => updateDraft(i, e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                      placeholder={t('drawer.placeholder.multi', { num: q.num })}
                      rows={2}
                      className="w-full bg-bg-subtle border border-border rounded-md px-3 py-2 text-[12px] font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-yellow-600 resize-none leading-relaxed"
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Single-mode footer hosts the textarea + submit. Multi-mode
            footer just hosts submit (textareas live inline above). */}
        <footer className="px-5 py-3 border-t border-yellow-700/40 bg-bg-subtle/30 space-y-2">
          {!isMulti && (
            <textarea
              ref={firstFieldRef}
              value={drafts[0] ?? ''}
              onChange={(e) => updateDraft(0, e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={t('drawer.placeholder.single')}
              rows={3}
              className="w-full bg-bg-subtle border border-border rounded-md px-3 py-2 text-[12px] font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-yellow-600 resize-none leading-relaxed"
            />
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-mono text-zinc-600">
              <kbd className="px-1 bg-bg-elevated rounded text-zinc-400">{t('drawer.shortcut.submit')}</kbd> {t('drawer.shortcut.submitLabel')}
              <span className="mx-2 text-zinc-700">·</span>
              <kbd className="px-1 bg-bg-elevated rounded text-zinc-400">{t('drawer.shortcut.esc')}</kbd> {t('drawer.shortcut.dismissLabel')}
              {isMulti && !allFilled && (
                <>
                  <span className="mx-2 text-zinc-700">·</span>
                  <span className="text-amber-500">
                    {t('drawer.progress', {
                      answered: drafts.filter((d) => d.trim().length > 0).length,
                      total: parsed.questions.length,
                    })}
                  </span>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!drafts.some((d) => d.trim().length > 0)}
              className={cn(
                'px-4 py-1.5 text-[12px] font-mono font-medium rounded border',
                drafts.some((d) => d.trim().length > 0)
                  ? 'border-yellow-600 bg-yellow-700 text-white hover:bg-yellow-600'
                  : 'border-zinc-700 bg-zinc-900/40 text-zinc-600 cursor-not-allowed',
              )}
            >
              {isMulti ? t('drawer.submit.multi') : t('drawer.submit.single')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * Parse a `question` string from `ask_user` into either a single
 * prose chunk or a list of numbered questions. The detection rule:
 * any line that starts with `N.` followed by whitespace + non-empty
 * text is treated as a numbered question; lines after it (until the
 * next numbered line or blank line) belong to the same question as
 * continuation. Lines BEFORE the first numbered line become the
 * `intro` paragraph rendered above the input list.
 *
 * Returns `questions: []` (empty) when no numbered list is detected
 * — the caller switches to single-textarea mode.
 */
function parseQuestions(text: string): {
  intro: string;
  questions: { num: number; text: string }[];
} {
  if (!text) return { intro: '', questions: [] };
  const lines = text.split('\n');
  const NUM_RE = /^\s*(\d+)[.)]\s+(.+)$/;
  const intro: string[] = [];
  const accum: { num: number; lines: string[] }[] = [];
  let current: { num: number; lines: string[] } | null = null;
  let pastIntro = false;
  for (const raw of lines) {
    const m = raw.match(NUM_RE);
    if (m) {
      pastIntro = true;
      if (current) accum.push(current);
      current = { num: parseInt(m[1]!, 10), lines: [m[2]!] };
      continue;
    }
    if (pastIntro && current) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        // blank line ends current; subsequent non-numbered lines
        // become tail (ignored — sup shouldn't put trailing prose).
        continue;
      }
      current.lines.push(trimmed);
    } else {
      intro.push(raw);
    }
  }
  if (current) accum.push(current);

  // Single-question heuristic: if only one numbered item and no real
  // intro, fall back to single mode (the operator is better off
  // typing one answer in one box).
  if (accum.length < 2) {
    return { intro: '', questions: [] };
  }

  return {
    intro: intro.join('\n').replace(/\s+$/, '').trim(),
    questions: accum.map((q) => ({ num: q.num, text: q.lines.join(' ').trim() })),
  };
}
