import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ExternalLink,
  Layers,
  Locate,
  Minus,
  Moon,
  Plus,
  Search,
  Sun,
} from 'lucide-react';

export interface MapViewProps {
  destination?: string | null;
  mini?: boolean;
  onNavigate?: (destination: string) => void;
  onStop?: () => void;
  navInfo?: { destination: string; minutes: number; km: number; startedAt: number } | null;
}

const DEFAULT_ORIGIN = 'New Delhi, India';

const POPULAR_DESTINATIONS = [
  { label: 'Home', query: 'Connaught Place, New Delhi', icon: '🏠' },
  { label: 'Office', query: 'DLF Cyber City, Gurugram', icon: '🏢' },
  { label: 'Airport', query: 'IGI Airport Terminal 3, Delhi', icon: '✈️' },
  { label: 'EV Station', query: 'Tata Power EV Charging Station, Delhi', icon: '⚡' },
  { label: 'Fuel Pump', query: 'Indian Oil Petrol Pump, Delhi', icon: '⛽' },
  { label: 'India Gate', query: 'India Gate, New Delhi', icon: '📍' },
];

function GooglePinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" style={{ width: '1.25em', height: '1.25em' }}>
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#EA4335" />
      <circle cx="12" cy="9" r="2.8" fill="#FFFFFF" />
      <path d="M12 2C8.13 2 5 5.13 5 9c0 2.2.98 4.6 2.45 6.9L12 9V2z" fill="#4285F4" opacity="0.35" />
    </svg>
  );
}

export function MapView({ destination, mini = false, onNavigate }: MapViewProps) {
  const [searchInput, setSearchInput] = useState('');
  const [mapType, setMapType] = useState<'m' | 'k'>('m'); // 'm' = Roadmap, 'k' = Satellite
  const [nightMode, setNightMode] = useState(true);
  const [zoom, setZoom] = useState(destination ? 15 : 14);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [hasGps, setHasGps] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  // Request browser location for real-time car positioning
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setHasGps(true);
      },
      () => {
        // Fallback gracefully to default city
      },
      { timeout: 8000, enableHighAccuracy: true }
    );
  }, []);

  // Update zoom when destination changes
  useEffect(() => {
    if (destination) {
      setZoom(15);
      setIframeLoaded(false);
    }
  }, [destination]);

  // Compute search/location query for Google Maps embed
  const query = useMemo(() => {
    if (destination && destination.trim()) {
      return destination.trim();
    }
    if (gpsCoords) {
      return `${gpsCoords.lat.toFixed(5)},${gpsCoords.lng.toFixed(5)}`;
    }
    return DEFAULT_ORIGIN;
  }, [destination, gpsCoords]);

  // Google Maps embed URL
  const embedUrl = useMemo(() => {
    const q = encodeURIComponent(query);
    const t = mapType === 'k' ? '&t=k' : '';
    const z = `&z=${zoom}`;
    return `https://maps.google.com/maps?q=${q}${t}${z}&ie=UTF8&iwloc=&output=embed`;
  }, [query, mapType, zoom]);

  // Direct Google Maps link for opening in full Google Maps app/tab
  const googleMapsWebUrl = useMemo(() => {
    if (destination) {
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }, [destination, query]);

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    if (!searchInput.trim()) return;
    onNavigate?.(searchInput.trim());
    setSearchInput('');
  };

  const handleQuickDestination = (q: string) => {
    onNavigate?.(q);
  };

  const reCenterGps = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setHasGps(true);
          setZoom(16);
        },
        () => {},
        { timeout: 6000 }
      );
    }
  };

  if (mini) {
    return (
      <div className="gmap-wrap mini">
        <iframe
          title="Google Maps Mini Preview"
          className={`gmap-frame ${nightMode ? 'night' : ''}`}
          src={embedUrl}
          tabIndex={-1}
          loading="lazy"
        />
        <div className="gmap-mini-overlay">
          <span className="gmap-mini-badge">
            <GooglePinIcon />
            <span>Google Maps</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="gmap-wrap">
      {/* Live Google Map Iframe */}
      <iframe
        title="Interactive Google Map"
        className={`gmap-frame ${nightMode ? 'night' : ''} ${!iframeLoaded ? 'loading' : ''}`}
        src={embedUrl}
        loading="lazy"
        onLoad={() => setIframeLoaded(true)}
      />

      {/* Top Right Header Toolbar */}
      <div className="gmap-top-bar">
        <span className="gmap-badge" title="Live Google Maps Automotive Navigation">
          <GooglePinIcon />
          <span>Google Maps</span>
          {hasGps && <span className="gmap-live-dot" title="Live GPS Connected" />}
        </span>

        {/* Satellite vs Street view toggle */}
        <button
          type="button"
          className={`gmap-btn ${mapType === 'k' ? 'active' : ''}`}
          onClick={() => setMapType((t) => (t === 'k' ? 'm' : 'k'))}
          title={mapType === 'k' ? 'Switch to Street Map' : 'Switch to Satellite View'}
        >
          <Layers />
          <span>{mapType === 'k' ? 'Satellite' : 'Roadmap'}</span>
        </button>

        {/* Night HUD vs Day Mode toggle */}
        <button
          type="button"
          className={`gmap-btn ${nightMode ? 'active' : ''}`}
          onClick={() => setNightMode((n) => !n)}
          title={nightMode ? 'Switch to Daylight Map' : 'Switch to Night Cockpit HUD Map'}
        >
          {nightMode ? <Moon /> : <Sun />}
          <span>{nightMode ? 'Night HUD' : 'Daylight'}</span>
        </button>

        {/* Open in Google Maps */}
        <a
          href={googleMapsWebUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="gmap-btn"
          title="Open in Google Maps App"
        >
          <ExternalLink />
        </a>
      </div>

      {/* Floating Right-Side Zoom & GPS Controls */}
      <div className="gmap-side-controls">
        <button
          type="button"
          className="gmap-round-btn"
          onClick={() => setZoom((z) => Math.min(z + 1, 19))}
          title="Zoom In"
        >
          <Plus />
        </button>
        <button
          type="button"
          className="gmap-round-btn"
          onClick={() => setZoom((z) => Math.max(z - 1, 6))}
          title="Zoom Out"
        >
          <Minus />
        </button>
        <button
          type="button"
          className="gmap-round-btn"
          onClick={reCenterGps}
          title={hasGps ? 'Re-center to Car Location (GPS)' : 'Find My Location'}
        >
          <Locate />
        </button>
      </div>

      {/* Search Bar Overlay when NOT in active navigation */}
      {!destination && (
        <div className="gmap-search-bar">
          <form className="gmap-search-form" onSubmit={handleSearch}>
            <Search />
            <input
              type="text"
              className="gmap-search-input"
              placeholder="Search Google Maps or say destination…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            {searchInput.trim() && (
              <button type="submit" className="gmap-search-go">
                Go
              </button>
            )}
          </form>

          {/* Quick Destination Chips */}
          <div className="gmap-chips">
            {POPULAR_DESTINATIONS.map((d) => (
              <button
                key={d.label}
                type="button"
                className="gmap-chip"
                onClick={() => handleQuickDestination(d.query)}
              >
                <span>{d.icon}</span>
                <span>{d.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
