import { cue } from './api';
import { formatCountdown, Thumb, useNow } from './common';
import type { CueAction, Player, Snapshot } from './types';

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

function playerNote(player: Player, expectedMediaId: string | undefined) {
  const status = player.status;
  if (!player.online) return { text: 'Offline', bad: true };
  if (!status) return { text: 'Online', bad: false };
  if (status.error) return { text: status.error, bad: true };
  if (status.downloading) {
    const percent = Math.floor((100 * status.downloading.received) / Math.max(1, status.downloading.size));
    return { text: `Downloading ${percent}% · ${status.cached}/${status.total} cached`, bad: false };
  }
  if (!player.blackout && expectedMediaId && status.showing !== expectedMediaId) return { text: 'Loading cue…', bad: false };
  return { text: status.total ? `${status.cached}/${status.total} cached` : 'Online', bad: false };
}

function PlayerCard({ player, show, now }: { player: Player; show: Snapshot; now: number }) {
  const playlist = show.playlists.find((p) => p.id === player.playlistId);
  const items = playlist?.items ?? [];
  const mediaOf = (mediaId: string | undefined) => show.media.find((m) => m.id === mediaId);
  const current = mediaOf(items[player.index]?.mediaId);
  const note = playerNote(player, current?.id);

  return (
    <section className="card player">
      <div className="card-head">
        <span className={player.online ? 'dot ok' : 'dot'} title={player.online ? 'Online' : 'Offline'} />
        <h3>{player.name}</h3>
        <span className="muted">{playlist?.name ?? 'No playlist'}</span>
      </div>

      <div className="preview">
        <Thumb media={player.blackout ? undefined : current} />
        {player.blackout && <div className="preview-label">BLACKOUT</div>}
        {player.deadline !== null && <div className="countdown">{formatCountdown(player.deadline - now)}</div>}
      </div>

      <div className="now">
        {items.length > 0 ? (
          <>
            <b>
              {player.index + 1} / {items.length}
            </b>{' '}
            {current?.name}
          </>
        ) : (
          <span className="muted">Nothing to show</span>
        )}
      </div>
      <div className={note.bad ? 'note bad' : 'note'}>{note.text}</div>

      <Transport auto={player.auto} blackout={player.blackout} onCue={(action) => cue('players', player.id, action)} />

      {items.length > 0 && (
        <ol className="cue-list">
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                className={index === player.index ? 'current' : ''}
                onClick={() => cue('players', player.id, 'goto', { index })}
              >
                <span className="num">{index + 1}</span>
                <span className="grow">{mediaOf(item.mediaId)?.name}</span>
                {item.duration !== null && <span className="muted">{item.duration}s</span>}
              </button>
            </li>
          ))}
        </ol>
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
        No players yet. A player appears here the first time it connects — see the Players tab to set one up or open a
        browser preview.
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
              const members = show.players.filter((p) => group.playerIds.includes(p.id));
              return (
                <section className="card" key={group.id}>
                  <div className="card-head">
                    <h3>{group.name}</h3>
                    <span className="muted">
                      {members.filter((p) => p.online).length}/{members.length} online
                    </span>
                  </div>
                  <div className="muted members">{members.map((p) => p.name).join(' · ')}</div>
                  <Transport
                    auto={members.every((p) => p.auto)}
                    blackout={members.every((p) => p.blackout)}
                    onCue={(action) => cue('groups', group.id, action)}
                  />
                  <button className="quiet" onClick={() => cue('groups', group.id, 'first')}>
                    Back to first cue
                  </button>
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
