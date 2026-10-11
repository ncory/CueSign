import { useRef, useState } from 'react';
import { api, upload } from './api';
import { folderName, formatSize, parentFolder, TextField, Thumb } from './common';
import type { Media, Snapshot } from './types';

const SUPPORTED = /\.(jpe?g|png|gif|webp|bmp|mp4|m4v|mov|webm|mkv|ts|mpe?g)$/i;
const MEDIA_DRAG = 'application/x-cuesign-media';

/** A file to upload and the folder path it sits in, relative to wherever it was dropped. */
interface Pending {
  file: File;
  dir: string;
}

function readEntries(reader: FileSystemDirectoryReader) {
  return new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
}

/** Walks a dropped file or folder, collecting every file beneath it. */
async function collect(entry: FileSystemEntry, dir: string, out: Pending[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, dir });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const inside = dir ? `${dir}/${entry.name}` : entry.name;
    // readEntries hands back the listing in batches and signals the end with an empty one.
    for (let batch = await readEntries(reader); batch.length > 0; batch = await readEntries(reader))
      for (const child of batch) await collect(child, inside, out);
  }
}

const join = (base: string, rest: string) => [base, rest].filter(Boolean).join('/');

export function MediaLibrary({ show }: { show: Snapshot }) {
  const [folder, setFolder] = useState('');
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [skipped, setSkipped] = useState(0);
  const [over, setOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);

  // The folder being viewed can be renamed or removed by someone else.
  const here = folder === '' || show.folders.includes(folder) ? folder : '';
  const subfolders = show.folders.filter((f) => parentFolder(f) === here && f !== '');
  const items = show.media.filter((m) => m.folder === here);
  const countIn = (path: string) => show.media.filter((m) => m.folder === path || m.folder.startsWith(`${path}/`)).length;

  const addFiles = async (pending: Pending[]) => {
    const wanted = pending.filter((p) => SUPPORTED.test(p.file.name));
    // Hidden files such as .DS_Store come along with every dropped folder; they are not worth mentioning.
    setSkipped(pending.filter((p) => !SUPPORTED.test(p.file.name) && !p.file.name.startsWith('.')).length);
    const target = here;
    // One at a time: these are large files going to one disk.
    for (const { file, dir } of wanted) {
      const key = join(dir, file.name);
      setUploads((u) => ({ ...u, [key]: 0 }));
      await upload(file, join(target, dir), (fraction) => setUploads((u) => ({ ...u, [key]: fraction })));
      setUploads(({ [key]: _done, ...rest }) => rest);
    }
  };

  const onDropFiles = async (e: React.DragEvent) => {
    // Entries must be taken from the event before the first await, or the browser discards them.
    const entries = Array.from(e.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => !!entry);
    const loose = Array.from(e.dataTransfer.files);
    const pending: Pending[] = [];
    if (entries.length > 0) for (const entry of entries) await collect(entry, '', pending);
    else pending.push(...loose.map((file) => ({ file, dir: '' })));
    addFiles(pending);
  };

  const moveMedia = (mediaId: string, to: string) => api('PUT', `/api/media/${mediaId}`, { folder: to });

  /** Props that let a folder tile or breadcrumb accept a dragged media card. */
  const acceptMedia = (path: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG)) return;
      e.preventDefault();
      setDropTarget(path);
    },
    onDragLeave: () => setDropTarget((t) => (t === path ? null : t)),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(MEDIA_DRAG);
      setDropTarget(null);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      moveMedia(id, path);
    },
  });

  const newFolder = () => {
    const name = prompt('Name for the new folder:')?.trim();
    if (name) api('POST', '/api/folders', { path: join(here, name.replace(/\//g, '-')) });
  };

  const renameFolder = (path: string) => {
    const name = prompt('Rename folder:', folderName(path))?.trim();
    if (name && name !== folderName(path))
      api('PUT', '/api/folders', { path, newPath: join(parentFolder(path), name.replace(/\//g, '-')) });
  };

  const deleteFolder = (path: string) => {
    const count = countIn(path);
    const where = parentFolder(path) || 'the top level';
    const detail = count ? ` Its ${count} item(s) will be moved up to ${where}; nothing is deleted.` : '';
    if (confirm(`Remove folder "${folderName(path)}"?${detail}`)) api('DELETE', `/api/folders?path=${encodeURIComponent(path)}`);
  };

  const remove = (media: Media) => {
    const used = show.playlists.filter((p) => p.cues.some((c) => Object.values(c.cells).includes(media.id))).map((p) => p.name);
    const warning = used.length ? ` Its cells will be emptied in: ${used.join(', ')}.` : '';
    if (confirm(`Delete "${media.name}" from the library and from every player's cache?${warning}`))
      api('DELETE', `/api/media/${media.id}`);
  };

  const crumbs = here === '' ? [] : here.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));

  return (
    <>
      <div className="crumbs">
        <button className={here === '' ? 'here' : dropTarget === '' ? 'drop-target' : ''} onClick={() => setFolder('')} {...acceptMedia('')}>
          Library
        </button>
        {crumbs.map((path) => (
          <span key={path}>
            <span className="sep">/</span>
            <button
              className={path === here ? 'here' : dropTarget === path ? 'drop-target' : ''}
              onClick={() => setFolder(path)}
              {...acceptMedia(path)}
            >
              {folderName(path)}
            </button>
          </span>
        ))}
        <span className="spacer" />
        <button onClick={newFolder}>New folder</button>
      </div>

      <div
        className={over ? 'dropzone over' : 'dropzone'}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setOver(false);
          onDropFiles(e);
        }}
      >
        <p>
          Drop images, videos or whole folders here to add them to <b>{here || 'the top level'}</b>
        </p>
        <button className="primary" onClick={() => filePicker.current?.click()}>
          Choose files
        </button>{' '}
        <button onClick={() => folderPicker.current?.click()}>Choose a folder</button>
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          accept="image/*,video/*,.mkv,.ts"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []).map((file) => ({ file, dir: '' })));
            e.target.value = '';
          }}
        />
        <input
          ref={folderPicker}
          type="file"
          hidden
          // Not in React's types: makes the picker choose a directory and return everything in it.
          {...{ webkitdirectory: '' }}
          onChange={(e) => {
            addFiles(
              Array.from(e.target.files ?? []).map((file) => ({ file, dir: parentFolder(file.webkitRelativePath) })),
            );
            e.target.value = '';
          }}
        />
      </div>

      {skipped > 0 && (
        <p className="note bad">
          {skipped} file(s) were skipped because they are not a supported image or video type.{' '}
          <button className="quiet" onClick={() => setSkipped(0)}>
            Dismiss
          </button>
        </p>
      )}

      {Object.entries(uploads).map(([name, fraction]) => (
        <div className="upload" key={name}>
          <span className="grow">{name}</span>
          <progress value={fraction} max={1} />
          <span className="muted">{Math.round(fraction * 100)}%</span>
        </div>
      ))}

      {subfolders.length === 0 && items.length === 0 && <p className="muted">{here ? 'This folder is empty.' : 'The library is empty.'}</p>}
      <div className="media-grid">
        {subfolders.map((path) => (
          <div
            className={dropTarget === path ? 'card folder drop-target' : 'card folder'}
            key={path}
            onClick={() => setFolder(path)}
            {...acceptMedia(path)}
          >
            <div className="folder-icon">📁</div>
            <h3>{folderName(path)}</h3>
            <div className="card-head">
              <span className="muted count">{countIn(path) === 1 ? '1 item' : `${countIn(path)} items`}</span>
              <button
                className="quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  renameFolder(path);
                }}
              >
                Rename
              </button>
              <button
                className="quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteFolder(path);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {items.map((media) => (
          <div
            className="card media"
            key={media.id}
            draggable
            title="Drag onto a folder to move"
            onDragStart={(e) => {
              e.dataTransfer.setData(MEDIA_DRAG, media.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
          >
            <Thumb media={media} />
            <TextField label="Media name" value={media.name} onCommit={(name) => api('PUT', `/api/media/${media.id}`, { name })} />
            {show.folders.length > 0 && (
              <select aria-label="Move to folder" value="" onChange={(e) => moveMedia(media.id, e.target.value === '//top' ? '' : e.target.value)}>
                <option value="" disabled>
                  Move to…
                </option>
                {here !== '' && <option value="//top">Top level</option>}
                {show.folders
                  .filter((f) => f !== here)
                  .map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
              </select>
            )}
            <div className="card-head">
              <span className="muted grow">
                {media.kind} · {formatSize(media.size)}
              </span>
              <button className="quiet" onClick={() => remove(media)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
