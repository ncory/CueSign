export interface Media {
  id: string;
  name: string;
  kind: 'image' | 'video';
  size: number;
  added: string;
  url: string;
}

export interface PlaylistItem {
  id: string;
  mediaId: string;
  /** Seconds on screen while the timer runs. Null: videos play once, images hold. */
  duration: number | null;
}

export interface Playlist {
  id: string;
  name: string;
  loop: boolean;
  fadeMs: number;
  items: PlaylistItem[];
}

/** What a player last reported about itself. */
export interface PlayerStatus {
  version?: string;
  model?: string | null;
  os?: string | null;
  storage?: 'sd' | 'none';
  showing: string | null;
  cue: number | null;
  cached: number;
  total: number;
  downloading: { id: string; received: number; size: number } | null;
  error: string | null;
}

export interface Player {
  id: string;
  name: string;
  playlistId: string | null;
  index: number;
  cue: number;
  auto: boolean;
  blackout: boolean;
  online: boolean;
  /** Server time (ms) at which the timer advances this player, if it is counting down. */
  deadline: number | null;
  status: PlayerStatus | null;
}

export interface Group {
  id: string;
  name: string;
  playerIds: string[];
}

export interface Snapshot {
  serverTime: number;
  media: Media[];
  playlists: Playlist[];
  players: Player[];
  groups: Group[];
}

export type CueAction = 'next' | 'prev' | 'first' | 'goto' | 'play' | 'pause' | 'blackout';
