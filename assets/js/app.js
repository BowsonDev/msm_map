// ── Main Application ──────────────────────────────────────────────────────
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
  pendingImportData: null,

  // ── Bootstrap ──────────────────────────────────────────────────────────
  async init() {
    try { initMap(); } catch (e) { console.error('Map init failed:', e); }
    await this.loadData();
    this.buildFuse();
    this.renderTagFilters();
    this.applySearch();
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
    });
  },

  companyCardHtml(c) {
    const inRoute = this.route.some(r => r.id === c.id);
    const tags = (c.tags || []).slice(0, 3).map(t => `<span class="tag">${t}</span>`).join('');
    const rev = c.revenue_100m ? `${Number(c.revenue_100m).toLocaleString()} 億` : '';
    const emp = c.employees ? `${Number(c.employees).toLocaleString()} 人` : '';
    const routeBtn = inRoute
      ? `<button class="btn-sm btn-sm-danger btn-route-remove">✓ 已加入</button>`
      : `<button class="btn-sm btn-sm-primary btn-route-add">+ 行程</button>`;
    return `
      <div class="company-card${inRoute ? ' in-route' : ''}" data-id="${c.id}">
        <div class="card-header">
          ${c.rank ? `<span class="company-rank">#${c.rank}</span>` : ''}
          <span class="company-name">${c.short_name || c.name}</span>
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
    const mapUrl = `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}&zoom=16`;
    const gMapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address || c.name)}`;

    document.getElementById('detail-content').innerHTML = `
      <div class="detail-company-name">${c.name}</div>
      <div class="detail-short">${[c.short_name, c.english_name].filter(Boolean).join(' · ')}</div>
      <div class="detail-tags">${tags}</div>
      <div class="detail-grid">
        <div class="detail-item"><label>統一編號</label><span>${c.tax_id || '–'}</span></div>
        <div class="detail-item"><label>股票代號</label><span>${c.stock_code || '–'}</span></div>
        <div class="detail-item"><label>資本額</label><span>${capital}</span></div>
        <div class="detail-item"><label>年營收</label><span>${rev}</span></div>
        <div class="detail-item"><label>員工人數</label><span>${emp}</span></div>
        <div class="detail-item"><label>縣市</label><span>${c.city || '–'}${c.district ? ' ' + c.district : ''}</span></div>
        <div class="detail-item full"><label>地址</label><span>${c.address || '–'}</span></div>
        <div class="detail-item"><label>電話</label><span>${c.phone || '–'}</span></div>
        <div class="detail-item"><label>網站</label><span>${c.website ? `<a href="${c.website}" target="_blank" rel="noopener">${c.website.replace(/^https?:\/\//, '')}</a>` : '–'}</span></div>
        ${c.notes ? `<div class="detail-item full"><label>備註</label><span>${c.notes}</span></div>` : ''}
      </div>
      <div class="detail-actions">
        <a href="${mapUrl}" target="_blank" rel="noopener" class="btn-secondary" style="text-decoration:none;display:inline-block">🗺 OpenStreetMap</a>
        <a href="${gMapUrl}" target="_blank" rel="noopener" class="btn-secondary" style="text-decoration:none;display:inline-block">📍 Google Maps</a>
        <button class="btn-primary" onclick="APP.addToRoute(${c.id});document.getElementById('detail-modal').style.display='none'">
          ${inRoute ? '✓ 已在行程中' : '+ 加入今日行程'}
        </button>
      </div>`;

    document.getElementById('detail-modal').style.display = 'flex';
    panTo(c.lat, c.lng, 15);
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

    el.innerHTML = this.route.map((c, i) => `
      <div class="route-item" draggable="true" data-id="${c.id}" data-idx="${i}">
        <span class="route-drag-handle" title="拖曳排序">⠿</span>
        <span class="route-number">${i + 1}</span>
        <div class="route-item-info">
          <div class="route-company-name">${c.short_name || c.name}</div>
          <div class="route-company-city">${c.city || ''}　${(c.tags || []).slice(0, 2).join(' · ')}</div>
        </div>
        <button class="route-item-remove" title="移除" onclick="APP.removeFromRoute(${c.id})">×</button>
      </div>`).join('');

    // Drag-to-reorder
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

      // ── 拜訪站 ──
      this.route.forEach(c => waypoints.push({ lat: c.lat, lng: c.lng, name: c.short_name || c.name }));

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
    const rows = this.companies.map(c => ({
      id: c.id, rank: c.rank, name: c.name, short_name: c.short_name,
      english_name: c.english_name, tax_id: c.tax_id, capital: c.capital,
      city: c.city, district: c.district, address: c.address,
      lat: c.lat, lng: c.lng, phone: c.phone, website: c.website,
      employees: c.employees, revenue_100m: c.revenue_100m,
      industry: c.industry, tags: (c.tags || []).join(','),
      stock_code: c.stock_code, listed: c.listed, notes: c.notes,
    }));
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

    // Route controls
    document.getElementById('calc-route-btn').addEventListener('click', () => this.calcRoute());
    document.getElementById('clear-route-btn').addEventListener('click', () => this.clearRoute());
    document.getElementById('use-gps').addEventListener('click', () => this.useGPS());

    // Start address: clear cached coords on change
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
