// ── Main Application ──────────────────────────────────────────────────────
// ── CRM status definitions ─────────────────────────────────────────────────
const STATUS_LIST = ['undeveloped', 'evaluating', 'closed'];
const STATUS_INFO = {
  undeveloped: { label: '未開發', icon: '🔴', color: '#e53935' },
  evaluating:  { label: '評估中', icon: '🟡', color: '#f9a825' },
  closed:      { label: '已成交', icon: '🟢', color: '#43a047' },
};

const APP = {
  companies: [],
  filtered: [],
  route: [],
  activeFilters: new Set(),
  searchQuery: '',
  fuse: null,
  startLocation: null,
  endLocation: null,
  endSameAsStart: true,
  autoSort: true,
  customAddresses: {},   // key → { custom_address, custom_lat, custom_lng, updated_at }
  crm: {},               // key → { status, notes:[{text,time}], last_visit }
  settings: { reminderDays: 30 },
  crmOverviewFilter: 'all',
  crmOverviewSearch: '',
  crmExpandedIds: new Set(),
  pendingImportData: null,

  // ── Bootstrap ──────────────────────────────────────────────────────────
  async init() {
    try { initMap(); } catch (e) { console.error('Map init failed:', e); }
    await this.loadData();
    this.loadCustomAddresses();
    this.loadCRM();
    this.loadSettings();
    this.buildFuse();
    this.renderTagFilters();
    this.applySearch();
    this._updateCRMCount();
    this.setupListeners();
  },

  async loadData() {
    try {
      const res = await fetch('data/companies.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      this.companies = json.companies || json;
      this.filtered = [...this.companies];
    } catch (e) {
      this.notify('無法載入公司資料：' + e.message, 'error');
    }
  },

  buildFuse() {
    this.fuse = new Fuse(this.companies, {
      keys: [
        { name: 'name',         weight: 0.4 },
        { name: 'short_name',   weight: 0.4 },
        { name: 'english_name', weight: 0.2 },
        { name: 'tax_id',       weight: 0.3 },
        { name: 'city',         weight: 0.1 },
        { name: 'tags',         weight: 0.2 },
      ],
      threshold: 0.45,
      minMatchCharLength: 1,
      includeScore: true,
    });
  },

  // ── Search & Filter ────────────────────────────────────────────────────
  applySearch() {
    const q = this.searchQuery.trim();
    let result;

    if (!q) {
      result = [...this.companies];
    } else if (/^\d{8}$/.test(q)) {
      result = this.companies.filter(c => c.tax_id === q);
    } else {
      result = this.fuse.search(q).map(r => r.item);
    }

    if (this.activeFilters.size > 0) {
      result = result.filter(c =>
        [...this.activeFilters].some(f =>
          (c.tags || []).includes(f) || c.industry === f
        )
      );
    }

    this.filtered = result;
    this.renderCompanyList();
    refreshMarkers(this.filtered);
    this.updateResultCount();
  },

  toggleFilter(tag) {
    if (this.activeFilters.has(tag)) this.activeFilters.delete(tag);
    else this.activeFilters.add(tag);
    document.querySelectorAll('.tag-chip').forEach(el => {
      el.classList.toggle('active', this.activeFilters.has(el.dataset.tag));
    });
    this.applySearch();
  },

  clearFilters() {
    this.activeFilters.clear();
    document.querySelectorAll('.tag-chip').forEach(el => el.classList.remove('active'));
    this.applySearch();
  },

  // ── Render ─────────────────────────────────────────────────────────────
  renderTagFilters() {
    const allTags = new Set();
    this.companies.forEach(c => (c.tags || []).forEach(t => allTags.add(t)));
    const container = document.getElementById('tag-filters');
    container.innerHTML = '';
    [...allTags].sort().forEach(tag => {
      const btn = document.createElement('span');
      btn.className = 'tag-chip';
      btn.dataset.tag = tag;
      btn.textContent = tag;
      btn.addEventListener('click', () => this.toggleFilter(tag));
      container.appendChild(btn);
    });
  },

  renderCompanyList() {
    const el = document.getElementById('company-list');
    if (!this.filtered.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>找不到符合條件的公司<br>請調整搜尋條件或篩選標籤</p></div>`;
      return;
    }
    el.innerHTML = this.filtered.map(c => this.companyCardHtml(c)).join('');

    // Bind card actions
    el.querySelectorAll('.company-card').forEach(card => {
      const id = +card.dataset.id;
      card.addEventListener('click', e => {
        if (e.target.closest('button')) return; // handled by button
        this.selectCard(id);
      });
      card.querySelector('.btn-detail')?.addEventListener('click', () => this.showDetail(id));
      card.querySelector('.btn-route-add')?.addEventListener('click', () => this.addToRoute(id));
      card.querySelector('.btn-route-remove')?.addEventListener('click', () => this.removeFromRoute(id));
      card.querySelector('.btn-status-cycle')?.addEventListener('click', () => this.cycleStatus(id));
    });
  },

  companyCardHtml(c) {
    const inRoute   = this.route.some(r => r.id === c.id);
    const hasCustom = !!(this.customAddresses[this.getCompanyKey(c)]?.custom_address);
    const crm       = this.crm[this.getCompanyKey(c)] || {};
    const si        = crm.status ? STATUS_INFO[crm.status] : null;
    const overdue   = this.isOverdueVisit(c);
    const tags      = (c.tags || []).slice(0, 3).map(t => `<span class="tag">${t}</span>`).join('');
    const rev       = c.revenue_100m ? `${Number(c.revenue_100m).toLocaleString()} 億` : '';
    const emp       = c.employees   ? `${Number(c.employees).toLocaleString()} 人` : '';
    const routeBtn  = inRoute
      ? `<button class="btn-sm btn-sm-danger btn-route-remove">✓ 已加入</button>`
      : `<button class="btn-sm btn-sm-primary btn-route-add">+ 行程</button>`;
    const statusBtn = si
      ? `<button class="btn-status btn-status-set btn-status-cycle" style="border-color:${si.color};color:${si.color}">${si.icon} ${si.label}</button>`
      : `<button class="btn-status btn-status-unset btn-status-cycle">＋ 設狀態</button>`;
    return `
      <div class="company-card${inRoute ? ' in-route' : ''}" data-id="${c.id}">
        <div class="card-header">
          ${c.rank ? `<span class="company-rank">#${c.rank}</span>` : ''}
          <span class="company-name">${c.short_name || c.name}</span>
          ${hasCustom ? `<span class="card-custom-badge" title="已設定自訂地址">✏️</span>` : ''}
          ${overdue   ? `<span class="card-overdue-badge" title="距上次備註已超過 ${this.settings.reminderDays} 天">⚠️</span>` : ''}
          <span class="city-badge">${c.city || ''}</span>
        </div>
        <div class="card-tags">
          <span class="tag industry">${c.industry || ''}</span>
          ${tags}
        </div>
        <div class="card-info">
          ${rev ? `<span>💰 ${rev}</span>` : ''}
          ${emp ? `<span>👥 ${emp}</span>` : ''}
          ${c.stock_code ? `<span>📈 ${c.stock_code}</span>` : ''}
        </div>
        <div class="card-actions">
          ${statusBtn}
          <button class="btn-sm btn-sm-outline btn-detail">詳情</button>
          ${routeBtn}
        </div>
      </div>`;
  },

  selectCard(id) {
    document.querySelectorAll('.company-card').forEach(c => c.classList.remove('selected'));
    const card = document.querySelector(`.company-card[data-id="${id}"]`);
    if (card) card.classList.add('selected');
    openMarkerPopup(id);
  },

  updateResultCount() {
    document.getElementById('result-count').textContent = this.filtered.length;
  },

  // ── Company Detail ─────────────────────────────────────────────────────
  showDetail(id) {
    const c = this.getCompanyById(id);
    if (!c) return;
    const inRoute = this.route.some(r => r.id === c.id);
    const capital = c.capital ? `${(c.capital / 100000000).toFixed(1)} 億` : '–';
    const rev = c.revenue_100m ? `${Number(c.revenue_100m).toLocaleString()} 億` : '–';
    const emp = c.employees ? `${Number(c.employees).toLocaleString()} 人` : '–';
    const tags = [c.industry, ...(c.tags || [])].filter(Boolean)
      .map(t => `<span class="tag">${t}</span>`).join('');

    // Custom address state
    const custom = this.customAddresses[this.getCompanyKey(c)];
    const hasCustom = !!(custom && custom.custom_address);
    const displayCoords = this.getCompanyCoords(c);
    const mapUrl  = `https://www.openstreetmap.org/?mlat=${displayCoords.lat}&mlon=${displayCoords.lng}&zoom=16`;
    const gMapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      hasCustom ? custom.custom_address : (c.address || c.name)
    )}`;

    const customSection = `
      <div class="custom-addr-section">
        <div class="custom-addr-header">
          <span class="custom-addr-title">實際拜訪地址</span>
          ${hasCustom
            ? `<span class="addr-badge custom">✏️ 自訂</span>
               <button class="btn-text-sm" onclick="APP.clearCustomAddress(${c.id})">恢復系統</button>`
            : `<span class="addr-badge system">系統地址</span>`}
        </div>
        ${hasCustom ? `<div class="custom-addr-current">${custom.custom_address}</div>` : ''}
        <div class="custom-addr-row">
          <input id="custom-addr-input" class="custom-addr-input"
                 placeholder="輸入實際地址…"
                 value="${hasCustom ? custom.custom_address.replace(/"/g, '&quot;') : ''}">
          <button id="custom-addr-btn" class="btn-sm btn-sm-primary"
                  onclick="APP.geocodeAndSaveCustomAddress(${c.id})">更新座標</button>
        </div>
        ${hasCustom ? `<div class="custom-addr-note">✅ 座標已更新（${custom.updated_at}）</div>` : ''}
      </div>`;

    // CRM: status + notes
    const crm  = this.crm[this.getCompanyKey(c)] || {};
    const si   = crm.status ? STATUS_INFO[crm.status] : null;
    const statusRow = `
      <div class="crm-status-row">
        <span class="crm-label">拜訪狀態</span>
        <div class="crm-status-btns">
          ${STATUS_LIST.map(s => {
            const info = STATUS_INFO[s];
            const active = crm.status === s;
            return `<button class="crm-status-pick${active ? ' active' : ''}"
              style="${active ? `background:${info.color};border-color:${info.color};color:white` : `border-color:${info.color};color:${info.color}`}"
              onclick="APP.setStatus(${c.id},'${s}')">${info.icon} ${info.label}</button>`;
          }).join('')}
          ${crm.status ? `<button class="crm-status-pick crm-clear" onclick="APP.setStatus(${c.id},null)">✕ 清除</button>` : ''}
        </div>
      </div>`;

    const notesList = (crm.notes || []).slice().reverse().map(n => `
      <div class="note-item">
        <span class="note-time">${n.time}</span>
        <p class="note-text">${n.text.replace(/\n/g, '<br>')}</p>
      </div>`).join('') || `<p class="no-notes">尚無備註</p>`;

    const notesSection = `
      <div class="crm-notes-section">
        <div class="crm-label" style="margin-bottom:8px">拜訪備註</div>
        <div class="notes-list">${notesList}</div>
        <textarea id="note-input" class="note-input" rows="3" placeholder="新增備註…"></textarea>
        <button class="btn-sm btn-sm-primary" style="margin-top:6px;width:100%"
                onclick="APP.addNote(${c.id})">📝 新增備註（自動加時間戳記）</button>
      </div>`;

    document.getElementById('detail-content').innerHTML = `
      <div class="detail-company-name">${c.name}</div>
      <div class="detail-short">${[c.short_name, c.english_name].filter(Boolean).join(' · ')}</div>
      <div class="detail-tags">${tags}</div>
      ${statusRow}
      <div class="detail-grid">
        <div class="detail-item"><label>統一編號</label><span>${c.tax_id || '–'}</span></div>
        <div class="detail-item"><label>股票代號</label><span>${c.stock_code || '–'}</span></div>
        <div class="detail-item"><label>資本額</label><span>${capital}</span></div>
        <div class="detail-item"><label>年營收</label><span>${rev}</span></div>
        <div class="detail-item"><label>員工人數</label><span>${emp}</span></div>
        <div class="detail-item"><label>縣市</label><span>${c.city || '–'}${c.district ? ' ' + c.district : ''}</span></div>
        <div class="detail-item full"><label>系統地址</label><span>${c.address || '–'}</span></div>
        <div class="detail-item"><label>電話</label><span>${c.phone || '–'}</span></div>
        <div class="detail-item"><label>網站</label><span>${c.website ? `<a href="${c.website}" target="_blank" rel="noopener">${c.website.replace(/^https?:\/\//, '')}</a>` : '–'}</span></div>
      </div>
      ${customSection}
      ${notesSection}
      <div class="detail-actions">
        <a href="${mapUrl}" target="_blank" rel="noopener" class="btn-secondary" style="text-decoration:none;display:inline-block">🗺 OpenStreetMap</a>
        <a href="${gMapUrl}" target="_blank" rel="noopener" class="btn-secondary" style="text-decoration:none;display:inline-block">📍 Google Maps</a>
        <button class="btn-primary" onclick="APP.addToRoute(${c.id});document.getElementById('detail-modal').style.display='none'">
          ${inRoute ? '✓ 已在行程中' : '+ 加入今日行程'}
        </button>
      </div>`;

    document.getElementById('detail-modal').style.display = 'flex';
    if (displayCoords.lat && displayCoords.lng) panTo(displayCoords.lat, displayCoords.lng, 15);
  },

  // ── Route Planning ─────────────────────────────────────────────────────
  addToRoute(id) {
    const c = this.getCompanyById(id);
    if (!c) return;
    if (this.route.some(r => r.id === id)) {
      this.notify(`${c.short_name || c.name} 已在行程中`, 'info');
      return;
    }
    this.route.push(c);
    if (this.autoSort) this.nearestNeighborSort();
    this.renderRoute();
    this.renderCompanyList();
    this.notify(`已加入：${c.short_name || c.name}，共 ${this.route.length} 站`, 'success');
  },

  addToRouteById(id) { this.addToRoute(id); },

  removeFromRoute(id) {
    this.route = this.route.filter(r => r.id !== id);
    this.renderRoute();
    this.renderCompanyList();
    if (!this.route.length) {
      clearRouteLine();
      clearStartMarker();
      exitRouteMode(this.filtered);
    } else {
      highlightRouteMarkers(this.route);
    }
  },

  clearRoute() {
    this.route = [];
    this.startLocation = null;
    this.endLocation = null;
    this.autoSort = true;
    document.getElementById('start-address').value = '';
    document.getElementById('end-address').value = '';
    document.getElementById('end-same-as-start').checked = true;
    document.getElementById('end-address').disabled = true;
    this.endSameAsStart = true;
    clearRouteLine();
    clearStartMarker();
    exitRouteMode(this.filtered); // restores all markers + clears end marker
    this.renderRoute();
    this.renderCompanyList();
  },

  // Nearest-neighbour greedy sort to minimise total travel distance
  nearestNeighborSort() {
    const withCoord    = this.route.filter(c => { const p = this.getCompanyCoords(c); return p.lat && p.lng; });
    const withoutCoord = this.route.filter(c => { const p = this.getCompanyCoords(c); return !p.lat || !p.lng; });
    if (withCoord.length <= 1) return;

    const origin = this.startLocation || { lat: 23.8, lng: 121.0 };
    const remaining = [...withCoord];
    const sorted = [];
    let cur = origin;

    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      remaining.forEach((stop, i) => {
        const d = haversine(cur, this.getCompanyCoords(stop));
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      });
      sorted.push(remaining[nearestIdx]);
      cur = this.getCompanyCoords(remaining[nearestIdx]);
      remaining.splice(nearestIdx, 1);
    }
    this.route = [...sorted, ...withoutCoord];
  },

  toggleAutoSort() {
    this.autoSort = !this.autoSort;
    if (this.autoSort) {
      this.nearestNeighborSort();
      this.renderRoute();
      this.renderCompanyList();
      highlightRouteMarkers(this.route);
    } else {
      this.renderRoute(); // re-render to show drag handles
    }
  },

  renderRoute() {
    const el = document.getElementById('route-list');
    const count = this.route.length;
    document.getElementById('route-count').textContent = count;
    document.getElementById('route-actions').style.display = count ? 'flex' : 'none';
    document.getElementById('route-summary').style.display = 'none';
    document.getElementById('route-endpoint-section').style.display = count ? 'block' : 'none';

    if (!count) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">🗺</div><p>尚無行程<br>從搜尋結果點選「+ 行程」加入拜訪對象</p></div>`;
      return;
    }

    const sortBtnLabel = this.autoSort
      ? '🔀 依距離排序 ✓'
      : '✋ 手動排序';
    const sortBtnClass = this.autoSort ? 'on' : 'off';
    const sortHint = this.autoSort
      ? `${count} 站（已依距離最佳化）`
      : `${count} 站（手動排序）`;

    el.innerHTML = `
      <div class="route-sort-bar">
        <span>${sortHint}</span>
        <button class="sort-toggle-btn ${sortBtnClass}" onclick="APP.toggleAutoSort()">${sortBtnLabel}</button>
      </div>
      ${this.route.map((c, i) => `
      <div class="route-item" draggable="${!this.autoSort}" data-id="${c.id}" data-idx="${i}">
        <span class="route-drag-handle" style="visibility:${this.autoSort ? 'hidden' : 'visible'}" title="拖曳排序">⠿</span>
        <span class="route-number">${i + 1}</span>
        <div class="route-item-info">
          <div class="route-company-name">${c.short_name || c.name}</div>
          <div class="route-company-city">${c.city || ''}　${(c.tags || []).slice(0, 2).join(' · ')}</div>
        </div>
        <button class="route-item-remove" title="移除" onclick="APP.removeFromRoute(${c.id})">×</button>
      </div>`).join('')}`;

    // Drag-to-reorder (only when autoSort is OFF)
    if (!this.autoSort) {
      let dragIdx = null;
      el.querySelectorAll('.route-item').forEach(item => {
        item.addEventListener('dragstart', e => {
          dragIdx = +item.dataset.idx;
          item.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragend', () => item.classList.remove('dragging'));
        item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('drag-over'); });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', e => {
          e.preventDefault();
          item.classList.remove('drag-over');
          const dropIdx = +item.dataset.idx;
          if (dragIdx !== null && dragIdx !== dropIdx) {
            const [moved] = this.route.splice(dragIdx, 1);
            this.route.splice(dropIdx, 0, moved);
            dragIdx = null;
            this.renderRoute();
            this.renderCompanyList();
            highlightRouteMarkers(this.route);
          }
        });
      });
    }

    highlightRouteMarkers(this.route);
  },

  async calcRoute() {
    const btn = document.getElementById('calc-route-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> 計算中...';

    try {
      let waypoints = [];

      // ── 起點 ──
      if (!this.startLocation) {
        const addrInput = document.getElementById('start-address').value.trim();
        if (addrInput) {
          this.notify('正在定位起點…', 'info');
          const geo = await geocodeAddress(addrInput);
          if (geo) {
            this.startLocation = geo;
            setStartMarker(geo.lat, geo.lng, addrInput);
          } else {
            this.notify('無法定位起點地址', 'error');
          }
        }
      }
      if (this.startLocation) waypoints.push(this.startLocation);

      // ── 拜訪站 ──（優先使用自訂座標）
      this.route.forEach(c => {
        const coords = this.getCompanyCoords(c);
        if (!coords.lat || !coords.lng) {
          this.notify(`「${c.short_name || c.name}」無有效座標，已略過`, 'error');
          return;
        }
        waypoints.push({ lat: coords.lat, lng: coords.lng, name: c.short_name || c.name });
      });

      // ── 終點 ──
      if (this.endSameAsStart) {
        // Return to start only if we have a start location
        if (this.startLocation) waypoints.push(this.startLocation);
      } else {
        if (!this.endLocation) {
          const endInput = document.getElementById('end-address').value.trim();
          if (endInput) {
            this.notify('正在定位終點…', 'info');
            const geo = await geocodeAddress(endInput);
            if (geo) {
              this.endLocation = geo;
            } else {
              this.notify('無法定位終點地址', 'error');
            }
          }
        }
        if (this.endLocation) waypoints.push(this.endLocation);
      }

      if (waypoints.length < 2) {
        this.notify('至少需要 2 個地點才能計算路線', 'error');
        return;
      }

      const result = await calculateRoute(waypoints);
      this.showRouteSummary(result, waypoints);
    } finally {
      btn.disabled = false;
      btn.textContent = '🚗 計算行車路線';
    }
  },

  showRouteSummary(result, waypoints) {
    if (!result) { this.notify('路線計算失敗', 'error'); return; }

    drawRouteLine(result.geometry);
    fitBounds(waypoints.map(wp => [wp.lat, wp.lng]));

    // Show only route-relevant markers
    showRouteOnlyMarkers(this.route);

    // End marker — only if end ≠ start
    if (!this.endSameAsStart && this.endLocation) {
      const endLabel = document.getElementById('end-address').value.trim() || '終點';
      setEndMarker(this.endLocation.lat, this.endLocation.lng, endLabel);
    } else {
      clearEndMarker();
    }

    document.getElementById('total-distance').textContent = formatDistance(result.distance);
    document.getElementById('total-duration').textContent = formatDuration(result.duration);
    document.getElementById('route-source-note').textContent =
      result.source === 'fallback' ? '⚠ 使用直線距離估算（路線API暫不可用）' : '✓ 實際道路路線';
    document.getElementById('route-summary').style.display = 'block';

    // Google Maps button
    document.getElementById('open-gmaps').onclick = () => {
      const url = buildGoogleMapsUrl(waypoints);
      if (url) window.open(url, '_blank', 'noopener');
    };

    this.notify('路線計算完成！', 'success');
  },

  // ── GPS ────────────────────────────────────────────────────────────────
  useGPS() {
    if (!navigator.geolocation) { this.notify('此瀏覽器不支援定位', 'error'); return; }
    this.notify('正在取得目前位置…', 'info');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        this.startLocation = { lat, lng };
        setStartMarker(lat, lng, '目前位置');
        document.getElementById('start-address').value = '目前位置';
        panTo(lat, lng, 13);
        if (this.autoSort && this.route.length > 1) {
          this.nearestNeighborSort();
          this.renderRoute();
          this.renderCompanyList();
          highlightRouteMarkers(this.route);
        }
        this.notify('已設定目前位置為起點', 'success');
      },
      err => this.notify('無法取得位置：' + err.message, 'error'),
      { timeout: 10000 }
    );
  },

  // ── Import CSV ─────────────────────────────────────────────────────────
  openImport() { document.getElementById('import-modal').style.display = 'flex'; },

  handleFile(file) {
    if (!file || !file.name.endsWith('.csv')) { this.notify('請選擇 CSV 檔案', 'error'); return; }
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: result => {
        this.pendingImportData = result.data;
        this.showImportPreview(result.data);
      },
      error: e => this.notify('CSV 解析失敗：' + e.message, 'error'),
    });
  },

  showImportPreview(rows) {
    const preview = document.getElementById('import-preview');
    const table = document.getElementById('preview-table');
    if (!rows.length) { this.notify('CSV 沒有資料', 'error'); return; }
    const headers = Object.keys(rows[0]);
    const sample = rows.slice(0, 5);
    table.innerHTML = `<table>
      <tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>
      ${sample.map(r => `<tr>${headers.map(h => `<td>${r[h] || ''}</td>`).join('')}</tr>`).join('')}
    </table>`;
    preview.style.display = 'block';
    this.notify(`已讀取 ${rows.length} 筆資料，請確認後匯入`, 'info');
  },

  confirmImport() {
    if (!this.pendingImportData) return;
    const mode = document.querySelector('input[name="import-mode"]:checked').value;
    const incoming = this.pendingImportData.map(r => ({
      id: +r.id || Date.now() + Math.random(),
      rank: +r.rank || null,
      name: r.name || '',
      short_name: r.short_name || r.name || '',
      english_name: r.english_name || '',
      tax_id: r.tax_id || '',
      capital: +r.capital || 0,
      city: r.city || '',
      district: r.district || '',
      address: r.address || '',
      lat: +r.lat || null,
      lng: +r.lng || null,
      phone: r.phone || '',
      website: r.website || '',
      employees: +r.employees || 0,
      revenue_100m: +r.revenue_100m || 0,
      industry: r.industry || '',
      tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      stock_code: r.stock_code || '',
      listed: r.listed === 'true' || r.listed === '1',
      notes: r.notes || '',
    }));

    if (mode === 'replace') {
      this.companies = incoming;
    } else {
      // Merge by tax_id
      incoming.forEach(c => {
        const idx = this.companies.findIndex(e => e.tax_id && e.tax_id === c.tax_id);
        if (idx >= 0) this.companies[idx] = c;
        else this.companies.push(c);
      });
    }

    this.buildFuse();
    this.renderTagFilters();
    this.applySearch();
    document.getElementById('import-modal').style.display = 'none';
    this.pendingImportData = null;
    document.getElementById('import-preview').style.display = 'none';
    this.notify(`成功匯入 ${incoming.length} 筆公司資料`, 'success');
  },

  // ── Export CSV ─────────────────────────────────────────────────────────
  exportCSV() {
    const rows = this.companies.map(c => {
      const key    = this.getCompanyKey(c);
      const custom = this.customAddresses[key] || {};
      const crm    = this.crm[key] || {};
      const notesText = (crm.notes || [])
        .map(n => `[${n.time}] ${n.text}`).join('\n');
      return {
        id: c.id, rank: c.rank, name: c.name, short_name: c.short_name,
        english_name: c.english_name, tax_id: c.tax_id, capital: c.capital,
        city: c.city, district: c.district, address: c.address,
        lat: c.lat, lng: c.lng, phone: c.phone, website: c.website,
        employees: c.employees, revenue_100m: c.revenue_100m,
        industry: c.industry, tags: (c.tags || []).join(','),
        stock_code: c.stock_code, listed: c.listed, notes: c.notes,
        custom_address: custom.custom_address || '',
        custom_lat:     custom.custom_lat || '',
        custom_lng:     custom.custom_lng || '',
        status:         crm.status     ? STATUS_INFO[crm.status].label : '',
        last_visit:     crm.last_visit || '',
        visit_notes:    notesText,
      };
    });
    const csv = Papa.unparse(rows);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `taiwan_companies_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    this.notify(`已匯出 ${rows.length} 筆資料`, 'success');
  },

  // ── Helpers ────────────────────────────────────────────────────────────
  getCompanyById(id) { return this.companies.find(c => c.id === id) || null; },

  // ── Custom Address ─────────────────────────────────────────────────────
  // localStorage key per company (prefer tax_id)
  getCompanyKey(c) { return c.tax_id || `__id_${c.id}`; },

  // Returns the effective {lat,lng} — custom first, then system
  getCompanyCoords(c) {
    const custom = this.customAddresses[this.getCompanyKey(c)];
    if (custom && custom.custom_lat && custom.custom_lng)
      return { lat: custom.custom_lat, lng: custom.custom_lng };
    return { lat: c.lat, lng: c.lng };
  },

  loadCustomAddresses() {
    try {
      const raw = localStorage.getItem('msm_map_custom_addresses');
      this.customAddresses = raw ? JSON.parse(raw) : {};
    } catch (e) { this.customAddresses = {}; }
  },

  _saveCustomStore() {
    localStorage.setItem('msm_map_custom_addresses', JSON.stringify(this.customAddresses));
  },

  // ── CRM ────────────────────────────────────────────────────────────────
  loadCRM() {
    try {
      const raw = localStorage.getItem('msm_map_crm');
      this.crm = raw ? JSON.parse(raw) : {};
    } catch (e) { this.crm = {}; }
  },

  _saveCRM() { localStorage.setItem('msm_map_crm', JSON.stringify(this.crm)); },

  loadSettings() {
    try {
      const raw = localStorage.getItem('msm_map_settings');
      if (raw) Object.assign(this.settings, JSON.parse(raw));
    } catch (e) {}
    const el = document.getElementById('reminder-days');
    if (el) el.value = this.settings.reminderDays;
  },

  saveSettings() {
    const days = parseInt(document.getElementById('reminder-days').value, 10);
    if (days > 0) {
      this.settings.reminderDays = days;
      localStorage.setItem('msm_map_settings', JSON.stringify(this.settings));
      this.renderCompanyList();
      this.notify('設定已儲存', 'success');
    }
  },

  // Returns the effective marker color: status > industry
  getMarkerColor(c) {
    const crm = this.crm[this.getCompanyKey(c)];
    if (crm && crm.status && STATUS_INFO[crm.status])
      return STATUS_INFO[crm.status].color;
    return industryColor(c.industry);
  },

  cycleStatus(id) {
    const c   = this.getCompanyById(id);
    if (!c) return;
    const key = this.getCompanyKey(c);
    if (!this.crm[key]) this.crm[key] = {};
    const cur = this.crm[key].status;
    const idx = STATUS_LIST.indexOf(cur);
    this.crm[key].status = STATUS_LIST[(idx + 1) % STATUS_LIST.length];
    this._saveCRM();
    this._refreshCRMViews(id);
  },

  setStatus(id, status) {
    const c = this.getCompanyById(id);
    if (!c) return;
    const key = this.getCompanyKey(c);
    if (!this.crm[key]) this.crm[key] = {};
    if (status) this.crm[key].status = status;
    else delete this.crm[key].status;
    this._saveCRM();
    this._refreshCRMViews(id);
  },

  // Re-render all views that show CRM data
  _refreshCRMViews(id) {
    const c = id ? this.getCompanyById(id) : null;
    if (id && document.getElementById('detail-modal').style.display !== 'none') this.showDetail(id);
    this.renderCompanyList();
    refreshMarkers(this.filtered);
    if (id && this.route.some(r => r.id === id)) highlightRouteMarkers(this.route);
    this._updateCRMCount();
    if (document.getElementById('tab-crm')?.classList.contains('active')) this.renderCRMOverview();
  },

  _updateCRMCount() {
    const n = this.companies.filter(c => {
      const key = this.getCompanyKey(c);
      return this.crm[key] || this.customAddresses[key];
    }).length;
    const el = document.getElementById('crm-count');
    if (el) el.textContent = n;
  },

  addNote(id, textOverride) {
    const c    = this.getCompanyById(id);
    if (!c) return;
    const ta   = textOverride == null ? document.getElementById('note-input') : null;
    const text = textOverride != null ? textOverride.trim()
                                      : (ta && ta.value || '').trim();
    if (!text) { this.notify('請輸入備註內容', 'error'); return; }
    const key  = this.getCompanyKey(c);
    if (!this.crm[key]) this.crm[key] = {};
    if (!this.crm[key].notes) this.crm[key].notes = [];
    const now  = new Date();
    const time = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    this.crm[key].notes.push({ text, time });
    this.crm[key].last_visit = time;
    this._saveCRM();
    this.notify('備註已儲存', 'success');
    this._refreshCRMViews(id);
  },

  // Returns true if last note older than reminderDays
  isOverdueVisit(c) {
    const crm = this.crm[this.getCompanyKey(c)];
    if (!crm || !crm.last_visit) return false;
    const last = new Date(crm.last_visit.replace(/\//g, '-').replace(' ', 'T'));
    const diffDays = (Date.now() - last.getTime()) / 86400000;
    return diffDays > this.settings.reminderDays;
  },

  clearCustomAddress(id) {
    const c = this.getCompanyById(id);
    if (!c) return;
    delete this.customAddresses[this.getCompanyKey(c)];
    this._saveCustomStore();
    this.showDetail(id);
    refreshMarkers(this.filtered);
    this.notify('已恢復系統地址', 'info');
  },

  async geocodeAndSaveCustomAddress(id) {
    const c = this.getCompanyById(id);
    if (!c) return;
    const input = document.getElementById('custom-addr-input');
    const address = (input && input.value || '').trim();
    if (!address) { this.notify('請輸入地址', 'error'); return; }

    const btn = document.getElementById('custom-addr-btn');
    if (btn) { btn.disabled = true; btn.textContent = '定位中…'; }

    const geo = await geocodeAddress(address);

    if (btn) { btn.disabled = false; btn.textContent = '更新座標'; }

    if (!geo) { this.notify('無法定位此地址，請修正後再試', 'error'); return; }

    const key = this.getCompanyKey(c);
    this.customAddresses[key] = {
      custom_address: address,
      custom_lat:  parseFloat(geo.lat.toFixed(6)),
      custom_lng:  parseFloat(geo.lng.toFixed(6)),
      updated_at:  new Date().toISOString().slice(0, 10),
    };
    this._saveCustomStore();
    this.notify(`已更新「${c.short_name || c.name}」的拜訪座標`, 'success');
    this.showDetail(id);                            // re-render detail panel
    refreshMarkers(this.filtered);                  // redraw map markers
    if (this.route.some(r => r.id === id)) highlightRouteMarkers(this.route);
  },

  onMarkerClick(id) {
    this.selectCard(id);
    // Scroll card into view
    const card = document.querySelector(`.company-card[data-id="${id}"]`);
    if (card) {
      this.switchTab('results');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      card.classList.add('selected');
    }
  },

  switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
    if (tab === 'crm') this.renderCRMOverview();
  },

  // ── CRM Overview ───────────────────────────────────────────────────────
  getCRMCompanies() {
    // Companies that have any CRM data or custom address
    let list = this.companies.filter(c => {
      const key = this.getCompanyKey(c);
      return this.crm[key] || this.customAddresses[key];
    });

    // Search filter
    const q = this.crmOverviewSearch.trim().toLowerCase();
    if (q) list = list.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.short_name || '').toLowerCase().includes(q)
    );

    // Status filter
    if (this.crmOverviewFilter !== 'all') {
      list = list.filter(c => {
        const crm = this.crm[this.getCompanyKey(c)];
        return crm && crm.status === this.crmOverviewFilter;
      });
    }

    // Sort: never visited first, then oldest last_visit first
    list.sort((a, b) => {
      const av = this.crm[this.getCompanyKey(a)]?.last_visit || '';
      const bv = this.crm[this.getCompanyKey(b)]?.last_visit || '';
      if (!av && !bv) return 0;
      if (!av) return -1;
      if (!bv) return 1;
      return av.localeCompare(bv);
    });
    return list;
  },

  crmRowHtml(c) {
    const key      = this.getCompanyKey(c);
    const crm      = this.crm[key] || {};
    const si       = crm.status ? STATUS_INFO[crm.status] : null;
    const overdue  = this.isOverdueVisit(c);
    const notes    = crm.notes || [];
    const lastNote = notes[notes.length - 1];
    const preview  = lastNote
      ? lastNote.text.slice(0, 30) + (lastNote.text.length > 30 ? '…' : '')
      : '';
    const lastVisit = crm.last_visit ? crm.last_visit.slice(0, 10) : '–';
    const expanded  = this.crmExpandedIds.has(c.id);
    const inRoute   = this.route.some(r => r.id === c.id);

    const statusBtns = STATUS_LIST.map(s => {
      const info   = STATUS_INFO[s];
      const active = crm.status === s;
      return `<button class="crm-sp${active ? ' active' : ''}"
        data-action="status" data-id="${c.id}" data-status="${s}"
        style="${active
          ? `background:${info.color};border-color:${info.color};color:white`
          : `border-color:${info.color};color:${info.color}`
        }" title="${info.label}">${info.icon}</button>`;
    }).join('') + (crm.status
      ? `<button class="crm-sp crm-sp-clear" data-action="status" data-id="${c.id}" data-status="" title="清除狀態">✕</button>`
      : '');

    const notesHtml = notes.length
      ? notes.slice().reverse().map(n => `
          <div class="note-item">
            <span class="note-time">${n.time}</span>
            <p class="note-text">${n.text.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</p>
          </div>`).join('')
      : '<p class="no-notes">尚無備註</p>';

    return `
      <div class="crm-row${overdue ? ' crm-overdue' : ''}${expanded ? ' crm-expanded' : ''}" data-id="${c.id}">
        <div class="crm-row-top">
          <span class="crm-status-icon">${si ? `<span style="color:${si.color}">${si.icon}</span>` : '⬜'}</span>
          <span class="crm-row-name">${c.short_name || c.name}</span>
          <span class="crm-row-city">${c.city || ''}</span>
          ${overdue ? '<span class="crm-warn" title="超過提醒天數未拜訪">⚠️</span>' : ''}
        </div>
        <div class="crm-row-meta">
          <span>📅 ${lastVisit}</span>
          ${preview ? `<span class="crm-preview" title="${lastNote.text.replace(/"/g,'&quot;')}">${preview}</span>` : ''}
        </div>
        <div class="crm-row-actions">
          <div class="crm-sp-group">${statusBtns}</div>
          <button class="btn-sm ${inRoute ? 'btn-sm-danger' : 'btn-sm-primary'} crm-btn-route"
                  data-action="route" data-id="${c.id}">${inRoute ? '✓ 行程' : '+ 行程'}</button>
          <button class="btn-sm btn-sm-outline crm-btn-expand"
                  data-action="expand" data-id="${c.id}">${expanded ? '▲' : '▼'} 備註${notes.length ? `(${notes.length})` : ''}</button>
        </div>
        <div class="crm-row-notes" style="display:${expanded ? 'block' : 'none'}">
          ${notesHtml}
          <div class="crm-add-note-row">
            <textarea class="note-input crm-note-ta" data-id="${c.id}" rows="2" placeholder="新增備註…"></textarea>
            <button class="btn-sm btn-sm-primary crm-btn-note" data-action="note" data-id="${c.id}" style="margin-top:4px;width:100%">📝 新增備註</button>
          </div>
        </div>
      </div>`;
  },

  renderCRMOverview() {
    const el = document.getElementById('crm-list');
    if (!el) return;

    // Sync filter button states
    document.querySelectorAll('.crm-filter-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.filter === this.crmOverviewFilter)
    );

    const companies = this.getCRMCompanies();
    this._updateCRMCount();

    if (!companies.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>尚無客戶記錄<br>在公司詳情設定狀態或新增備註後<br>會出現在此</p></div>`;
      return;
    }

    el.innerHTML = companies.map(c => this.crmRowHtml(c)).join('');

    // Single delegated listener
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      const id     = +btn.dataset.id;
      const action = btn.dataset.action;

      if (action === 'status') {
        this.setStatus(id, btn.dataset.status || null);
      } else if (action === 'route') {
        this.addToRoute(id);
        this.renderCRMOverview();
      } else if (action === 'expand') {
        if (this.crmExpandedIds.has(id)) this.crmExpandedIds.delete(id);
        else this.crmExpandedIds.add(id);
        this.renderCRMOverview();
      } else if (action === 'note') {
        const ta = el.querySelector(`.crm-note-ta[data-id="${id}"]`);
        if (ta) this.addNote(id, ta.value);
      }
    }, { once: true });
  },

  notify(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `notification ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  },

  // ── Event Listeners ────────────────────────────────────────────────────
  setupListeners() {
    // Search
    const input = document.getElementById('search-input');
    input.addEventListener('input', e => {
      this.searchQuery = e.target.value;
      this.applySearch();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.applySearch();
      if (e.key === 'Escape') { input.value = ''; this.searchQuery = ''; this.applySearch(); }
    });
    document.getElementById('search-clear').addEventListener('click', () => {
      input.value = ''; this.searchQuery = ''; this.applySearch(); input.focus();
    });

    // Filters
    document.getElementById('filter-toggle').addEventListener('click', () => {
      const body = document.getElementById('filter-body');
      const icon = document.querySelector('.toggle-icon');
      body.style.display = body.style.display === 'none' ? '' : 'none';
      icon.classList.toggle('rotated');
    });
    document.getElementById('clear-filters').addEventListener('click', () => this.clearFilters());

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // CRM overview: search + filter
    document.getElementById('crm-search').addEventListener('input', e => {
      this.crmOverviewSearch = e.target.value;
      this.renderCRMOverview();
    });
    document.querySelectorAll('.crm-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.crmOverviewFilter = btn.dataset.filter;
        this.renderCRMOverview();
      });
    });

    // Route controls
    document.getElementById('calc-route-btn').addEventListener('click', () => this.calcRoute());
    document.getElementById('clear-route-btn').addEventListener('click', () => this.clearRoute());
    document.getElementById('use-gps').addEventListener('click', () => this.useGPS());

    // Start address: clear cached coords on change; re-sort when GPS is set
    document.getElementById('start-address').addEventListener('input', () => {
      this.startLocation = null;
      clearStartMarker();
    });

    // End point: "同起點" checkbox
    document.getElementById('end-same-as-start').addEventListener('change', e => {
      this.endSameAsStart = e.target.checked;
      const endInput = document.getElementById('end-address');
      endInput.disabled = this.endSameAsStart;
      if (this.endSameAsStart) {
        endInput.value = '';
        this.endLocation = null;
        clearEndMarker();
      }
    });

    // End address: clear cached coords on change
    document.getElementById('end-address').addEventListener('input', () => {
      this.endLocation = null;
      clearEndMarker();
    });

    // GPS for end point
    document.getElementById('use-gps-end').addEventListener('click', () => {
      if (!navigator.geolocation) { this.notify('此瀏覽器不支援定位', 'error'); return; }
      this.notify('正在取得目前位置…', 'info');
      navigator.geolocation.getCurrentPosition(
        pos => {
          const { latitude: lat, longitude: lng } = pos.coords;
          this.endLocation = { lat, lng };
          document.getElementById('end-same-as-start').checked = false;
          this.endSameAsStart = false;
          document.getElementById('end-address').disabled = false;
          document.getElementById('end-address').value = '目前位置';
          this.notify('已設定目前位置為終點', 'success');
        },
        err => this.notify('無法取得位置：' + err.message, 'error'),
        { timeout: 10000 }
      );
    });

    // Settings modal
    document.getElementById('settings-btn').addEventListener('click', () => {
      document.getElementById('reminder-days').value = this.settings.reminderDays;
      document.getElementById('settings-modal').style.display = 'flex';
    });
    document.getElementById('settings-close').addEventListener('click', () => {
      document.getElementById('settings-modal').style.display = 'none';
    });
    document.getElementById('reminder-days').addEventListener('change', () => this.saveSettings());

    // Import / Export
    document.getElementById('import-btn').addEventListener('click', () => this.openImport());
    document.getElementById('export-btn').addEventListener('click', () => this.exportCSV());

    // Import modal
    document.getElementById('import-close').addEventListener('click', () => {
      document.getElementById('import-modal').style.display = 'none';
    });
    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', e => this.handleFile(e.target.files[0]));
    const dropZone = document.getElementById('drop-zone');
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('dragover');
      this.handleFile(e.dataTransfer.files[0]);
    });
    document.getElementById('confirm-import').addEventListener('click', () => this.confirmImport());

    // Detail modal
    document.getElementById('detail-close').addEventListener('click', () => {
      document.getElementById('detail-modal').style.display = 'none';
    });
    document.querySelectorAll('.modal-overlay').forEach(el => {
      el.addEventListener('click', e => { if (e.target === el) el.style.display = 'none'; });
    });

    // Map controls
    document.getElementById('fit-all-btn').addEventListener('click', () => fitAll());
    document.getElementById('fit-route-btn').addEventListener('click', () => {
      if (this.route.length) fitBounds(this.route.map(c => [c.lat, c.lng]));
    });

    // Show/hide fit-route button based on route
    const origRender = this.renderRoute.bind(this);
    this.renderRoute = () => {
      origRender();
      document.getElementById('fit-route-btn').style.display = this.route.length ? 'flex' : 'none';
    };
  },
};

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => APP.init());
