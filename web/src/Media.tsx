import { useRef, useState } from 'react';
import { api, upload } from './api';
import { formatSize, TextField, Thumb } from './common';
import type { Media, Snapshot } from './types';

export function MediaLibrary({ show }: { show: Snapshot }) {
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    // One at a time: these are large files going to one disk.
    for (const file of Array.from(files ?? [])) {
      setUploads((u) => ({ ...u, [file.name]: 0 }));
      await upload(file, (fraction) => setUploads((u) => ({ ...u, [file.name]: fraction })));
      setUploads(({ [file.name]: _done, ...rest }) => rest);
    }
  };

  const remove = (media: Media) => {
    const used = show.playlists.filter((p) => p.items.some((i) => i.mediaId === media.id)).map((p) => p.name);
    const warning = used.length ? ` It will also be removed from: ${used.join(', ')}.` : '';
    if (confirm(`Delete "${media.name}" from the library and from every player's cache?${warning}`))
      api('DELETE', `/api/media/${media.id}`);
  };

  return (
    <>
      <div
        className={over ? 'dropzone over' : 'dropzone'}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <p>Drop images and videos here</p>
        <button className="primary" onClick={() => picker.current?.click()}>
          Choose files
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept="image/*,video/*,.mkv,.ts"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {Object.entries(uploads).map(([name, fraction]) => (
        <div className="upload" key={name}>
          <span className="grow">{name}</span>
          <progress value={fraction} max={1} />
          <span className="muted">{Math.round(fraction * 100)}%</span>
        </div>
      ))}

      {show.media.length === 0 && <p className="muted">The library is empty.</p>}
      <div className="media-grid">
        {show.media.map((media) => (
          <div className="card media" key={media.id}>
            <Thumb media={media} />
            <TextField label="Media name" value={media.name} onCommit={(name) => api('PUT', `/api/media/${media.id}`, { name })} />
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
