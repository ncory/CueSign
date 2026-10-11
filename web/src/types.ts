export interface Media {
  id: string;
  name: string;
  kind: 'image' | 'video';
  /** Library folder path such as "Act 1/Walk-in"; empty for the top level. */
  folder: string;
  size: number;
  added: string;
  url: string;
}

/** A column of a playlist: one display's worth of content. */
export interface PlaylistScreen {
  id: string;
  name: string;
}

/** A row of a playlist: what every screen shows at one moment. */
export interface PlaylistCue {
  id: string;
  /** Seconds on screen while the timer runs. Null: wait for a video to end or a manual cue. */
  duration: number | null;
  /** Screen id → media id. A screen with no entry is an empty cell. */
  cells: Record<string, string>;
}

export interface Playlist {
  id: string;
  name: string;
  loop: boolean;
  fadeMs: number;
  /** What an empty cell means: keep that screen's previous item up, or clear it. */
  emptyCells: 'hold' | 'black';
  screens: PlaylistScreen[];
  cues: PlaylistCue[];
}

/** What a player last reported about itself. */
export interface PlayerStatus {
  version?: string;
  model?: string | null;
  os?: string | null;
  storage?: 'sd' | 'none';
  /** How the player found the server: paired by discovery, a fixed address in config.json, or a browser tab. */
  link?: 'paired' | 'fixed' | 'preview';
  showing: string | null;
  cue: number | null;
  cached: number;
  total: number;
  downloading: { id: string; received: number; size: number } | null;
  /** True while the player is downloading newer player code from the server. */
  updating?: boolean;
  error: string | null;
}

export interface Player {
  id: string;
  name: string;
  playlistId: string | null;
  /** Which column of the playlist this player shows (wraps if the playlist has fewer). */
  screen: number;
  /** The group this player was loaded with, if any. */
  linkId: string | null;
  /** What should be on screen now, after empty cells are resolved. */
  mediaId: string | null;
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

/** A player on the network that is waiting to be paired. */
export interface DiscoveredPlayer {
  id: string;
  model: string | null;
  os: string | null;
  address: string;
}

export interface Snapshot {
  serverTime: number;
  media: Media[];
  /** Every library folder path, including empty ones. */
  folders: string[];
  playlists: Playlist[];
  players: Player[];
  groups: Group[];
  discovered: DiscoveredPlayer[];
}

export type CueAction = 'next' | 'prev' | 'first' | 'goto' | 'play' | 'pause' | 'blackout';
