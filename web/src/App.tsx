import { useEffect, useState } from 'react';
import { ERROR_EVENT, useShow } from './api';
import { Live } from './Live';
import { MediaLibrary } from './Media';
import { Players } from './Players';
import { Playlists } from './Playlists';

const TABS = ['Live', 'Playlists', 'Media', 'Players'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { snapshot, connected, clockOffset } = useShow();
  const [tab, setTab] = useState<Tab>('Live');
  const [error, setError] = useState<string | null>(null);
  // Which tabs hold edits that have not been saved yet.
  const [unsaved, setUnsaved] = useState<Partial<Record<Tab, boolean>>>({});
  const markUnsaved = (t: Tab) => (dirty: boolean) => setUnsaved((u) => (!!u[t] === dirty ? u : { ...u, [t]: dirty }));

  useEffect(() => {
    const onError = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener(ERROR_EVENT, onError);
    return () => window.removeEventListener(ERROR_EVENT, onError);
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="brand">CueSign</div>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t}
              {unsaved[t] && (
                <span className="unsaved-dot" title="Unsaved changes">
                  ●
                </span>
              )}
              {t === 'Players' && !!snapshot?.discovered.length && (
                <span className="badge" title="Players waiting to be paired">
                  {snapshot.discovered.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className={connected ? 'link ok' : 'link bad'}>{connected ? 'Connected' : 'Server unreachable'}</div>
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <main>
        {!snapshot ? (
          <p className="muted">Connecting to the server…</p>
        ) : (
          // Every tab stays mounted so unsaved edits and running uploads survive switching tabs.
          <>
            <div hidden={tab !== 'Live'}>
              <Live show={snapshot} clockOffset={clockOffset} />
            </div>
            <div hidden={tab !== 'Playlists'}>
              <Playlists show={snapshot} onUnsaved={markUnsaved('Playlists')} />
            </div>
            <div hidden={tab !== 'Media'}>
              <MediaLibrary show={snapshot} />
            </div>
            <div hidden={tab !== 'Players'}>
              <Players show={snapshot} onUnsaved={markUnsaved('Players')} />
            </div>
          </>
        )}
      </main>
    </>
  );
}
