// ── Route Calculation Module ──────────────────────────────────────────────
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/**
 * Geocode a text address to {lat, lng} using Nominatim.
 * Returns null on failure.
 */
async function geocodeAddress(address) {
  try {
    const url = `${NOMINATIM}?format=json&q=${encodeURIComponent(address + ' 台灣')}&limit=1&accept-language=zh-TW`;
    const res = await fetch(url, { headers: { 'User-Agent': 'TaiwanCompanyMap/1.0' } });
    const data = await res.json();
    if (data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
    }
  } catch (e) {
    console.warn('Geocode failed:', e);
  }
  return null;
}

/**
 * Calculate route via OSRM. Falls back to straight-line estimate on failure.
 * @param {Array<{lat,lng}>} waypoints
 * @returns {Promise<{distance:number, duration:number, geometry:object|null, legs:Array}>}
 */
async function calculateRoute(waypoints) {
  if (waypoints.length < 2) return null;

  const coords = waypoints.map(wp => `${wp.lng},${wp.lat}`).join(';');
  const url = `${OSRM_BASE}${coords}?overview=full&geometries=geojson&steps=false`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.code === 'Ok' && data.routes?.length > 0) {
      const route = data.routes[0];
      return {
        distance: route.distance / 1000,       // km
        duration: route.duration / 60,          // minutes
        geometry: route.geometry,               // GeoJSON LineString
        legs: route.legs.map(leg => ({
          distance: leg.distance / 1000,
          duration: leg.duration / 60
        })),
        source: 'osrm'
      };
    }
    throw new Error('No route in response');
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn('OSRM timeout, using straight-line fallback');
    } else {
      console.warn('OSRM failed, using straight-line fallback:', e.message);
    }
    return straightLineFallback(waypoints);
  }
}

function straightLineFallback(waypoints) {
  let totalDist = 0;
  const legs = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const d = haversine(waypoints[i], waypoints[i + 1]) * 1.35; // road factor
    const t = d / 50 * 60; // assume 50 km/h average
    legs.push({ distance: d, duration: t });
    totalDist += d;
  }
  return {
    distance: totalDist,
    duration: legs.reduce((s, l) => s + l.duration, 0),
    geometry: null,
    legs,
    source: 'fallback'
  };
}

function haversine(p1, p2) {
  const R = 6371;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(km) {
  if (km < 1) return (km * 1000).toFixed(0) + ' 公尺';
  return km.toFixed(1) + ' 公里';
}

function formatDuration(minutes) {
  if (minutes < 1) return '< 1 分鐘';
  if (minutes < 60) return Math.round(minutes) + ' 分鐘';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h} 小時 ${m} 分鐘` : `${h} 小時`;
}

function buildGoogleMapsUrl(waypoints) {
  if (waypoints.length < 2) return null;
  // Each waypoint is its own /lat,lng/ path segment — supports up to 10 stops
  const parts = waypoints.map(wp => `${wp.lat},${wp.lng}`);
  return 'https://www.google.com/maps/dir/' + parts.join('/');
}
