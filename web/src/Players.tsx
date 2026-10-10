import { useEffect, useState } from 'react';
import { api } from './api';
import { TextField } from './common';
import type { Group, Player, Snapshot } from './types';

function PlayerSetup() {
  const [addresses, setAddresses] = useState<string[]>([]);
  const [server, setServer] = useState(location.origin);

  useEffect(() => {
    api<{ addresses: string[] }>('GET', '/api/info').then((info) => {
      if (!info) return;
      setAddresses(info.addresses);
      // A player cannot reach "localhost", so default to this machine's network address.
      if (/localhost|127\.0\.0\.1/.test(location.hostname) && info.addresses[0]) setServer(info.addresses[0]);
    });
  }, []);

  return (
    <section className="card setup">
      <h3>Set up a BrightSign</h3>
      <ol>
        <li>
          <label>
            Server address the player should use
            <input list="addresses" value={server} onChange={(e) => setServer(e.target.value)} />
            <datalist id="addresses">
              {addresses.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
        </li>
        <li>
          <a className="button primary" href={`/api/player-package?server=${encodeURIComponent(server)}`}>
            Download SD card files
          </a>
        </li>
        <li>Unzip onto a blank SD card, insert it and power the player on. It appears here by serial number.</li>
      </ol>
      <p className="muted">
        No hardware handy?{' '}
        <a href="/player/" target="_blank" rel="noreferrer">
          Open a preview player
        </a>{' '}
        in a browser tab.
      </p>
    </section>
  );
}

export function Players({ show }: { show: Snapshot }) {
  const update = (player: Player, patch: Partial<Pick<Player, 'name' | 'playlistId'>>) =>
    api('PUT', `/api/players/${encodeURIComponent(player.id)}`, { name: player.name, playlistId: player.playlistId, ...patch });
  const updateGroup = (group: Group, patch: Partial<Group>) => api('PUT', `/api/groups/${group.id}`, { ...group, ...patch });

  return (
    <>
      <h2>Players</h2>
      {show.players.length === 0 ? (
        <p className="muted">No players have connected yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>ID</th>
              <th>Device</th>
              <th>Playlist</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {show.players.map((player) => (
              <tr key={player.id}>
                <td>
                  <span className={player.online ? 'dot ok' : 'dot'} title={player.online ? 'Online' : 'Offline'} />
                </td>
                <td>
                  <TextField label="Player name" value={player.name} onCommit={(name) => update(player, { name })} />
                </td>
                <td className="muted">{player.id}</td>
                <td className="muted">{[player.status?.model, player.status?.os].filter(Boolean).join(' · ') || '—'}</td>
                <td>
                  <select
                    aria-label="Playlist"
                    value={player.playlistId ?? ''}
                    onChange={(e) => update(player, { playlistId: e.target.value || null })}
                  >
                    <option value="">None</option>
                    {show.playlists.map((playlist) => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    className="quiet"
                    onClick={() => {
                      if (confirm(`Forget player "${player.name}"? It will reappear, unassigned, if it connects again.`))
                        api('DELETE', `/api/players/${encodeURIComponent(player.id)}`);
                    }}
                  >
                    Forget
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Groups</h2>
      <p className="muted">A group gets its own transport on the Live tab that cues all of its players at once.</p>
      <div className="grid">
        {show.groups.map((group) => (
          <section className="card" key={group.id}>
            <div className="card-head">
              <TextField className="grow" label="Group name" value={group.name} onCommit={(name) => updateGroup(group, { name })} />
              <button
                className="quiet"
                onClick={() => confirm(`Delete group "${group.name}"?`) && api('DELETE', `/api/groups/${group.id}`)}
              >
                Delete
              </button>
            </div>
            {show.players.length === 0 && <p className="muted">No players to add yet.</p>}
            {show.players.map((player) => (
              <label className="check" key={player.id}>
                <input
                  type="checkbox"
                  checked={group.playerIds.includes(player.id)}
                  onChange={(e) =>
                    updateGroup(group, {
                      playerIds: e.target.checked
                        ? [...group.playerIds, player.id]
                        : group.playerIds.filter((id) => id !== player.id),
                    })
                  }
                />
                {player.name}
              </label>
            ))}
          </section>
        ))}
      </div>
      <button className="primary" onClick={() => api('POST', '/api/groups', { name: `Group ${show.groups.length + 1}` })}>
        New group
      </button>

      <h2>Add a player</h2>
      <PlayerSetup />
    </>
  );
}
