import { useState } from 'react';
import { api, savePlaylist } from './api';
import { TextField, Thumb } from './common';
import type { Playlist, Snapshot } from './types';

function Editor({ playlist, show }: { playlist: Playlist; show: Snapshot }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const save = (patch: Partial<Playlist>) => savePlaylist({ ...playlist, ...patch });
  const mediaOf = (mediaId: string) => show.media.find((m) => m.id === mediaId);
  const usedBy = show.players.filter((p) => p.playlistId === playlist.id).length;

  const move = (from: number, to: number) => {
    if (from === to) return;
    const items = [...playlist.items];
    items.splice(to, 0, ...items.splice(from, 1));
    save({ items });
  };

  return (
    <div className="editor">
      <div className="editor-head">
        <TextField className="title" label="Playlist name" value={playlist.name} onCommit={(name) => save({ name })} />
        <button
          className="danger"
          onClick={() => {
            const warning = usedBy ? ` It is assigned to ${usedBy} player(s), which will go blank.` : '';
            if (confirm(`Delete playlist "${playlist.name}"?${warning}`)) api('DELETE', `/api/playlists/${playlist.id}`);
          }}
        >
          Delete
        </button>
      </div>

      <div className="options">
        <label>
          <input type="checkbox" checked={playlist.loop} onChange={(e) => save({ loop: e.target.checked })} />
          Loop back to the start after the last item
        </label>
        <label>
          Fade
          <input
            type="number"
            min={0}
            max={10000}
            step={100}
            key={playlist.fadeMs}
            defaultValue={playlist.fadeMs}
            onBlur={(e) => save({ fadeMs: Number(e.target.value) || 0 })}
          />
          ms
        </label>
      </div>

      <p className="muted">
        Durations apply while a player's timer is running. Leave one blank and an image waits for a manual cue, while a
        video plays to its end.
      </p>

      {playlist.items.length === 0 && <p className="muted">This playlist is empty. Add items from the library below.</p>}
      <ol className="items">
        {playlist.items.map((item, index) => {
          const media = mediaOf(item.mediaId);
          return (
            <li
              key={item.id}
              draggable
              className={dragging === index ? 'dragging' : ''}
              onDragStart={() => setDragging(index)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging !== null) move(dragging, index);
                setDragging(null);
              }}
            >
              <span className="handle" title="Drag to reorder">
                ⠿
              </span>
              <span className="num">{index + 1}</span>
              <Thumb media={media} />
              <span className="grow">{media?.name}</span>
              <span className="muted">{media?.kind}</span>
              <input
                type="number"
                min={0}
                step={1}
                aria-label="Duration in seconds"
                placeholder={media?.kind === 'video' ? 'to end' : 'hold'}
                key={item.duration ?? 'none'}
                defaultValue={item.duration ?? ''}
                onBlur={(e) => {
                  const duration = Number(e.target.value) > 0 ? Number(e.target.value) : null;
                  if (duration !== item.duration)
                    save({ items: playlist.items.map((i) => (i.id === item.id ? { ...i, duration } : i)) });
                }}
              />
              <span className="muted">s</span>
              <button className="quiet" disabled={index === 0} onClick={() => move(index, index - 1)} title="Move up">
                ↑
              </button>
              <button
                className="quiet"
                disabled={index === playlist.items.length - 1}
                onClick={() => move(index, index + 1)}
                title="Move down"
              >
                ↓
              </button>
              <button
                className="quiet"
                title="Remove from playlist"
                onClick={() => save({ items: playlist.items.filter((i) => i.id !== item.id) })}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ol>

      <h3>Add from library</h3>
      {show.media.length === 0 && <p className="muted">The library is empty. Upload files on the Media tab.</p>}
      <div className="picker">
        {show.media.map((media) => (
          <button
            key={media.id}
            title={`Add ${media.name}`}
            onClick={() => save({ items: [...playlist.items, { id: '', mediaId: media.id, duration: null }] })}
          >
            <Thumb media={media} />
            <span>{media.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Playlists({ show }: { show: Snapshot }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = show.playlists.find((p) => p.id === selectedId) ?? show.playlists[0];

  const create = async () => {
    const created = await api<Playlist>('POST', '/api/playlists', { name: `Playlist ${show.playlists.length + 1}` });
    if (created) setSelectedId(created.id);
  };

  return (
    <div className="split">
      <aside>
        {show.playlists.map((playlist) => (
          <button
            key={playlist.id}
            className={playlist.id === selected?.id ? 'row active' : 'row'}
            onClick={() => setSelectedId(playlist.id)}
          >
            <span className="grow">{playlist.name}</span>
            <span className="muted">{playlist.items.length}</span>
          </button>
        ))}
        <button className="primary" onClick={create}>
          New playlist
        </button>
      </aside>
      {selected ? <Editor key={selected.id} playlist={selected} show={show} /> : <p className="muted">Create a playlist to get started.</p>}
    </div>
  );
}
