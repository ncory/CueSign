import { useEffect, useState } from 'react';
import type { CueAction, Playlist, Snapshot } from './types';

/** Failed requests are reported through this event so the app can show one banner. */
export const ERROR_EVENT = 'cuesign-error';

function report(message: string) {
  window.dispatchEvent(new CustomEvent(ERROR_EVENT, { detail: message }));
}

export async function api<T = void>(method: string, path: string, body?: unknown): Promise<T | undefined> {
  try {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status})`);
    return response.status === 204 ? undefined : ((await response.json()) as T);
  } catch (e) {
    report(e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

export function cue(target: 'players' | 'groups', id: string, action: CueAction, extra?: { index?: number; on?: boolean }) {
  return api('POST', `/api/${target}/${encodeURIComponent(id)}/cue`, { action, ...extra });
}

export function savePlaylist(playlist: Playlist) {
  return api('PUT', `/api/playlists/${playlist.id}`, playlist);
}

/** Uploads one file as the raw request body, reporting progress from 0 to 1. */
export function upload(file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/media?name=${encodeURIComponent(file.name)}`);
    request.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    request.onload = () => {
      if (request.status >= 400) {
        let detail = `status ${request.status}`;
        try {
          detail = JSON.parse(request.responseText).detail ?? detail;
        } catch {
          // keep the status code
        }
        report(`${file.name}: ${detail}`);
      }
      resolve();
    };
    request.onerror = () => {
      report(`${file.name}: upload failed`);
      resolve();
    };
    request.send(file);
  });
}

/** Live show state over a WebSocket that reconnects by itself. */
export function useShow() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  // serverTime - local time, so countdowns are right even if this device's clock is off.
  const [clockOffset, setClockOffset] = useState(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/ws/control`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as Snapshot;
        setClockOffset(data.serverTime - Date.now());
        setSnapshot(data);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();

    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return { snapshot, connected, clockOffset };
}
