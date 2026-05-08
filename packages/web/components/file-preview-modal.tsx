'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, Pencil, Save, X } from 'lucide-react';
import hljs from 'highlight.js/lib/common';
import { cn } from '@/lib/cn';
import { api, type ProjectFile } from '@/lib/api';
import { useTranslation } from '../lib/i18n';

/**
 * Read-only modal that previews any file inside the session's cwd. Used
 * by the file-sidebar tree AND the right-sidebar "Files Touched" panel —
 * anywhere the
 * operator wants to peek at a path without bouncing to an editor.
 *
 * Closes on Esc, on the X button, or on backdrop click. The header
 * exposes a copy-path button so the path is one click away from the
 * clipboard. Highlight.js paints the body via the github-dark theme
 * imported in globals.css.
 */
export function FilePreviewModal({
  sessionId,
  path,
  onClose,
  editable = false,
}: {
  sessionId: string;
  path: string;
  onClose: () => void;
  /** If true, modal opens in edit mode and exposes a Save button. */
  editable?: boolean;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<ProjectFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  const [editing, setEditing] = useState(editable);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    setSaveError(null);
    api
      .readProjectFile(sessionId, path)
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        setDraft(f.content);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose();
      if (e.key === 's' && (e.metaKey || e.ctrlKey) && editing) {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, editing, draft]);

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    } catch {
      /* silent */
    }
  };

  /**
   * Persist the current draft. Backend enforces extension whitelist + size
   * cap + path sandbox; we surface its error message verbatim so the
   * operator knows why a save was rejected.
   */
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api.writeProjectFile(sessionId, path, draft);
      // Reflect the saved content as the new "loaded" baseline.
      setFile({ path: r.path, size: r.size, content: draft });
      setEditing(false);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = file != null && editing && draft !== file.content;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border rounded-lg w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <FileText size={13} className="text-cyan-400 shrink-0" />
          <code className="text-xs text-zinc-300 truncate flex-1" title={path}>
            {path}
          </code>
          {file && (
            <span className="text-[10px] text-zinc-500 tabular-nums shrink-0">
              {editing ? draft.length : file.size}B
              {dirty && <span className="ml-1 text-amber-400">●</span>}
            </span>
          )}
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-zinc-400 hover:text-zinc-100 p-1 rounded hover:bg-zinc-800/60 flex items-center gap-1 text-[10px]"
              title={t('common.edit')}
            >
              <Pencil size={12} />
            </button>
          )}
          {editing && (
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium',
                dirty && !saving
                  ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
              )}
              title={t('filePreview.save.title')}
            >
              <Save size={11} />
              {saving ? t('common.saving') : t('common.save')}
            </button>
          )}
          <button
            onClick={handleCopyPath}
            className="text-zinc-400 hover:text-zinc-100 p-1 rounded hover:bg-zinc-800/60 flex items-center gap-1 text-[10px]"
            title={pathCopied ? t('common.copied') : t('filePreview.copyPath')}
          >
            {pathCopied ? (
              <Check size={12} className="text-emerald-400" />
            ) : (
              <Copy size={12} />
            )}
          </button>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 p-1 rounded hover:bg-zinc-800/60"
            aria-label={t('filePreview.close')}
          >
            <X size={14} />
          </button>
        </div>
        {saveError && (
          <div className="px-3 py-1.5 text-[11px] text-red-400 bg-red-950/40 border-b border-red-900/50">
            {t('filePreview.error.saveFailed', { error: saveError ?? '' })}
          </div>
        )}
        <div className="flex-1 overflow-hidden flex flex-col">
          {error && <div className="p-4 text-xs text-red-400">{error}</div>}
          {!file && !error && (
            <div className="p-4 text-xs text-zinc-500 italic">{t('common.loading')}</div>
          )}
          {file && !editing && <PreviewBody path={path} content={file.content} />}
          {file && editing && (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="flex-1 bg-bg-subtle p-3 text-[12px] leading-[16px] font-mono text-zinc-100 outline-none resize-none scrollbar-thin"
              autoFocus
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ path, content }: { path: string; content: string }) {
  const codeRef = useRef<HTMLElement>(null);
  const lang = languageFromPath(path);
  useEffect(() => {
    const el = codeRef.current;
    if (!el) return;
    try {
      el.innerHTML = lang
        ? hljs.highlight(content, { language: lang, ignoreIllegals: true }).value
        : escapeHtml(content);
    } catch {
      el.textContent = content;
    }
  }, [content, lang]);
  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <pre className="bg-bg-subtle p-3 text-[12px] leading-[16px] font-mono text-zinc-200 whitespace-pre-wrap break-words m-0">
        <code ref={codeRef} className={cn('hljs', lang ? `language-${lang}` : 'plaintext')} />
      </pre>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function languageFromPath(p: string): string | null {
  const lower = p.toLowerCase();
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs'))
    return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'bash';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.toml')) return 'ini';
  return null;
}
