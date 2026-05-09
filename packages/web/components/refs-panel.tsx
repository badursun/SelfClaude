'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, Loader2, Paperclip, Trash2, Upload, X } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';

/**
 * Operator-attached reference documents — sup sees a manifest of
 * these in its system prompt every turn and reads file contents
 * lazily with the Read tool.
 *
 * UX shape: a list of currently-attached files + a drop zone /
 * pick-file affordance. No preview here; the operator already has
 * the file on disk and download brings it back if needed. Adds and
 * removes round-trip through the backend immediately so a refresh
 * always reflects what's actually on disk.
 */

interface RefMeta {
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export function RefsPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [refs, setRefs] = useState<RefMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listRefs(sessionId);
      setRefs(r.refs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        for (const f of Array.from(files)) {
          await api.uploadRef(sessionId, f);
        }
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [sessionId, refresh],
  );

  const remove = useCallback(
    async (name: string) => {
      setBusy(true);
      setError(null);
      try {
        await api.removeRef(sessionId, name);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [sessionId, refresh],
  );

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void upload(e.dataTransfer.files);
  };

  return (
    <div className="h-full flex flex-col text-[11px]">
      {/* Drop zone — full-width affordance at the top. Click opens the
          native picker; drop accepts the same multi-file payload. */}
      <div
        className={cn(
          'm-2 mb-1 border-2 border-dashed rounded-md p-3 transition-colors cursor-pointer',
          'flex flex-col items-center justify-center gap-1.5 text-zinc-400',
          dragOver
            ? 'border-cyan-500/70 bg-cyan-950/20 text-cyan-200'
            : 'border-border hover:border-border-strong hover:bg-bg-elevated/40',
          busy && 'opacity-60 cursor-wait',
        )}
        onClick={() => !busy && fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {busy ? (
          <Loader2 size={20} className="animate-spin text-cyan-300" />
        ) : (
          <Upload size={20} />
        )}
        <div className="text-center leading-tight">
          <div className="font-medium">{t('refsPanel.drop.title')}</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">{t('refsPanel.drop.hint')}</div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void upload(e.target.files);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <div className="mx-2 mb-1 px-2 py-1.5 rounded border border-rose-900/60 bg-rose-950/30 text-rose-200 text-[10px] flex items-start gap-1.5">
          <X size={12} className="shrink-0 mt-0.5" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
        {refs === null ? (
          <div className="text-zinc-500 text-center py-4">
            <Loader2 size={14} className="inline animate-spin" />
          </div>
        ) : refs.length === 0 ? (
          <div className="text-zinc-500 text-center py-4 leading-relaxed">
            <Paperclip size={14} className="inline opacity-60 mr-1" />
            {t('refsPanel.empty')}
          </div>
        ) : (
          <ul className="space-y-1">
            {refs.map((r) => (
              <RefRow
                key={r.name}
                meta={r}
                downloadUrl={api.refDownloadUrl(sessionId, r.name)}
                onRemove={() => void remove(r.name)}
                disabled={busy}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="px-2 pb-2 text-[10px] text-zinc-600 border-t border-border pt-1.5 leading-relaxed">
        {t('refsPanel.supNote')}
      </div>
    </div>
  );
}

function RefRow({
  meta,
  downloadUrl,
  onRemove,
  disabled,
}: {
  meta: RefMeta;
  downloadUrl: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li className="group flex items-center gap-2 rounded border border-border/50 bg-bg-panel/40 hover:bg-bg-elevated/60 hover:border-border px-2 py-1.5 transition-colors">
      <FileText size={12} className="shrink-0 text-zinc-400" />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-zinc-200 truncate">{meta.name}</div>
        <div className="text-[9px] font-mono text-zinc-500 tabular-nums">
          {humanSize(meta.sizeBytes)}
        </div>
      </div>
      <a
        href={downloadUrl}
        download={meta.name}
        className="shrink-0 p-1 rounded text-zinc-500 hover:text-cyan-300 hover:bg-cyan-950/30 opacity-0 group-hover:opacity-100 transition-opacity"
        title={t('refsPanel.row.download')}
        aria-label={t('refsPanel.row.download')}
      >
        <Download size={11} />
      </a>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className={cn(
          'shrink-0 p-1 rounded text-zinc-500 hover:text-rose-300 hover:bg-rose-950/30',
          'opacity-0 group-hover:opacity-100 transition-opacity',
          disabled && 'cursor-wait opacity-30',
        )}
        title={t('refsPanel.row.remove')}
        aria-label={t('refsPanel.row.remove')}
      >
        <Trash2 size={11} />
      </button>
    </li>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
