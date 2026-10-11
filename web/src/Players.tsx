import { useEffect, useState } from 'react';
import { api, send } from './api';
import { useUnsavedWarning } from './common';
import type { Group, Player, Snapshot } from './types';

function PlayerSetup() {
  const [addresses, setAddresses] = useState<string[]>([]);
  const [server, setServer] = useState('');

  useEffect(() => {
    api<{ addresses: string[] }>('GET', '/api/info').then((info) => info && setAddresses(info.addresses));
  }, []);

  return (
    <section className="card setup">
      <h3>Set up a BrightSign</h3>
      <ol>
        <li>
          <a className="button primary" href={`/api/player-package${server ? `?server=${encodeURIComponent(server)}` : ''}`}>
            Download SD card files
          </a>
        </li>
        <li>Unzip onto a blank SD card. The files are the same for every player.</li>
        <li>
          Insert the card and power the player on. It shows "Waiting to be paired" and appears at the top of this page;
          choose Pair.
        </li>
      </ol>
      <details>
        <summary>Player not showing up?</summary>
        <p className="muted">
          Pairing uses UDP broadcasts on port 48550, which only reach players on the same network segment as this
          server and can be blocked by a firewall. To skip pairing, enter this server's address and download again: the
          card will then connect straight to it.
        </p>
        <label>
          Fixed server address (optional)
          <input list="addresses" placeholder={addresses[0] ?? 'http://192.168.1.10:8080'} value={server} onChange={(e) => setServer(e.target.value.trim())} />
          <datalist id="addresses">
            {addresses.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>
      </details>
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

interface PlayerDraft {
  name: string;
}

interface GroupDraft {
  name: string;
  playerIds: string[];
}

// Order matters: a group's first player is screen 1 of a multi-screen playlist, and so on.
const sameMembers = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => b[i] === id);

export function Players({ show, onUnsaved }: { show: Snapshot; onUnsaved: (dirty: boolean) => void }) {
  // Edits are held here and only sent when Save is pressed.
  const [playerDrafts, setPlayerDrafts] = useState<Record<string, PlayerDraft>>({});
  const [groupDrafts, setGroupDrafts] = useState<Record<string, GroupDraft>>({});

  const playerValue = (player: Player): PlayerDraft => playerDrafts[player.id] ?? { name: player.name };
  const groupValue = (group: Group): GroupDraft => {
    const draft = groupDrafts[group.id] ?? group;
    // Players that have been unpaired since the edit began drop out of the draft.
    return { name: draft.name, playerIds: draft.playerIds.filter((id) => show.players.some((p) => p.id === id)) };
  };
  const playerEdited = (player: Player) => {
    return playerValue(player).name !== player.name;
  };
  const groupEdited = (group: Group) => {
    const value = groupValue(group);
    return value.name !== group.name || !sameMembers(value.playerIds, group.playerIds);
  };

  const editedPlayers = show.players.filter(playerEdited);
  const editedGroups = show.groups.filter(groupEdited);
  const dirty = editedPlayers.length + editedGroups.length > 0;
  const valid = editedPlayers.every((p) => playerValue(p).name.trim()) && editedGroups.every((g) => groupValue(g).name.trim());

  useEffect(() => onUnsaved(dirty), [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useUnsavedWarning(dirty);

  const editPlayer = (player: Player, patch: Partial<PlayerDraft>) =>
    setPlayerDrafts((d) => ({ ...d, [player.id]: { ...playerValue(player), ...patch } }));
  const editGroup = (group: Group, patch: Partial<GroupDraft>) =>
    setGroupDrafts((d) => ({ ...d, [group.id]: { ...groupValue(group), ...patch } }));

  const discard = () => {
    setPlayerDrafts({});
    setGroupDrafts({});
  };

  const save = async () => {
    // Each draft is dropped only once the server has accepted it, so a failure keeps the edit on screen.
    for (const player of editedPlayers) {
      const value = playerValue(player);
      if (await send('PUT', `/api/players/${encodeURIComponent(player.id)}`, { ...value, name: value.name.trim() }))
        setPlayerDrafts(({ [player.id]: _saved, ...rest }) => rest);
    }
    for (const group of editedGroups) {
      const value = groupValue(group);
      if (await send('PUT', `/api/groups/${group.id}`, { ...value, name: value.name.trim() }))
        setGroupDrafts(({ [group.id]: _saved, ...rest }) => rest);
    }
  };

  const unpair = (player: Player) => {
    // Only a paired BrightSign can be sent back to waiting; other kinds simply reconnect.
    const consequence =
      player.status?.link === 'paired' && player.online
        ? 'It will stop showing content and wait to be paired again.'
        : player.online
          ? 'It connects by a fixed address, so it will reappear, unassigned, when it reconnects.'
          : 'It is offline, so it cannot be told. It will reappear, unassigned, if it connects again.';
    if (confirm(`Unpair "${player.name}"? ${consequence}`)) api('DELETE', `/api/players/${encodeURIComponent(player.id)}`);
  };

  return (
    <>
      {dirty && (
        <div className="savebar">
          <span>
            Unsaved changes to {[editedPlayers.length && `${editedPlayers.length} player(s)`, editedGroups.length && `${editedGroups.length} group(s)`].filter(Boolean).join(' and ')}.
          </span>
          <button onClick={discard}>Discard</button>
          <button className="primary" disabled={!valid} onClick={save}>
            Save
          </button>
        </div>
      )}

      {show.discovered.length > 0 && (
        <>
          <h2>Waiting to be paired</h2>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Device</th>
                <th>Address</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {show.discovered.map((found) => (
                <tr key={found.id}>
                  <td>{found.id}</td>
                  <td className="muted">{[found.model, found.os].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="muted">{found.address}</td>
                  <td className="actions">
                    <button className="primary" onClick={() => api('POST', `/api/discovered/${encodeURIComponent(found.id)}/pair`)}>
                      Pair
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Players</h2>
      {show.players.length === 0 ? (
        <p className="muted">No players are paired yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>ID</th>
              <th>Device</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {show.players.map((player) => {
              const value = playerValue(player);
              return (
                <tr key={player.id} className={playerEdited(player) ? 'edited' : ''}>
                  <td>
                    <span className={player.online ? 'dot ok' : 'dot'} title={player.online ? 'Online' : 'Offline'} />
                  </td>
                  <td>
                    <input aria-label="Player name" value={value.name} onChange={(e) => editPlayer(player, { name: e.target.value })} />
                  </td>
                  <td className="muted">{player.id}</td>
                  <td className="muted">
                    {[player.status?.model, player.status?.os, player.status?.version && `player ${player.status.version}`]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                  <td>
                    <button className="quiet" onClick={() => unpair(player)}>
                      Unpair
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Groups</h2>
      <p className="muted">
        A group gets its own transport on the Live tab that cues all of its players at once. Order matters for a
        multi-screen playlist: the group's first player shows the playlist's first screen, the second its second, and
        so on. With more players than screens, the extra players start again from the first screen.
      </p>
      <div className="grid">
        {show.groups.map((group) => {
          const value = groupValue(group);
          return (
            <section className={groupEdited(group) ? 'card edited' : 'card'} key={group.id}>
              <div className="card-head">
                <input className="grow" aria-label="Group name" value={value.name} onChange={(e) => editGroup(group, { name: e.target.value })} />
                <button
                  className="quiet"
                  onClick={() => confirm(`Delete group "${group.name}"?`) && api('DELETE', `/api/groups/${group.id}`)}
                >
                  Delete
                </button>
              </div>
              {value.playerIds.length === 0 && <p className="muted">No players in this group yet.</p>}
              <ol className="members-list">
                {value.playerIds.map((id, index) => {
                  const reorder = (to: number) => {
                    const ids = [...value.playerIds];
                    ids.splice(to, 0, ...ids.splice(index, 1));
                    editGroup(group, { playerIds: ids });
                  };
                  return (
                    <li key={id}>
                      <span className="muted">Screen {index + 1}</span>
                      <span className="grow">{show.players.find((p) => p.id === id)?.name}</span>
                      <button className="quiet" disabled={index === 0} title="Move up" onClick={() => reorder(index - 1)}>
                        ↑
                      </button>
                      <button className="quiet" disabled={index === value.playerIds.length - 1} title="Move down" onClick={() => reorder(index + 1)}>
                        ↓
                      </button>
                      <button
                        className="quiet"
                        title="Remove from group"
                        onClick={() => editGroup(group, { playerIds: value.playerIds.filter((other) => other !== id) })}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ol>
              {show.players.some((p) => !value.playerIds.includes(p.id)) && (
                <select aria-label="Add a player to this group" value="" onChange={(e) => editGroup(group, { playerIds: [...value.playerIds, e.target.value] })}>
                  <option value="" disabled>
                    Add a player…
                  </option>
                  {show.players
                    .filter((p) => !value.playerIds.includes(p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              )}
            </section>
          );
        })}
      </div>
      <button className="primary" onClick={() => api('POST', '/api/groups', { name: `Group ${show.groups.length + 1}` })}>
        New group
      </button>

      <h2>Add a player</h2>
      <PlayerSetup />
    </>
  );
}
