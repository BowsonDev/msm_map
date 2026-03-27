// ── Map Module (Leaflet + OpenStreetMap) ─────────────────────────────────
let _map, _clusterGroup, _routeLayer, _startMarker;
const _markers = {}; // id -> L.Marker
let _routeMode = false; // true = only route stop markers are shown

// Industry → colour mapping
const INDUSTRY_COLORS = {
  '半導體製造':      '#e91e63',
  'IC設計':          '#9c27b0',
  '封裝測試':        '#673ab7',
  '面板顯示':        '#2196f3',
  'EMS電子製造':     '#0097a7',
  '電源/工業自動化': '#4caf50',
  '電子零組件':      '#009688',
  '光電零組件':      '#00bcd4',
  '電腦品牌':        '#ff9800',
  '石化原料':        '#795548',
  '鋼鐵金屬':        '#607d8b',
  '食品飲料':        '#ff5722',
  '電信':            '#f44336',
  '金融':            '#ffc107',
  '通路':            '#8bc34a',
  '軟體服務':        '#9e9e9e',
};
const DEFAULT_COLOR = '#1a73e8';

function industryColor(industry) {
  for (const [key, color] of Object.entries(INDUSTRY_COLORS)) {
    if (industry && industry.includes(key)) return color;
  }
  return DEFAULT_COLOR;
}

function makeSvgIcon(color, label = '', size = 32) {
  const h = Math.round(size * 1.3);
  const inner = label
    ? `<text x="${size / 2}" y="${size / 2 + 5}" text-anchor="middle" fill="white" font-size="${size * 0.4}" font-weight="bold" font-family="sans-serif">${label}</text>`
    : `<circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.18}" fill="white" opacity="0.9"/>`;
  return L.divIcon({
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${h}" width="${size}" height="${h}">
      <path d="M${size / 2} 0C${size * 0.227} 0 0 ${size * 0.227} 0 ${size / 2}c0 ${size * 0.35} ${size / 2} ${size * 0.8} ${size / 2} ${size * 0.8}S${size} ${size * 0.85} ${size} ${size / 2}C${size} ${size * 0.227} ${size * 0.773} 0 ${size / 2} 0z" fill="${color}" stroke="white" stroke-width="2"/>
      ${inner}
    </svg>`,
    className: '',
    iconSize: [size, h],
    iconAnchor: [size / 2, h],
    popupAnchor: [0, -h],
  });
}

function initMap() {
  _map = L.map('map', { center: [23.8, 121.0], zoom: 8, zoomControl: true });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(_map);

  _clusterGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 50,
    showCoverageOnHover: false,
    iconCreateFunction: cluster => L.divIcon({
      html: `<div style="width:38px;height:38px;border-radius:50%;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3)">${cluster.getChildCount()}</div>`,
      className: '',
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    }),
  });
  _map.addLayer(_clusterGroup);
}

function buildPopupHtml(company) {
  const tags = (company.tags || []).map(t => `<span class="popup-tag">${t}</span>`).join('');
  const rev = company.revenue_100m ? `${Number(company.revenue_100m).toLocaleString()} 億` : '–';
  const emp = company.employees ? `${Number(company.employees).toLocaleString()} 人` : '';
  return `<div style="min-width:200px">
    <div class="popup-name">${company.short_name || company.name}</div>
    <div class="popup-tags">${tags}</div>
    <div class="popup-meta">
      📍 ${company.city || ''}${company.district || ''}<br>
      💰 營收 ${rev}${emp ? `　👥 ${emp}` : ''}
    </div>
    <div class="popup-actions">
      <button class="popup-btn popup-btn-detail" onclick="APP.showDetail(${company.id})">詳情</button>
      <button class="popup-btn popup-btn-route" onclick="APP.addToRoute(${company.id})">+加入行程</button>
    </div>
  </div>`;
}

function addMarker(company) {
  if (!company.lat || !company.lng) return;
  const marker = L.marker([company.lat, company.lng], {
    icon: makeSvgIcon(industryColor(company.industry)),
    title: company.short_name || company.name,
  });
  marker.bindPopup(buildPopupHtml(company), { maxWidth: 300 });
  marker.on('click', () => APP.onMarkerClick(company.id));
  _markers[company.id] = marker;
  _clusterGroup.addLayer(marker);
}

function removeAllMarkers() {
  _clusterGroup.clearLayers();
  Object.keys(_markers).forEach(k => delete _markers[k]);
}

function refreshMarkers(companies) {
  removeAllMarkers();
  companies.forEach(addMarker);
}

function highlightRouteMarkers(routeStops) {
  if (_routeMode) return; // in route mode, markers are managed by showRouteOnlyMarkers
  // Reset all to industry color
  Object.entries(_markers).forEach(([id, m]) => {
    const c = APP.getCompanyById(+id);
    if (c) m.setIcon(makeSvgIcon(industryColor(c.industry)));
  });
  // Highlight route stops with numbered orange pins
  routeStops.forEach((company, idx) => {
    if (_markers[company.id]) {
      _markers[company.id].setIcon(makeSvgIcon('#ff5722', String(idx + 1)));
    }
  });
}

// Called after route is calculated: hide all non-route markers,
// show stops with numbered pins, last stop in blue as 回程點.
function showRouteOnlyMarkers(routeStops) {
  _routeMode = true;
  removeAllMarkers();
  const last = routeStops.length - 1;
  routeStops.forEach((company, idx) => {
    if (!company.lat || !company.lng) return;
    const isLast = idx === last;
    // Last stop = blue "回", others = orange numbered
    const color = isLast ? '#1a73e8' : '#ff5722';
    const label = isLast ? '回' : String(idx + 1);
    const size  = isLast ? 36 : 32;
    const marker = L.marker([company.lat, company.lng], {
      icon: makeSvgIcon(color, label, size),
      title: company.short_name || company.name,
      zIndexOffset: isLast ? 100 : idx * 10,
    });
    marker.bindPopup(buildPopupHtml(company), { maxWidth: 300 });
    marker.on('click', () => APP.onMarkerClick(company.id));
    _markers[company.id] = marker;
    _clusterGroup.addLayer(marker);
  });
}

// Exit route mode: restore all company markers
function exitRouteMode(companies) {
  _routeMode = false;
  refreshMarkers(companies);
}

function drawRouteLine(geometry) {
  clearRouteLine();
  if (!geometry) return;
  _routeLayer = L.geoJSON(geometry, {
    style: { color: '#ff5722', weight: 5, opacity: .75, dashArray: '8 4' },
  }).addTo(_map);
}

function clearRouteLine() {
  if (_routeLayer) { _map.removeLayer(_routeLayer); _routeLayer = null; }
}

function setStartMarker(lat, lng, label) {
  if (_startMarker) _map.removeLayer(_startMarker);
  _startMarker = L.marker([lat, lng], {
    icon: makeSvgIcon('#34a853', '起', 36),
    title: label || '起點',
    zIndexOffset: 1000,
  }).addTo(_map).bindPopup(`<b>起點</b>${label ? '<br>' + label : ''}`);
}

function clearStartMarker() {
  if (_startMarker) { _map.removeLayer(_startMarker); _startMarker = null; }
}

function panTo(lat, lng, zoom) {
  _map.setView([lat, lng], zoom || 14);
}

function openMarkerPopup(id) {
  if (_markers[id]) {
    _clusterGroup.zoomToShowLayer(_markers[id], () => _markers[id].openPopup());
  }
}

function fitAll() {
  const layers = Object.values(_markers);
  if (!layers.length) return;
  _map.fitBounds(L.featureGroup(layers).getBounds().pad(.08));
}

function fitBounds(latLngs) {
  if (!latLngs.length) return;
  _map.fitBounds(L.latLngBounds(latLngs).pad(.1));
}
