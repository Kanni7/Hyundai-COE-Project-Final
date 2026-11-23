import { useCallback, useEffect, useState } from 'react';
import { Check, Download, Languages, Trash2 } from 'lucide-react';
import { backend, type PackInfo, type PackStatus } from '../lib/backend';

/**
 * Settings section: the driver's language and the on-device models to download for it.
 * Online, every language is understood through cloud speech; a language pack makes it work with no network,
 * and an assistant pack (Gemma 3) answers general questions on the car's own computer.
 */
export function LanguagePacks() {
  const [s, setS] = useState<PackStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => backend.packs().then(setS, () => setS(null)), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const busy = !!s?.packs.some((p) => p.downloading);
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(t);
  }, [busy, refresh]);

  const act = (call: Promise<PackStatus>) => call.then((next) => { setS(next); setError(null); }, (e: Error) => setError(e.message));

  if (!s) return <p className="settings-note">Connect the server to manage languages and on-device models.</p>;
  const assistants = s.packs.filter((p) => p.kind === 'assistant');
  const langs = s.packs.filter((p) => p.kind === 'language');
  return (
    <div className="packs">
      <div className="settings-heading"><Languages /><span>Languages & on-device AI</span></div>
      <label className="settings-row">
        <span>Driver language</span>
        <select value={s.active_language ?? ''} onChange={(e) => void act(backend.setDriverLanguage(e.target.value || null))}>
          <option value="">Auto (English / Hindi)</option>
          {langs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <p className="settings-note">
        Online, all 22 languages are understood. Download a language to use it offline too, and the assistant to ask
        the car general questions without the internet (it answers in English).
      </p>
      <ul className="pack-list">
        {[...assistants, ...langs].map((p) => (
          <PackRow key={p.id} p={p} driver={p.id === s.active_language}
            onDownload={() => void act(backend.downloadPack(p.id))} onDelete={() => void act(backend.deletePack(p.id))} />
        ))}
      </ul>
      {error && <p className="wind-test-error">{error}</p>}
    </div>
  );
}

function PackRow({ p, driver, onDownload, onDelete }: { p: PackInfo; driver: boolean; onDownload: () => void; onDelete: () => void }) {
  const pct = p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : 0;
  return (
    <li className={`pack ${driver ? 'driver' : ''}`}>
      <span className="pack-name">{p.name}</span>
      {p.builtin ? <em>Built in</em>
        : p.downloading ? (
          <span className="pack-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${p.name}`}>
            <i style={{ width: `${pct}%` }} />{pct}%
          </span>
        ) : p.installed ? (
          <span className="pack-actions">
            <Check aria-label="Installed" />
            <button type="button" onClick={onDelete} title={`Remove ${p.name}`} aria-label={`Remove ${p.name}`}><Trash2 /></button>
          </span>
        ) : (
          <button type="button" className="pack-get" onClick={onDownload} title={p.error ? `Last try failed: ${p.error}` : undefined}>
            <Download />{p.error ? 'Retry' : `${p.mb >= 1000 ? `${(p.mb / 1024).toFixed(1)} GB` : `${p.mb} MB`}`}
          </button>
        )}
    </li>
  );
}
