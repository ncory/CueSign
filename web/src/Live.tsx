import { useState } from 'react';
import { cue, load } from './api';
import { formatCountdown, mediaIdAt, screenOf, Thumb, useNow } from './common';
import type { CueAction, Player, Playlist, Snapshot } from './types';

function Transport(props: { auto: boolean; blackout: boolean; onCue: (action: CueAction) => void }) {
  return (
    <div className="transport">
      <button onClick={() => props.onCue('prev')}>Prev</button>
      <button className="primary" onClick={() => props.onCue('next')}>
        Next
      </button>
      <button className={props.auto ? 'on' : ''} onClick={() => props.onCue(props.auto ? 'pause' : 'play')}>
        {props.auto ? 'Stop timer' : 'Start timer'}
      </button>
      <button className={props.blackout ? 'on danger' : ''} onClick={() => props.onCue('blackout')}>
        Blackout
      </button>
    </div>
  );
}

/**
 * Playlist picker with a Load button. Loading always starts the playlist from its first cue.
 * A single player also chooses which screen of a multi-screen playlist to show.
 */
function LoadPlaylist(props: {
  show: Snapshot;
  current: string | null;
  currentScreen?: number;
  onLoad: (playlistId: string | null, screen: number) => void;
}) {
  // Undefined until the operator picks something, so the pickers follow whatever is loaded.
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [screenChoice, setScreenChoice] = useState<number | undefined>(undefined);
  const value = choice ?? props.current ?? '';
  const playlist = props.show.playlists.find((p) => p.id === value);
  const pickScreen = props.currentScreen !== undefined && !!playlist && playlist.screens.length > 1;
  const loadedScreen = (props.currentScreen ?? 0) % (playlist?.screens.length || 1);
  const screen = Math.min(screenChoice ?? loadedScreen, (playlist?.screens.length || 1) - 1);
  const changed = value !== (props.current ?? '') || (pickScreen && screen !== loadedScreen);

  return (
    <div className="load">
      <select
        aria-label="Playlist"
        value={value}
        onChange={(e) => {
          setChoice(e.target.value);
          setScreenChoice(undefined);
        }}
      >
        <option value="">No playlist</option>
        {props.show.playlists.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.screens.length > 1 ? ` (${p.screens.length} screens)` : ''}
          </option>
        ))}
      </select>
      {pickScreen && (
        <select aria-label="Screen" value={screen} onChange={(e) => setScreenChoice(Number(e.target.value))}>
          {playlist.screens.map((s, i) => (
            <option key={s.id} value={i}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <button
        className={changed ? 'primary' : ''}
        title={changed ? 'Load this playlist from its first cue' : 'Reload this playlist from its first cue'}
        onClick={() => {
          props.onLoad(value || null, screen);
          setChoice(undefined);
          setScreenChoice(undefined);
        }}
      >
        {changed ? 'Load' : 'Reload'}
      </button>
    </div>
  );
}

function playerNote(player: Player) {
  const status = player.status;
  if (!player.online) return { text: 'Offline', bad: true };
  if (!status) return { text: 'Online', bad: false };
  if (status.updating) return { text: 'Updating player software…', bad: false };
  if (status.error) return { text: status.error, bad: true };
  if (status.downloading) {
    const percent = Math.floor((100 * status.downloading.received) / Math.max(1, status.downloading.size));
    return { text: `Downloading ${percent}% · ${status.cached}/${status.total} cached`, bad: false };
  }
  if (!player.blackout && player.mediaId && status.showing !== player.mediaId) return { text: 'Loading cue…', bad: false };
  return { text: status.total ? `${status.cached}/${status.total} cached` : 'Online', bad: false };
}

/** The list of cues to jump to. Each row names what the given screens show at that cue. */
function CueList(props: { show: Snapshot; playlist: Playlist; screenIds: string[]; current: number | null; onGoto: (index: number) => void }) {
  const { playlist } = props;
  const label = (index: number, screenId: string) => {
    if (playlist.cues[index].cells[screenId]) return props.show.media.find((m) => m.id === playlist.cues[index].cells[screenId])?.name ?? '?';
    return playlist.emptyCells === 'hold' && mediaIdAt(playlist, screenId, index) ? '↑ hold' : '— black';
  };

  return (
    <ol className="cue-list">
      {playlist.cues.map((row, index) => (
        <li key={row.id}>
          <button className={index === props.current ? 'current' : ''} onClick={() => props.onGoto(index)}>
            <span className="num">{index + 1}</span>
            <span className="grow">{props.screenIds.map((id) => label(index, id)).join('  |  ')}</span>
            {row.duration !== null && <span className="muted">{row.duration}s</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

function PlayerCard({ player, show, now }: { player: Player; show: Snapshot; now: number }) {
  const playlist = show.playlists.find((p) => p.id === player.playlistId);
  const cues = playlist?.cues ?? [];
  const screen = playlist && screenOf(playlist, player.screen);
  const current = show.media.find((m) => m.id === player.mediaId);
  const note = playerNote(player);

  return (
    <section className="card player">
      <div className="card-head">
        <span className={player.online ? 'dot ok' : 'dot'} title={player.online ? 'Online' : 'Offline'} />
        <h3>{player.name}</h3>
        {playlist && playlist.screens.length > 1 && <span className="muted">{screen?.name}</span>}
      </div>
      <LoadPlaylist
        show={show}
        current={player.playlistId}
        currentScreen={player.screen}
        onLoad={(id, screenIndex) => load('players', player.id, id, screenIndex)}
      />

      <div className="preview">
        <Thumb media={player.blackout ? undefined : current} />
        {player.blackout && <div className="preview-label">BLACKOUT</div>}
        {player.deadline !== null && <div className="countdown">{formatCountdown(player.deadline - now)}</div>}
      </div>

      <div className="now">
        {cues.length > 0 ? (
          <>
            <b>
              {player.index + 1} / {cues.length}
            </b>{' '}
            {current?.name ?? <span className="muted">black</span>}
          </>
        ) : (
          <span className="muted">Nothing to show</span>
        )}
      </div>
      <div className={note.bad ? 'note bad' : 'note'}>{note.text}</div>

      <Transport auto={player.auto} blackout={player.blackout} onCue={(action) => cue('players', player.id, action)} />

      {playlist && screen && cues.length > 0 && (
        <CueList
          show={show}
          playlist={playlist}
          screenIds={[screen.id]}
          current={player.index}
          onGoto={(index) => cue('players', player.id, 'goto', { index })}
        />
      )}
    </section>
  );
}

export function Live({ show, clockOffset }: { show: Snapshot; clockOffset: number }) {
  const now = useNow(show.players.some((p) => p.deadline !== null)) + clockOffset;
  const groups = show.groups.filter((g) => g.playerIds.length > 0);

  if (show.players.length === 0) {
    return (
      <p className="muted">
        {show.discovered.length > 0
          ? `${show.discovered.length} player(s) on the network are waiting to be paired. Pair them on the Players tab.`
          : 'No players yet. Power on a player with the CueSign SD card and pair it on the Players tab, or open a browser preview from there.'}
      </p>
    );
  }

  return (
    <>
      {groups.length > 0 && (
        <>
          <h2>Groups</h2>
          <div className="grid">
            {groups.map((group) => {
              // In group order, which is also screen order.
              const members = group.playerIds.map((id) => show.players.find((p) => p.id === id)).filter((p): p is Player => !!p);
              // The group acts as one show only while every member is on the same playlist.
              const sharedId = members.every((p) => p.playlistId === members[0]?.playlistId) ? (members[0]?.playlistId ?? null) : null;
              const playlist = show.playlists.find((p) => p.id === sharedId);
              const together = !!playlist && members.every((p) => p.index === members[0].index);
              const deadline = members.find((p) => p.deadline !== null)?.deadline ?? null;

              return (
                <section className="card" key={group.id}>
                  <div className="card-head">
                    <h3>{group.name}</h3>
                    <span className="muted">
                      {members.filter((p) => p.online).length}/{members.length} online
                    </span>
                  </div>
                  <div className="muted members">
                    {members
                      .map((p) => (playlist && playlist.screens.length > 1 ? `${p.name} → ${screenOf(playlist, p.screen).name}` : p.name))
                      .join(' · ')}
                  </div>
                  <LoadPlaylist show={show} current={sharedId} onLoad={(id) => load('groups', group.id, id)} />
                  {playlist && playlist.cues.length > 0 && (
                    <div className="now">
                      {together ? (
                        <b>
                          Cue {members[0].index + 1} / {playlist.cues.length}
                        </b>
                      ) : (
                        <span className="note bad">Players are on different cues</span>
                      )}
                      {deadline !== null && <span className="muted"> · next in {formatCountdown(deadline - now)}</span>}
                    </div>
                  )}
                  <Transport
                    auto={members.every((p) => p.auto)}
                    blackout={members.every((p) => p.blackout)}
                    onCue={(action) => cue('groups', group.id, action)}
                  />
                  {playlist && playlist.cues.length > 0 ? (
                    <CueList
                      show={show}
                      playlist={playlist}
                      screenIds={[...new Set(members.map((p) => screenOf(playlist, p.screen).id))]}
                      current={together ? members[0].index : null}
                      onGoto={(index) => cue('groups', group.id, 'goto', { index })}
                    />
                  ) : (
                    <button className="quiet" onClick={() => cue('groups', group.id, 'first')}>
                      Back to first cue
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      <h2>Players</h2>
      <div className="grid">
        {show.players.map((player) => (
          <PlayerCard key={player.id} player={player} show={show} now={now} />
        ))}
      </div>
    </>
  );
}
