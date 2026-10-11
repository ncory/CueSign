import { useEffect, useState } from 'react';
import type { Media, Playlist } from './types';

export function Thumb({ media }: { media?: Media }) {
  if (!media) return <div className="thumb empty" />;
  return media.kind === 'image' ? (
    <img className="thumb" src={media.url} alt="" loading="lazy" />
  ) : (
    // "#t=" makes the browser show a frame from the video instead of a blank box.
    <video className="thumb" src={`${media.url}#t=0.5`} preload="metadata" muted />
  );
}

/** Text input that saves when you leave it or press Enter, and reverts on Escape or if left empty. */
export function TextField(props: { value: string; onCommit: (value: string) => void; className?: string; label: string }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== props.value) props.onCommit(next);
    else setDraft(props.value);
  };

  return (
    <input
      className={props.className}
      aria-label={props.label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(props.value);
      }}
    />
  );
}

export function formatSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function formatCountdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Re-renders the caller on an interval while enabled, for countdowns. */
export function useNow(enabled: boolean, intervalMs = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
  return enabled ? now : Date.now();
}

/** Warns before the page is closed or reloaded while there are unsaved edits. */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

/** The last part of a folder path. */
export function folderName(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function parentFolder(path: string) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** The media a screen shows at a cue: its own cell or, when empty cells hold, the nearest filled cell above. */
export function mediaIdAt(playlist: Playlist, screenId: string, index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const cell = playlist.cues[i]?.cells[screenId];
    if (cell) return cell;
    if (playlist.emptyCells !== 'hold') return null;
  }
  return null;
}

/** The column a player is on. A player loaded on a screen the playlist lacks wraps round. */
export function screenOf(playlist: Playlist, screen: number) {
  return playlist.screens[screen % playlist.screens.length];
}
