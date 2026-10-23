import { useState, type CSSProperties, type FormEvent } from 'react';
import { User, X, Check, Sliders, Thermometer, Gauge, Sparkles } from 'lucide-react';
import type { AmbientColor, DriveMode } from '../types';
import { addProfile, type Profile } from '../lib/profiles';

interface AddProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProfileCreated: (profile: Profile) => void;
}

const AMBIENT_COLORS: { id: AmbientColor; hex: string; label: string }[] = [
  { id: 'blue', hex: '#3d8bff', label: 'Blue' },
  { id: 'cyan', hex: '#22e4ff', label: 'Cyan' },
  { id: 'green', hex: '#34e07a', label: 'Green' },
  { id: 'gold', hex: '#ffb84d', label: 'Gold' },
  { id: 'pink', hex: '#ff4fa8', label: 'Pink' },
  { id: 'purple', hex: '#c084fc', label: 'Purple' },
  { id: 'red', hex: '#f87171', label: 'Red' },
];

export function AddProfileModal({ isOpen, onClose, onProfileCreated }: AddProfileModalProps) {
  const [name, setName] = useState('');
  const [heightCm, setHeightCm] = useState(175);
  const [weightKg, setWeightKg] = useState(70);
  const [temp, setTemp] = useState(22);
  const [driveMode, setDriveMode] = useState<DriveMode>('normal');
  const [ambient, setAmbient] = useState<AmbientColor>('blue');
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanName = name.trim();
    if (!cleanName) {
      setError('Please enter a driver name.');
      return;
    }
    if (cleanName.toLowerCase() === 'default') {
      setError('“Default” is a reserved name. Please use another name.');
      return;
    }

    try {
      const p = addProfile(cleanName, Number(heightCm), Number(weightKg), {
        temp: Number(temp),
        ambient,
        driveMode,
      });
      onProfileCreated(p);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create profile');
    }
  };

  return (
    <div className="add-profile-overlay" role="dialog" aria-modal="true" aria-labelledby="add-prof-title" onClick={onClose}>
      <div className="add-profile-modal" onClick={(e) => e.stopPropagation()}>
        <header className="add-profile-header">
          <div className="add-profile-title-group">
            <div className="add-profile-avatar-preview">
              <User size={18} />
            </div>
            <div>
              <h3 id="add-prof-title">New Driver Profile</h3>
              <p>Personalized seat, steering, climate, and voice identification</p>
            </div>
          </div>
          <button className="add-profile-close" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="add-profile-form">
          {error && <div className="add-profile-error">{error}</div>}

          <div className="add-profile-field">
            <label htmlFor="driver-name">Driver Name</label>
            <input
              id="driver-name"
              type="text"
              placeholder="e.g. Aarav, Meera, Parvesh"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              maxLength={24}
              required
            />
          </div>

          <div className="add-profile-row">
            <div className="add-profile-field">
              <label htmlFor="driver-height">
                <span>Height</span>
                <span className="field-val">{heightCm} cm</span>
              </label>
              <input
                id="driver-height"
                type="range"
                min={145}
                max={205}
                value={heightCm}
                onChange={(e) => {
                  const h = Number(e.target.value);
                  setHeightCm(h);
                  setWeightKg(Math.round((h - 100) * 0.9));
                }}
              />
            </div>

            <div className="add-profile-field">
              <label htmlFor="driver-weight">
                <span>Weight</span>
                <span className="field-val">{weightKg} kg</span>
              </label>
              <input
                id="driver-weight"
                type="range"
                min={40}
                max={120}
                value={weightKg}
                onChange={(e) => setWeightKg(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="add-profile-divider">
            <Sliders size={13} />
            <span>Preferences</span>
          </div>

          <div className="add-profile-prefs-grid">
            <div className="pref-item">
              <label><Thermometer size={13} /> AC Temp</label>
              <div className="pref-options temp-pills">
                {[20, 21, 22, 23, 24].map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={temp === t ? 'active' : ''}
                    onClick={() => setTemp(t)}
                  >
                    {t}°C
                  </button>
                ))}
              </div>
            </div>

            <div className="pref-item">
              <label><Gauge size={13} /> Drive Mode</label>
              <div className="pref-options mode-pills">
                {(['eco', 'normal', 'sport'] as DriveMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={driveMode === m ? 'active' : ''}
                    onClick={() => setDriveMode(m)}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="pref-item ambient-pref">
            <label><Sparkles size={13} /> Ambient Light</label>
            <div className="ambient-palette">
              {AMBIENT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  title={c.label}
                  className={`color-dot ${ambient === c.id ? 'active' : ''}`}
                  style={{ '--dot-c': c.hex } as CSSProperties}
                  onClick={() => setAmbient(c.id)}
                >
                  {ambient === c.id && <Check size={12} />}
                </button>
              ))}
            </div>
          </div>

          <footer className="add-profile-actions">
            <button type="button" className="btn-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-submit">
              Save & Set Profile
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
