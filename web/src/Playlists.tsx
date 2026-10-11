import { useEffect, useState } from 'react';
import { api, send } from './api';
import { mediaIdAt, Thumb, useUnsavedWarning } from './common';
import type { Playlist, PlaylistCue, Snapshot } from './types';

const MEDIA_DRAG = 'application/x-cuesign-media';

/** What the server stores for a playlist, in a form that can be compared with a draft. */
function fingerprint(playlist: Playlist) {
  return JSON.stringify([
    playlist.name,
    playlist.loop,
    playlist.fadeMs,
    playlist.emptyCells,
    playlist.screens.map((s) => [s.id, s.name]),
    playlist.cues.map((c) => [c.id, c.duration, playlist.screens.map((s) => c.cells[s.id] ?? null)]),
  ]);
}

// Screens and cues made in the editor get "new-" ids, which the server replaces on save.
let nextNew = 1;
const newId = () => `new-${nextNew++}`;

/** The cell that library items go into. A null cue means the "add cue" row at the bottom. */
interface Target {
  cueId: string | null;
  screenId: string;
}

function Editor(props: {
  playlist: Playlist;
  saved: Playlist;
  dirty: boolean;
  show: Snapshot;
  onEdit: (patch: Partial<Playlist>) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { playlist, show, onEdit } = props;
  const { screens, cues } = playlist;
  const [dragging, setDragging] = useState<number | null>(null);
  const [picked, setPicked] = useState<Target | null>(null);
  const [folder, setFolder] = useState<string | null>(null); // null: every folder
  const [search, setSearch] = useState('');
  const mediaOf = (mediaId: string | null | undefined) => show.media.find((m) => m.id === mediaId);
  const usedBy = show.players.filter((p) => p.playlistId === playlist.id).length;

  // Saving or deleting can leave the remembered target pointing at something that is gone.
  const target: Target = {
    screenId: screens.some((s) => s.id === picked?.screenId) ? picked!.screenId : screens[0].id,
    cueId: cues.some((c) => c.id === picked?.cueId) ? picked!.cueId : null,
  };

  const setCell = (cueId: string | null, screenId: string, mediaId: string) => {
    if (cueId === null) onEdit({ cues: [...cues, { id: newId(), duration: null, cells: { [screenId]: mediaId } }] });
    else onEdit({ cues: cues.map((c) => (c.id === cueId ? { ...c, cells: { ...c.cells, [screenId]: mediaId } } : c)) });
  };

  const clearCell = (cueId: string, screenId: string) =>
    onEdit({ cues: cues.map((c) => (c.id === cueId ? { ...c, cells: without(c.cells, screenId) } : c)) });

  /** Fills the targeted cell, then moves the target down so repeated clicks fill a column. */
  const place = (mediaId: string) => {
    setCell(target.cueId, target.screenId, mediaId);
    if (target.cueId !== null) {
      const next = cues[cues.findIndex((c) => c.id === target.cueId) + 1];
      setPicked({ screenId: target.screenId, cueId: next?.id ?? null });
    }
  };

  const moveCue = (from: number, to: number) => {
    if (from === to) return;
    const moved = [...cues];
    moved.splice(to, 0, ...moved.splice(from, 1));
    onEdit({ cues: moved });
  };

  const removeScreen = (screenId: string) => {
    const name = screens.find((s) => s.id === screenId)?.name;
    const filled = cues.filter((c) => c.cells[screenId]).length;
    if (filled && !confirm(`Remove screen "${name}" and the ${filled} item(s) placed on it?`)) return;
    onEdit({ screens: screens.filter((s) => s.id !== screenId), cues: cues.map((c) => ({ ...c, cells: without(c.cells, screenId) })) });
  };

  /** Copies a column from another playlist into this screen, cue by cue, adding cues if it is longer. */
  const copyColumn = (screenId: string, source: string) => {
    const [playlistId, sourceScreen] = source.split('/');
    const from = show.playlists.find((p) => p.id === playlistId);
    if (!from) return;
    const filled = cues.filter((c) => c.cells[screenId]).length;
    if (filled && !confirm(`Replace the ${filled} item(s) already on this screen?`)) return;

    const rows: PlaylistCue[] = cues.map((c) => ({ ...c, cells: without(c.cells, screenId) }));
    from.cues.forEach((cue, i) => {
      rows[i] ??= { id: newId(), duration: cue.duration, cells: {} };
      if (cue.cells[sourceScreen]) rows[i] = { ...rows[i], cells: { ...rows[i].cells, [screenId]: cue.cells[sourceScreen] } };
    });
    onEdit({ cues: rows });
  };

  /** Lets a cell take a library item dragged onto it. */
  const acceptMedia = (cueId: string | null, screenId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(MEDIA_DRAG)) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      const mediaId = e.dataTransfer.getData(MEDIA_DRAG);
      if (!mediaId) return;
      e.preventDefault();
      e.stopPropagation();
      setCell(cueId, screenId, mediaId);
    },
  });

  const others = show.playlists.filter((p) => p.id !== playlist.id && p.cues.length > 0);
  const library = show.media.filter(
    (m) =>
      (folder === null || m.folder === folder || m.folder.startsWith(`${folder}/`)) &&
      m.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="editor">
      <div className="editor-head">
        <input className="title" aria-label="Playlist name" value={playlist.name} onChange={(e) => onEdit({ name: e.target.value })} />
        <button
          className="danger"
          onClick={() => {
            const warning = usedBy ? ` It is loaded on ${usedBy} player(s), which will go blank.` : '';
            if (confirm(`Delete playlist "${props.saved.name}"?${warning}`)) api('DELETE', `/api/playlists/${playlist.id}`);
          }}
        >
          Delete
        </button>
      </div>

      {props.dirty && (
        <div className="savebar">
          <span>
            Unsaved changes.
            {usedBy > 0 && ` Saving updates ${usedBy} player(s) that have this playlist loaded.`}
          </span>
          <button onClick={props.onDiscard}>Discard</button>
          <button className="primary" disabled={!playlist.name.trim()} onClick={props.onSave}>
            Save
          </button>
        </div>
      )}

      <div className="options">
        <label>
          <input type="checkbox" checked={playlist.loop} onChange={(e) => onEdit({ loop: e.target.checked })} />
          Loop back to the start after the last cue
        </label>
        <label>
          Fade
          <input
            type="number"
            min={0}
            max={10000}
            step={100}
            value={playlist.fadeMs}
            onChange={(e) => onEdit({ fadeMs: Math.max(0, Number(e.target.value) || 0) })}
          />
          ms
        </label>
        <label>
          An empty cell{' '}
          <select value={playlist.emptyCells} onChange={(e) => onEdit({ emptyCells: e.target.value as Playlist['emptyCells'] })}>
            <option value="hold">keeps the previous item on screen</option>
            <option value="black">goes to black</option>
          </select>
        </label>
      </div>

      <p className="muted">
        Each row is a cue: every screen changes together. Durations apply while the timer is running; leave one blank
        and the cue waits for a video to finish or for a manual cue.
      </p>

      <div className="cue-grid-wrap">
        <table className="cue-grid">
          <thead>
            <tr>
              <th className="narrow" />
              <th className="narrow">Seconds</th>
              {screens.map((screen) => (
                <th key={screen.id}>
                  <div className="screen-head">
                    <input
                      aria-label="Screen name"
                      value={screen.name}
                      onChange={(e) => onEdit({ screens: screens.map((s) => (s.id === screen.id ? { ...s, name: e.target.value } : s)) })}
                    />
                    {others.length > 0 && (
                      <select aria-label="Copy a screen from another playlist" value="" onChange={(e) => copyColumn(screen.id, e.target.value)}>
                        <option value="" disabled>
                          Copy from…
                        </option>
                        {others.flatMap((p) =>
                          p.screens.map((s) => (
                            <option key={`${p.id}/${s.id}`} value={`${p.id}/${s.id}`}>
                              {p.screens.length > 1 ? `${p.name} › ${s.name}` : p.name}
                            </option>
                          )),
                        )}
                      </select>
                    )}
                    <button className="quiet" disabled={screens.length === 1} title="Remove this screen" onClick={() => removeScreen(screen.id)}>
                      ✕
                    </button>
                  </div>
                </th>
              ))}
              <th className="narrow">
                <button
                  title="Add a screen"
                  disabled={screens.length >= 16}
                  onClick={() => onEdit({ screens: [...screens, { id: newId(), name: `Screen ${screens.length + 1}` }] })}
                >
                  + Screen
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {cues.map((cue, index) => {
              const hasVideo = screens.some((s) => mediaOf(cue.cells[s.id])?.kind === 'video');
              return (
                <tr
                  key={cue.id}
                  className={dragging === index ? 'dragging' : ''}
                  onDragOver={(e) => dragging !== null && e.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null) moveCue(dragging, index);
                    setDragging(null);
                  }}
                >
                  <td className="narrow">
                    <span
                      className="handle"
                      title="Drag to reorder"
                      draggable
                      onDragStart={() => setDragging(index)}
                      onDragEnd={() => setDragging(null)}
                    >
                      ⠿
                    </span>{' '}
                    <span className="num">{index + 1}</span>
                  </td>
                  <td className="narrow">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      aria-label="Duration in seconds"
                      placeholder={hasVideo ? 'to end' : 'manual'}
                      value={cue.duration ?? ''}
                      onChange={(e) => {
                        const duration = Number(e.target.value) > 0 ? Number(e.target.value) : null;
                        onEdit({ cues: cues.map((c) => (c.id === cue.id ? { ...c, duration } : c)) });
                      }}
                    />
                  </td>
                  {screens.map((screen) => {
                    const media = mediaOf(cue.cells[screen.id]);
                    const held = playlist.emptyCells === 'hold' ? mediaOf(mediaIdAt(playlist, screen.id, index)) : undefined;
                    const isTarget = target.cueId === cue.id && target.screenId === screen.id;
                    return (
                      <td
                        key={screen.id}
                        className={isTarget ? 'cell target' : 'cell'}
                        onClick={() => setPicked({ cueId: cue.id, screenId: screen.id })}
                        {...acceptMedia(cue.id, screen.id)}
                      >
                        {media ? (
                          <div className="cell-body">
                            <Thumb media={media} />
                            <span className="grow">{media.name}</span>
                            <button
                              className="quiet"
                              title="Empty this cell"
                              onClick={(e) => {
                                e.stopPropagation();
                                clearCell(cue.id, screen.id);
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <div className="cell-body empty">{held ? `↑ holds ${held.name}` : 'black'}</div>
                        )}
                      </td>
                    );
                  })}
                  <td className="narrow">
                    <button className="quiet" disabled={index === 0} onClick={() => moveCue(index, index - 1)} title="Move up">
                      ↑
                    </button>
                    <button className="quiet" disabled={index === cues.length - 1} onClick={() => moveCue(index, index + 1)} title="Move down">
                      ↓
                    </button>
                    <button className="quiet" title="Remove this cue" onClick={() => onEdit({ cues: cues.filter((c) => c.id !== cue.id) })}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr className="new-cue">
              <td className="narrow">
                <span className="num">{cues.length + 1}</span>
              </td>
              <td className="narrow" />
              {screens.map((screen) => (
                <td
                  key={screen.id}
                  className={target.cueId === null && target.screenId === screen.id ? 'cell target' : 'cell'}
                  onClick={() => setPicked({ cueId: null, screenId: screen.id })}
                  {...acceptMedia(null, screen.id)}
                >
                  <div className="cell-body empty">+ new cue</div>
                </td>
              ))}
              <td className="narrow" />
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Add from library</h3>
      {show.media.length === 0 ? (
        <p className="muted">The library is empty. Upload files on the Media tab.</p>
      ) : (
        <>
          <p className="muted">
            Click an item to put it in the highlighted cell; the highlight then moves down, so repeated clicks fill a
            screen's column. Click any cell to move the highlight, or drag an item straight onto a cell.
          </p>
          <div className="picker-tools">
            <select aria-label="Folder" value={folder ?? '//all'} onChange={(e) => setFolder(e.target.value === '//all' ? null : e.target.value)}>
              <option value="//all">All folders</option>
              <option value="">Top level only</option>
              {show.folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <input type="search" placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </>
      )}
      {show.media.length > 0 && library.length === 0 && <p className="muted">Nothing matches.</p>}
      <div className="picker">
        {library.map((media) => (
          <button
            key={media.id}
            title={`Add ${media.folder ? `${media.folder}/` : ''}${media.name}`}
            draggable
            onDragStart={(e) => e.dataTransfer.setData(MEDIA_DRAG, media.id)}
            onClick={() => place(media.id)}
          >
            <Thumb media={media} />
            <span>{media.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function without(cells: Record<string, string>, screenId: string) {
  const { [screenId]: _removed, ...rest } = cells;
  return rest;
}

export function Playlists({ show, onUnsaved }: { show: Snapshot; onUnsaved: (dirty: boolean) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Edits live here until saved, keyed by playlist, so switching playlists or tabs keeps them.
  const [drafts, setDrafts] = useState<Record<string, Playlist>>({});
  const selected = show.playlists.find((p) => p.id === selectedId) ?? show.playlists[0];

  /** A draft with any cells whose media has since been deleted from the library emptied. */
  const draftOf = (saved: Playlist): Playlist | undefined => {
    const draft = drafts[saved.id];
    if (!draft) return undefined;
    const known = new Set(show.media.map((m) => m.id));
    return {
      ...draft,
      cues: draft.cues.map((c) => ({ ...c, cells: Object.fromEntries(Object.entries(c.cells).filter(([, id]) => known.has(id))) })),
    };
  };
  const isDirty = (saved: Playlist) => {
    const draft = draftOf(saved);
    return !!draft && fingerprint(draft) !== fingerprint(saved);
  };
  const anyDirty = show.playlists.some(isDirty);

  useEffect(() => onUnsaved(anyDirty), [anyDirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useUnsavedWarning(anyDirty);

  const discard = (id: string) => setDrafts(({ [id]: _gone, ...rest }) => rest);

  const save = async (playlist: Playlist) => {
    if (await send('PUT', `/api/playlists/${playlist.id}`, { ...playlist, name: playlist.name.trim() })) discard(playlist.id);
  };

  const create = async () => {
    const created = await api<Playlist>('POST', '/api/playlists', { name: `Playlist ${show.playlists.length + 1}` });
    if (created) setSelectedId(created.id);
  };

  return (
    <div className="split">
      <aside>
        {show.playlists.map((playlist) => (
          <button key={playlist.id} className={playlist.id === selected?.id ? 'row active' : 'row'} onClick={() => setSelectedId(playlist.id)}>
            <span className="grow">
              {playlist.name}
              {isDirty(playlist) && (
                <span className="unsaved-dot" title="Unsaved changes">
                  ●
                </span>
              )}
            </span>
            <span className="muted">
              {playlist.cues.length}
              {playlist.screens.length > 1 && ` × ${playlist.screens.length}`}
            </span>
          </button>
        ))}
        <button className="primary" onClick={create}>
          New playlist
        </button>
      </aside>
      {selected ? (
        <Editor
          key={selected.id}
          playlist={draftOf(selected) ?? selected}
          saved={selected}
          dirty={isDirty(selected)}
          show={show}
          onEdit={(patch) => setDrafts((d) => ({ ...d, [selected.id]: { ...(d[selected.id] ?? selected), ...patch } }))}
          onSave={() => save(draftOf(selected) ?? selected)}
          onDiscard={() => discard(selected.id)}
        />
      ) : (
        <p className="muted">Create a playlist to get started.</p>
      )}
    </div>
  );
}
