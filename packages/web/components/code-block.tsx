'use client';

import { Children, isValidElement, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, Maximize2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';

/**
 * Drop-in replacement for `<pre>` inside the bubble-md markdown renderer.
 *
 * Three behaviours the operator wanted that the default markdown `<pre>`
 * doesn't give us:
 *
 *   1. **Nowrap + horizontal scroll** — long diff / README lines stay on
 *      one row (no implicit reflow); a horizontal scrollbar appears on
 *      hover/scroll so the operator can pan through wide content
 *      without it pushing every line into a vertical mess.
 *
 *   2. **Header bar** — language tag on the left, a copy-to-clipboard
 *      button and a "view full" expand button on the right. Lets the
 *      operator yank or open a long block without scrolling around.
 *
 *   3. **Vertical separation** — a generous `my-3` margin so the block
 *      reads as a distinct element in the timeline, not a wall.
 *
 * The full-screen modal opens on the expand button, shows the same
 * highlighted content with vertical AND horizontal scroll, closes on Esc
 * / backdrop click / X. The body content rendered is exactly the
 * children we received (already highlight.js-processed by rehype), so
 * syntax colours carry over to the modal too.
 */
export function CodeBlock({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const language = readLanguage(children);
  const codeText = nodeToText(children);
  const [copied, setCopied] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  };

  return (
    <>
      <div className="code-block my-3 rounded-md border border-zinc-700 bg-zinc-950/70 overflow-hidden">
        <div className="flex items-center justify-between px-2.5 py-1 bg-zinc-800/80 border-b border-zinc-700">
          <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-300 font-semibold">
            {language || t('codeBlock.fallback')}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setModalOpen(true)}
              className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60"
              aria-label={t('codeBlock.viewFull')}
              title={t('codeBlock.viewFull')}
            >
              <Maximize2 size={11} />
            </button>
            <button
              onClick={handleCopy}
              className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60"
              aria-label={t('codeBlock.copyCode')}
              title={copied ? t('common.copied') : t('codeBlock.copyCode')}
            >
              {copied ? <Check size={11} className="text-emerald-300" /> : <Copy size={11} />}
            </button>
          </div>
        </div>
        <pre
          className="m-0 overflow-x-auto scrollbar-thin"
          style={{
            whiteSpace: 'pre',
            wordBreak: 'normal',
            overflowWrap: 'normal',
            padding: '0.6em 0.85em',
            background: 'transparent',
            border: 'none',
            maxWidth: '100%',
          }}
        >
          {children}
        </pre>
      </div>
      {modalOpen && (
        <CodeModal
          language={language}
          codeText={codeText}
          rendered={children}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Full-viewport modal showing the same highlighted code at a comfortable
 * reading size with both axes scrollable. Uses the rendered (highlighted)
 * children directly so we don't re-run highlight.js — the modal looks
 * identical to the inline block, just larger.
 */
function CodeModal({
  language,
  codeText,
  rendered,
  onClose,
}: {
  language: string;
  codeText: string;
  rendered: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* silent */
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border rounded-lg w-full max-w-5xl max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-elevated">
          <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-200 font-semibold flex-1">
            {language || t('codeBlock.fallback')}
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-zinc-300 hover:text-white hover:bg-zinc-700/60"
          >
            {copied ? (
              <>
                <Check size={12} className="text-emerald-400" />
                {t('common.copied')}
              </>
            ) : (
              <>
                <Copy size={12} />
                {t('common.copy')}
              </>
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-zinc-400 hover:text-zinc-100"
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>
        <pre
          className={cn(
            'flex-1 m-0 overflow-auto scrollbar-thin font-mono text-zinc-200',
            'p-4 bg-zinc-950',
          )}
          style={{
            whiteSpace: 'pre',
            wordBreak: 'normal',
            overflowWrap: 'normal',
            fontSize: '13px',
            lineHeight: '18px',
          }}
        >
          {rendered}
        </pre>
      </div>
    </div>
  );
}

/**
 * Pull the language hint from the inner `<code>` element's className —
 * react-markdown attaches `language-xxx` based on the fence's info string.
 */
function readLanguage(children: ReactNode): string {
  const code = Children.toArray(children).find(isValidElement) as
    | { props: { className?: string } }
    | undefined;
  if (!code) return '';
  const m = (code.props.className ?? '').match(/language-([\w-]+)/);
  return m?.[1] ?? '';
}

/**
 * Walk the rendered React tree and concatenate every text node. The
 * code is rehype-highlighted by the time we receive it (a bunch of
 * `<span>` syntax tokens), so we can't read a single string prop —
 * have to traverse.
 */
function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToText(node.props.children);
  }
  return '';
}
