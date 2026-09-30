import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Fingerprint,
  Flag,
  History,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trophy,
  X,
  XCircle,
} from 'lucide-react';
import type { publicRound } from '../server/domain';

type Round = ReturnType<typeof publicRound>;
type View = 'arena' | 'history' | 'leaderboard' | 'settings';
interface Status {
  network: { connected: boolean; blockNumber?: string; timestamp?: number };
  configured: { groq: boolean; wallet: boolean; contract: boolean };
  authRequired: boolean;
  permissions?: { operator: boolean };
  publicRounds?: {
    enabled: boolean;
    mode: 'onchain';
    duration: number;
    dailyLimit: number;
    remaining: number;
    retryAt: number | null;
  };
  contract: string | null;
  serverTime: number;
  samples: { block: string; timestamp: number; transactions: number }[];
}
const phases = ['COMMIT', 'REVEAL', 'OBSERVING', 'SETTLED'];
const labels: Record<string, string> = {
  COMMIT: 'Sealing forecasts',
  REVEAL: 'Revealing forecasts',
  OBSERVING: 'Observation live',
  AWAITING_RESULT: 'Collecting result',
  SETTLED: 'Settled',
  CANCELLED: 'Cancelled',
};
const fmt = (n: number) => n.toLocaleString();
const short = (s: string) => `${s.slice(0, 8)}...${s.slice(-6)}`;
const time = (s: number) =>
  new Date(s * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const stamp = (s: number) =>
  new Date(s * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
function countdown(seconds: number) {
  const remaining = Math.max(0, seconds);
  return `${Math.floor(remaining / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(remaining % 60)
    .toString()
    .padStart(2, '0')}`;
}
function ChainLink({ hash, address = false }: { hash: string; address?: boolean }) {
  return (
    <a
      className="chain-link"
      href={`https://scan.bohr.life/${address ? 'address' : 'tx'}/${hash}`}
      target="_blank"
      rel="noreferrer"
      title={hash}
    >
      {short(hash)}
      <ExternalLink size={12} />
    </a>
  );
}
function LiveSignal({ samples }: { samples: Status['samples'] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(ratio, ratio);
      const w = rect.width,
        h = rect.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#e3e9e5';
      ctx.lineWidth = 1;
      for (let y = 15; y < h; y += 30) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      const max = Math.max(4, ...samples.map((s) => s.transactions));
      const x = (i: number) => 12 + (i * (w - 24)) / Math.max(1, samples.length - 1);
      const y = (v: number) => h - 18 - (v / max) * (h - 36);
      if (!samples.length) return;
      ctx.beginPath();
      ctx.moveTo(x(0), h - 10);
      samples.forEach((s, i) => ctx.lineTo(x(i), y(s.transactions)));
      ctx.lineTo(x(samples.length - 1), h - 10);
      ctx.closePath();
      ctx.fillStyle = '#dff4e9';
      ctx.fill();
      ctx.beginPath();
      samples.forEach((s, i) =>
        i ? ctx.lineTo(x(i), y(s.transactions)) : ctx.moveTo(x(i), y(s.transactions)),
      );
      ctx.strokeStyle = '#1b8059';
      ctx.lineWidth = 2;
      ctx.stroke();
      samples.forEach((s, i) => {
        ctx.beginPath();
        ctx.arc(x(i), y(s.transactions), 3, 0, Math.PI * 2);
        ctx.fillStyle = '#1b8059';
        ctx.fill();
      });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [samples]);
  return (
    <canvas
      ref={ref}
      className="signal-canvas"
      role="img"
      aria-label="Transactions per sampled BOT testnet block"
    />
  );
}

export default function App() {
  const [view, setView] = useState<View>('arena');
  const [rounds, setRounds] = useState<Round[]>([]);
  const [status, setStatus] = useState<Status>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(false);
  const [cancelId, setCancelId] = useState<string>();
  const [mode, setMode] = useState<'practice' | 'onchain'>('practice');
  const [duration, setDuration] = useState(60);
  const [clock, setClock] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const [token, setToken] = useState(() => sessionStorage.getItem('arena-token') || '');
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [boardMode, setBoardMode] = useState<'practice' | 'onchain'>('onchain');
  const [historyMode, setHistoryMode] = useState('all');
  const [detail, setDetail] = useState<'forecasts' | 'activity'>('forecasts');
  const refresh = async () => {
    try {
      const headers: HeadersInit = tokenRef.current
        ? { Authorization: `Bearer ${tokenRef.current}` }
        : {};
      const [s, r] = await Promise.all([fetch('/api/status', { headers }), fetch('/api/rounds')]);
      if (!s.ok || !r.ok) throw new Error('Arena backend is unavailable.');
      const next = (await s.json()) as Status;
      setStatus(next);
      setOffset(next.serverTime - Date.now());
      setRounds(await r.json());
      setConnectionError('');
      setLoading(false);
    } catch {
      setConnectionError('Cannot reach the arena backend. Retrying automatically.');
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, 4000);
    return () => clearInterval(poll);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!modal && !cancelId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        setModal(false);
        setCancelId(undefined);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modal, cancelId, busy]);
  useEffect(() => {
    if (!modal && !cancelId) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () => [
      ...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]',
      ) || []),
    ];
    focusable()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0],
        last = elements.at(-1);
      if (!first) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [modal, cancelId]);
  const request = async (url: string, body?: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  };
  const active = rounds.find((r) => !['SETTLED', 'CANCELLED'].includes(r.phase));
  const round =
    rounds.find((r) => r.id === selected) ||
    active ||
    rounds.find((r) => r.phase === 'SETTLED') ||
    rounds[0];
  const ready = status && Object.values(status.configured).every(Boolean);
  const operator = status?.permissions?.operator ?? !status?.authRequired;
  const reviewer = Boolean(status?.publicRounds) && !operator;
  const publicAccess = status?.publicRounds;
  const publicCooldown =
    reviewer && publicAccess?.retryAt
      ? Math.max(0, Math.ceil((publicAccess.retryAt - clock - offset) / 1000))
      : 0;
  const publicBlocked =
    reviewer && (!publicAccess?.enabled || !publicAccess.remaining || publicCooldown > 0);
  useEffect(() => {
    if (reviewer) {
      setMode('onchain');
      setDuration(60);
    }
  }, [reviewer]);
  const openRound = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await request(
        '/api/rounds',
        reviewer ? { mode: 'onchain', duration: 60 } : { mode, duration },
      );
      setSelected(r.id);
      setView('arena');
      setModal(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    setError('');
    try {
      await request(`/api/rounds/${cancelId}/cancel`);
      setCancelId(undefined);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    setError('');
    try {
      await request('/api/worker/retry');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const now = Math.floor((clock + offset) / 1000);
  const deadline = round
    ? round.phase === 'COMMIT'
      ? round.commitDeadline
      : round.phase === 'REVEAL'
        ? round.revealDeadline
        : round.observationEnd
    : 0;
  const nav = [
    { id: 'arena', label: 'Arena', icon: LayoutGrid },
    { id: 'history', label: 'Round history', icon: History },
    { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
    { id: 'settings', label: 'Settings', icon: Settings2 },
  ] as const;
  const settled = rounds.filter((r) => r.phase === 'SETTLED');
  const scored = settled.filter((r) => r.mode === boardMode);
  const leaders = new Map<
    string,
    { name: string; errors: number[]; misses: number; wins: number }
  >();
  for (const r of scored) {
    const best = Math.min(...r.forecasts.filter((f) => f.error !== undefined).map((f) => f.error!));
    for (const f of r.forecasts) {
      const key = f.kind === 'model' ? `${f.id}:${f.model}` : f.id;
      const entry = leaders.get(key) || { name: f.name, errors: [], misses: 0, wins: 0 };
      if (f.error === undefined) entry.misses++;
      else {
        entry.errors.push(f.error);
        if (f.error === best) entry.wins++;
      }
      leaders.set(key, entry);
    }
  }
  const leaderboard = [...leaders.values()]
    .map((l) => ({
      ...l,
      mean: l.errors.length ? l.errors.reduce((a, b) => a + b, 0) / l.errors.length : Infinity,
    }))
    .sort((a, b) => a.mean - b.mean);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView('arena');
          }}
        >
          <span className="brand-icon">
            <Fingerprint size={23} />
          </span>
          <span>
            FORECAST<span className="brand-sub">ARENA</span>
          </span>
        </a>
        <div className="workspace-label">
          WORKSPACE <span>01</span>
        </div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.id}
              aria-label={n.label}
              title={n.label}
              aria-current={view === n.id ? 'page' : undefined}
              className={view === n.id ? 'nav-item selected' : 'nav-item'}
              onClick={() => setView(n.id)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {view === n.id && <ChevronRight size={14} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="network-tag">
            <span className={`status-dot ${status?.network.connected ? 'online' : ''}`} />
            BOT TESTNET<span>968</span>
          </div>
          <a
            href="https://dev-docs.botchain.ai/docs/Developers/quick-guide/"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={16} /> Developer docs <ExternalLink size={13} />
          </a>
          <div className="version">
            Forecast Arena <span>v0.1</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <span>{nav.find((n) => n.id === view)?.label}</span>
          </div>
          <div className="top-actions">
            <span className="network-status">
              <span className={`status-dot ${status?.network.connected ? 'online' : ''}`} />
              {status?.network.connected ? 'Network connected' : 'Connecting to testnet'}
            </span>
            <button
              className="icon-button"
              title="Refresh arena"
              aria-label="Refresh arena"
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} />
            </button>
            <span className="avatar">FA</span>
          </div>
        </header>
        <main>
          {(error || connectionError) && (
            <div className="alert" role="alert">
              <XCircle size={17} />
              <span>{error || connectionError}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => {
                  setError('');
                  setConnectionError('');
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">BOT CHAIN / EXPERIMENT 001</div>
              <h1>
                {view === 'arena'
                  ? 'Forecast Arena'
                  : view === 'history'
                    ? 'Round history'
                    : view === 'leaderboard'
                      ? 'Leaderboard'
                      : 'Settings'}
              </h1>
            </div>
            <button
              className="primary-button"
              disabled={Boolean(active) || loading || publicBlocked}
              onClick={() => setModal(true)}
            >
              <Plus size={17} />
              New round
            </button>
          </div>
          {reviewer && publicAccess && (
            <div className="public-capacity">
              <span>
                Public rounds{' '}
                <b>
                  {publicAccess.remaining} / {publicAccess.dailyLimit}
                </b>{' '}
                remaining today
              </span>
              <span>
                {!publicAccess.enabled
                  ? 'AI rounds unavailable'
                  : !publicAccess.remaining
                    ? 'Resets at midnight UTC'
                    : publicCooldown > 0
                      ? `Next attempt in ${countdown(publicCooldown)}`
                      : '1-minute observation'}
              </span>
            </div>
          )}
          {view === 'arena' && (
            <>
              <div className="metrics">
                <div>
                  <span>Completed rounds</span>
                  <strong>
                    {fmt(settled.length)}
                    <small>settled</small>
                  </strong>
                </div>
                <div>
                  <span>Revealed forecasts</span>
                  <strong>
                    {fmt(
                      rounds.reduce(
                        (n, r) => n + r.forecasts.filter((f) => f.revealedAt).length,
                        0,
                      ),
                    )}
                    <small>public records</small>
                  </strong>
                </div>
                <div>
                  <span>Latest testnet block</span>
                  <strong>
                    {status?.network.blockNumber ? fmt(Number(status.network.blockNumber)) : '--'}
                    <small>BOT / 968</small>
                  </strong>
                </div>
                <div>
                  <span>AI integrations</span>
                  <strong>
                    {status?.configured.groq ? '02' : '00'}
                    <small>
                      {status?.configured.groq ? 'Groq configured' : 'awaiting credentials'}
                    </small>
                  </strong>
                </div>
              </div>
              <div className="arena-layout">
                <section className="round-section">
                  <div className="section-heading">
                    <h2>
                      {round
                        ? `Round ${rounds.length - rounds.findIndex((r) => r.id === round.id)}`
                        : 'Current round'}
                    </h2>
                    <span className={`badge ${round?.phase === 'SETTLED' ? 'green' : ''}`}>
                      {round ? labels[round.phase] : 'No active round'}
                    </span>
                  </div>
                  <div className="question-band">
                    <div className="eyebrow">TRANSACTION COUNT / BOT TESTNET</div>
                    <h2>How many transactions will BOT testnet process?</h2>
                    <div className="question-meta">
                      <span>
                        <Clock3 size={14} />
                        {round
                          ? `${(round.observationEnd - round.observationStart) / 60}-minute observation`
                          : '1 / 5 / 10-minute rounds'}
                      </span>
                      <span>
                        <ShieldCheck size={14} />
                        {round?.mode === 'onchain' ? 'On-chain commitments' : 'Local practice'}
                      </span>
                    </div>
                    {round && (
                      <div className="window">
                        {stamp(round.observationStart)}
                        <ArrowRight size={13} />
                        {stamp(round.observationEnd)}
                      </div>
                    )}
                  </div>
                  {loading ? (
                    <div className="empty-state">
                      <LoaderCircle className="spin" size={25} />
                      <h3>Connecting to the arena</h3>
                    </div>
                  ) : !round ? (
                    <div className="empty-state">
                      <div className="empty-symbol">
                        <LockKeyhole size={27} />
                      </div>
                      <h3>The first forecast is still unwritten.</h3>
                      <div className="empty-meta">No commitments · No results</div>
                      <button
                        className="secondary-button"
                        disabled={publicBlocked}
                        onClick={() => setModal(true)}
                      >
                        <Plus size={16} />
                        Open first round
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="round-progress">
                        {phases.map((p, i) => {
                          const current =
                            round.phase === 'AWAITING_RESULT' ? 2 : phases.indexOf(round.phase);
                          return (
                            <div
                              key={p}
                              className={`progress-step ${i < current ? 'done' : ''} ${i === current ? 'current' : ''}`}
                            >
                              <span>{i < current ? <Check size={12} /> : `0${i + 1}`}</span>
                              <label>{['Commit', 'Reveal', 'Observe', 'Result'][i]}</label>
                            </div>
                          );
                        })}
                      </div>
                      <div className="round-clock">
                        <span>
                          {round.phase === 'SETTLED'
                            ? 'Observed transactions'
                            : round.phase === 'CANCELLED'
                              ? 'Round closed'
                              : round.phase === 'AWAITING_RESULT'
                                ? 'Awaiting confirmed block evidence'
                                : `${labels[round.phase]} ends in`}
                        </span>
                        <strong>
                          {round.outcome !== undefined
                            ? fmt(round.outcome)
                            : ['CANCELLED', 'AWAITING_RESULT'].includes(round.phase)
                              ? '--'
                              : countdown(deadline - now)}
                        </strong>
                      </div>
                      {round.lastError && (
                        <div className="worker-error">
                          <span>{round.lastError}</span>
                          {operator && (
                            <button
                              className="icon-button"
                              disabled={busy}
                              title="Retry round worker"
                              aria-label="Retry round worker"
                              onClick={retry}
                            >
                              <RefreshCw size={16} />
                            </button>
                          )}
                        </div>
                      )}
                      <div className="tabs">
                        <button
                          className={detail === 'forecasts' ? 'active' : ''}
                          onClick={() => setDetail('forecasts')}
                        >
                          Forecasts <span>{round.forecasts.length}</span>
                        </button>
                        <button
                          className={detail === 'activity' ? 'active' : ''}
                          onClick={() => setDetail('activity')}
                        >
                          Activity
                        </button>
                      </div>
                      {detail === 'forecasts' ? (
                        <div className="forecast-list">
                          {round.forecasts.map((f, i) => (
                            <article className="forecast" key={f.id}>
                              <div className="forecast-top">
                                <span className={`agent-mark agent-${i}`}>
                                  <Activity size={19} />
                                </span>
                                <div>
                                  <h3>{f.name}</h3>
                                  <span className="muted">
                                    {f.kind === 'baseline'
                                      ? 'Statistical baseline'
                                      : 'Groq / service-executed'}
                                  </span>
                                </div>
                                <span className={`badge ${f.revealedAt ? 'green' : ''}`}>
                                  {f.failure
                                    ? 'Missed'
                                    : f.revealedAt
                                      ? 'Revealed'
                                      : f.committedAt
                                        ? 'Sealed'
                                        : 'Pending'}
                                </span>
                              </div>
                              <div className="prediction-value">
                                {f.value !== undefined ? (
                                  <>
                                    <strong>{fmt(f.value)}</strong>
                                    <span>transactions</span>
                                  </>
                                ) : (
                                  <>
                                    <LockKeyhole size={20} />
                                    <strong className="sealed-value">Sealed forecast</strong>
                                  </>
                                )}
                                {f.error !== undefined && (
                                  <span className="error-value">
                                    Error <b>{fmt(f.error)}</b>
                                  </span>
                                )}
                              </div>
                              {f.reasoning && <p className="reasoning">{f.reasoning}</p>}
                              <div className="commitment-row">
                                <Fingerprint size={13} />
                                <span title={f.commitment}>
                                  {f.commitment ? short(f.commitment) : 'Awaiting commitment'}
                                </span>
                                {f.revealTx ? (
                                  <ChainLink hash={f.revealTx} />
                                ) : f.commitTx ? (
                                  <ChainLink hash={f.commitTx} />
                                ) : (
                                  <small>Local record</small>
                                )}
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="activity-list">
                          {[...round.activity].reverse().map((a, i) => (
                            <div key={i}>
                              <span className="activity-dot" />
                              <p>{a.message}</p>
                              <time>{time(a.at)}</time>
                            </div>
                          ))}
                          {!round.activity.length && (
                            <p className="muted">Waiting for the first confirmed event.</p>
                          )}
                        </div>
                      )}
                      <div className="round-footer">
                        <a href={`/api/rounds/${round.id}/rules`} target="_blank" rel="noreferrer">
                          <Flag size={14} />
                          Round rules
                          <ExternalLink size={12} />
                        </a>
                        {round.outcome !== undefined && (
                          <a
                            href={`/api/rounds/${round.id}/evidence`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ArrowDownToLine size={14} />
                            Outcome evidence
                          </a>
                        )}
                        {operator && !['SETTLED', 'CANCELLED'].includes(round.phase) && (
                          <button
                            className="text-button danger"
                            onClick={() => setCancelId(round.id)}
                          >
                            Cancel round
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </section>
                <aside className="context-rail">
                  <section className="telemetry">
                    <div className="section-heading">
                      <h2>
                        <Radio size={16} />
                        Network pulse
                      </h2>
                      <span className="tiny-label">LIVE</span>
                    </div>
                    <div className="pulse-value">
                      <strong>{status?.samples.at(-1)?.transactions ?? '--'}</strong>
                      <span>tx / sampled block</span>
                    </div>
                    <LiveSignal samples={status?.samples || []} />
                    <div className="chart-footer">
                      <span>Recent block samples</span>
                      <span>15s interval</span>
                    </div>
                    <a
                      className="rail-link"
                      href="https://scan.bohr.life"
                      target="_blank"
                      rel="noreferrer"
                    >
                      BOT testnet explorer
                      <ExternalLink size={14} />
                    </a>
                  </section>
                  <section className="connection-section">
                    <div className="section-heading">
                      <h2>Connections</h2>
                      <button
                        className="icon-button"
                        title="Open connection settings"
                        aria-label="Open connection settings"
                        onClick={() => setView('settings')}
                      >
                        <Settings2 size={15} />
                      </button>
                    </div>
                    {[
                      { name: 'Testnet RPC', ready: status?.network.connected },
                      { name: 'Groq models', ready: status?.configured.groq },
                      { name: 'Signing wallet', ready: status?.configured.wallet },
                      { name: 'Arena contract', ready: status?.configured.contract },
                    ].map((c) => (
                      <div className="connection-row" key={c.name}>
                        <span>{c.name}</span>
                        <span className={c.ready ? 'connection-ready' : 'connection-pending'}>
                          {c.ready ? <Check size={13} /> : <span className="small-circle" />}
                          {c.ready ? 'Connected' : 'Not configured'}
                        </span>
                      </div>
                    ))}
                  </section>
                  <section className="record-section">
                    <div className="eyebrow">SETTLEMENT</div>
                    <h3>Operator-reported outcome</h3>
                    <div className="record-detail">
                      <ShieldCheck size={16} />
                      <span>Public block evidence</span>
                    </div>
                    <div className="record-detail">
                      <Fingerprint size={16} />
                      <span>
                        {round?.mode === 'onchain'
                          ? 'Commitments anchored on BOT'
                          : 'Local commitments in practice'}
                      </span>
                    </div>
                    {round?.contractAddress && <ChainLink hash={round.contractAddress} address />}
                    {round?.settleTx && <ChainLink hash={round.settleTx} />}
                  </section>
                </aside>
              </div>
            </>
          )}
          {view === 'history' && (
            <section className="full-section">
              <div className="section-heading">
                <h2>
                  All rounds <span className="muted">{rounds.length}</span>
                </h2>
                <select
                  aria-label="Filter round history"
                  value={historyMode}
                  onChange={(e) => setHistoryMode(e.target.value)}
                >
                  <option value="all">All rounds</option>
                  <option value="onchain">On-chain AI</option>
                  <option value="practice">Local practice</option>
                  <option value="SETTLED">Settled only</option>
                </select>
              </div>
              {rounds.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Round</th>
                        <th>Opened</th>
                        <th>Mode</th>
                        <th>Status</th>
                        <th>Outcome</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rounds
                        .filter(
                          (r) =>
                            historyMode === 'all' ||
                            r.mode === historyMode ||
                            r.phase === historyMode,
                        )
                        .map((r) => (
                          <tr key={r.id}>
                            <td>
                              <b>#{rounds.length - rounds.indexOf(r)}</b>
                              <small>Transaction count</small>
                            </td>
                            <td>{stamp(r.createdAt)}</td>
                            <td>{r.mode === 'onchain' ? 'On-chain AI' : 'Local practice'}</td>
                            <td>
                              <span className="badge">{labels[r.phase]}</span>
                            </td>
                            <td>{r.outcome !== undefined ? `${fmt(r.outcome)} tx` : '--'}</td>
                            <td>
                              <button
                                className="icon-button"
                                title="View round"
                                aria-label="View round"
                                onClick={() => {
                                  setSelected(r.id);
                                  setView('arena');
                                }}
                              >
                                <ArrowRight size={17} />
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {!rounds.some(
                    (r) =>
                      historyMode === 'all' || r.mode === historyMode || r.phase === historyMode,
                  ) && (
                    <div className="empty-state">
                      <h3>No rounds match this filter.</h3>
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty-state">
                  <History size={28} />
                  <h3>No rounds recorded yet.</h3>
                  <button
                    className="secondary-button"
                    disabled={publicBlocked}
                    onClick={() => setModal(true)}
                  >
                    <Plus size={16} />
                    New round
                  </button>
                </div>
              )}
            </section>
          )}
          {view === 'leaderboard' && (
            <section className="full-section">
              <div className="section-heading">
                <h2>Transaction-count forecasts</h2>
                <div className="segmented">
                  <button
                    className={boardMode === 'onchain' ? 'active' : ''}
                    onClick={() => setBoardMode('onchain')}
                  >
                    AI models
                  </button>
                  <button
                    className={boardMode === 'practice' ? 'active' : ''}
                    onClick={() => setBoardMode('practice')}
                  >
                    Baselines
                  </button>
                </div>
              </div>
              <div className="board-meta">
                <span>Lowest mean absolute error ranks first</span>
                <span>{scored.length} settled rounds · Ties share wins</span>
              </div>
              {leaderboard.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Participant</th>
                        <th>Mean error / tx</th>
                        <th>Scored rounds</th>
                        <th>Wins</th>
                        <th>Missed reveals</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboard.map((l, i) => (
                        <tr key={l.name}>
                          <td>
                            <span className={i === 0 ? 'rank top-rank' : 'rank'}>{i + 1}</span>
                          </td>
                          <td>
                            <b>{l.name}</b>
                          </td>
                          <td>{Number.isFinite(l.mean) ? l.mean.toFixed(1) : '--'}</td>
                          <td>{l.errors.length}</td>
                          <td>{l.wins}</td>
                          <td>{l.misses}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <Trophy size={30} />
                  <h3>No scored {boardMode === 'onchain' ? 'AI' : 'baseline'} rounds yet.</h3>
                  <span className="empty-meta">0 completed observations</span>
                </div>
              )}
            </section>
          )}
          {view === 'settings' && (
            <section className="settings-section">
              <div className="section-heading">
                <h2>Environment</h2>
                <span className="badge">BOT Testnet / 968</span>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Model provider</h3>
                  <span>Groq</span>
                </div>
                <span className={`badge ${status?.configured.groq ? 'green' : ''}`}>
                  {status?.configured.groq ? 'Configured' : 'Missing GROQ_API_KEY'}
                </span>
                <a
                  className="icon-button"
                  title="Create a Groq API key"
                  aria-label="Create a Groq API key"
                  href="https://console.groq.com/keys"
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={17} />
                </a>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Signing wallet</h3>
                  <span>Dedicated testnet operator</span>
                </div>
                <span className={`badge ${status?.configured.wallet ? 'green' : ''}`}>
                  {status?.configured.wallet ? 'Configured' : 'Missing DEPLOYER_PRIVATE_KEY'}
                </span>
                <a
                  className="icon-button"
                  title="Open testnet faucet"
                  aria-label="Open testnet faucet"
                  href="https://faucet.botchain.ai/basic"
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={17} />
                </a>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Arena contract</h3>
                  <span>
                    {status?.contract ? (
                      <ChainLink hash={status.contract} address />
                    ) : (
                      'Not deployed'
                    )}
                  </span>
                </div>
                <span className={`badge ${status?.configured.contract ? 'green' : ''}`}>
                  {status?.configured.contract ? 'Configured' : 'Missing ARENA_CONTRACT_ADDRESS'}
                </span>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Operator access</h3>
                  <span>
                    {operator
                      ? 'Operator verified'
                      : token
                        ? 'Token not recognized'
                        : 'Admin controls only'}
                  </span>
                </div>
                <form
                  className="token-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sessionStorage.setItem('arena-token', token);
                    setError('');
                    void refresh();
                  }}
                >
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Operator access token"
                    aria-label="Operator access token"
                    autoComplete="off"
                  />
                  <button
                    className="icon-button"
                    title="Save access token for this session"
                    aria-label="Save access token for this session"
                    type="submit"
                  >
                    <Check size={18} />
                  </button>
                </form>
              </div>
              <div className="settings-footer">
                <span>Credentials remain on the backend.</span>
                <a
                  href="https://dev-docs.botchain.ai/docs/Developers/quick-guide/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Network documentation
                  <ExternalLink size={14} />
                </a>
              </div>
            </section>
          )}
          <footer className="page-footer">
            <span>
              <span className="status-dot online" />
              BOT Testnet · No real-money stakes
            </span>
            <span>{status?.contract ? short(status.contract) : 'Local workspace'}</span>
          </footer>
        </main>
      </div>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) setModal(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <div className="eyebrow">NEW EXPERIMENT</div>
                <h2 id="modal-title">Open a forecast round</h2>
              </div>
              <button
                className="icon-button"
                disabled={busy}
                title="Close dialog"
                aria-label="Close dialog"
                onClick={() => setModal(false)}
              >
                <X size={19} />
              </button>
            </div>
            <label className="field-label">Round mode</label>
            {reviewer ? (
              <div className="readonly-mode">
                <ShieldCheck size={19} />
                <b>On-chain AI</b>
              </div>
            ) : (
              <div className="mode-options">
                <button
                  disabled={busy}
                  className={mode === 'practice' ? 'active' : ''}
                  onClick={() => setMode('practice')}
                >
                  <Activity size={19} />
                  <b>Local practice</b>
                  <span>Statistical baselines · Real chain outcome</span>
                </button>
                <button
                  disabled={busy || !ready}
                  className={mode === 'onchain' ? 'active' : ''}
                  onClick={() => setMode('onchain')}
                >
                  <ShieldCheck size={19} />
                  <b>On-chain AI</b>
                  <span>
                    {ready
                      ? 'Groq forecasts · BOT commitments'
                      : 'Requires model, wallet, and contract'}
                  </span>
                </button>
              </div>
            )}
            <label className="field-label" htmlFor="duration">
              Observation window
            </label>
            <select
              id="duration"
              disabled={busy || reviewer}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              <option value={60}>1 minute</option>
              {!reviewer && (
                <>
                  <option value={300}>5 minutes</option>
                  <option value={600}>10 minutes</option>
                </>
              )}
            </select>
            <div className="modal-summary">
              <span>Commit + reveal</span>
              <b>{!reviewer && mode === 'practice' ? '40 seconds' : '3 minutes 30 seconds'}</b>
              <span>Outcome source</span>
              <b>BOT testnet blocks</b>
              <span>Scoring</span>
              <b>Absolute prediction error</b>
            </div>
            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}
            <button
              className="primary-button modal-submit"
              disabled={busy || !status?.network.connected || publicBlocked || (reviewer && !ready)}
              onClick={openRound}
            >
              {busy ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />}
              {busy ? 'Preparing forecasts...' : 'Open round'}
            </button>
          </section>
        </div>
      )}
      {cancelId && (
        <div className="modal-backdrop">
          <section
            className="modal small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-title"
          >
            <div className="modal-heading">
              <h2 id="cancel-title">Cancel this round?</h2>
              <button
                className="icon-button"
                disabled={busy}
                title="Close dialog"
                aria-label="Close dialog"
                onClick={() => setCancelId(undefined)}
              >
                <X size={18} />
              </button>
            </div>
            <p>The round remains in history and will not receive a score.</p>
            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setCancelId(undefined)}
              >
                Keep round
              </button>
              <button className="danger-button" disabled={busy} onClick={cancel}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <XCircle size={16} />}Cancel
                round
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
