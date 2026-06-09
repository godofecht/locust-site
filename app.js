'use strict';

const POLL_MS = 500;
let lastOk = 0;
const $ = (id) => document.getElementById(id);

/* ---------------- projection: sim world coords -> lat/lon ---------------- */
proj4.defs('UTM31', '+proj=utm +zone=31 +ellps=WGS84 +datum=WGS84 +units=m +no_defs');
function toLatLon(x, y, geo) {
  if (!geo) return null;
  const cx = x + geo.map_origin[0], cy = y + geo.map_origin[1];
  const e = cx - geo.net_offset[0], n = cy - geo.net_offset[1];
  const ll = proj4('UTM31', 'WGS84', [e, n]); // [lon, lat]
  return [ll[1], ll[0]];
}

/* ---------------- Leaflet map ---------------- */
const map = L.map('map', { zoomControl: true, attributionControl: false, preferCanvas: false }).setView([52.2053, 0.1218], 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd', maxZoom: 19,
}).addTo(map);
// Dedicated panes so trajectories sit above polygons but below markers, and so the
// animated-flow CSS only touches trajectory SVG paths.
map.createPane('staticPane'); map.getPane('staticPane').style.zIndex = 380;
map.createPane('trajPane');   map.getPane('trajPane').style.zIndex = 410;
map.createPane('selPane');    map.getPane('selPane').style.zIndex = 420;

const staticLayer = L.layerGroup([], { pane: 'staticPane' }).addTo(map); // nofly + depots (built once)
const reqLayer = L.layerGroup([], { pane: 'staticPane' }).addTo(map);    // pickup dots + faint legs
let fitted = false, staticSig = '';

// Persistent, keyed dynamic objects so nothing is torn down each frame.
const droneMarkers = {}; // id -> circleMarker
const dronePaths = {};   // id -> polyline
const retrievalMarkers = {}; // id -> {marker, line} for aerial recovery drones
const reqDots = {};      // key -> {dot, leg}
const selHighlight = L.layerGroup([], { pane: 'selPane' }).addTo(map);

/* ---------------- geographic overlays: noise / connectivity / elevation ---------- */
let heatMode = 'none';
map.createPane('heatPane');
map.getPane('heatPane').style.zIndex = 370;
map.getPane('heatPane').style.pointerEvents = 'none';
let heatLayer = null;
function heatColor(mode, v) {
  if (mode === 'noise') return v <= 0.02 ? [0, 0, 0, 0] : [255, Math.round(180 * (1 - v)), 28, Math.round(80 + 175 * v)];
  if (mode === 'signal') return [Math.round(240 * (1 - v)), Math.round(215 * v), 70, 180];
  if (mode === 'elevation') return [Math.round(70 + 150 * v), Math.round(135 - 45 * v), Math.round(185 * (1 - v)), 170];
  return [0, 0, 0, 0];
}
function drawHeat() {
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  const d = lastData, f = d && d.fields;
  if (heatMode === 'none' || !f || !f.cols || !f.rows || !d.geo) return;
  const arr = f[heatMode];
  if (!arr || arr.length !== f.cols * f.rows) return;
  let lo = 0, hi = 1;
  if (heatMode === 'elevation') { lo = Math.min(...arr); hi = Math.max(...arr); }
  const canvas = document.createElement('canvas');
  canvas.width = f.cols;
  canvas.height = f.rows;
  const g = canvas.getContext('2d');
  const image = g.createImageData(f.cols, f.rows);
  for (let r = 0; r < f.rows; r++) {
    for (let c = 0; c < f.cols; c++) {
      let v = arr[r * f.cols + c];
      if (heatMode === 'elevation') v = (v - lo) / Math.max(1e-3, hi - lo);
      const rgba = heatColor(heatMode, Math.max(0, Math.min(1, v)));
      // Simulation rows run south-to-north; image rows run top-to-bottom.
      const dst = ((f.rows - 1 - r) * f.cols + c) * 4;
      image.data.set(rgba, dst);
    }
  }
  g.putImageData(image, 0, 0);
  const southWest = toLatLon(f.x0, f.y0, d.geo);
  const northEast = toLatLon(f.x0 + f.cols * f.cell, f.y0 + f.rows * f.cell, d.geo);
  heatLayer = L.imageOverlay(canvas.toDataURL('image/png'), L.latLngBounds(southWest, northEast), {
    pane: 'heatPane',
    opacity: heatMode === 'noise' ? 0.9 : 0.72,
    interactive: false,
    className: 'heat-image',
  }).addTo(map);
}
// Layer switcher control
const HeatCtl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'heat-ctl');
    const modes = [['none', 'Off'], ['noise', 'Noise'], ['signal', 'Signal'], ['elevation', 'Terrain']];
    div.innerHTML = '<span>Overlay</span>' + modes.map((m) => `<button data-m="${m[0]}"${m[0] === 'none' ? ' class="on"' : ''}>${m[1]}</button>`).join('');
    L.DomEvent.disableClickPropagation(div);
    div.querySelectorAll('button').forEach((b) => b.onclick = () => {
      heatMode = b.dataset.m;
      div.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      drawHeat();
    });
    return div;
  },
});
map.addControl(new HeatCtl());

/* ---------------- selection / navigation ---------------- */
// selected = { kind:'drone'|'order', id, focus:[lat,lon] | null }
let selected = null;
let lastData = null;

function droneById(d, id) { return (d.drones || []).find((x) => x.id === id); }

function clearSelection() { selected = null; refreshSelection(); renderLists(lastData); }

function selectDrone(id, fly) {
  selected = { kind: 'drone', id };
  const d = lastData, dr = d && droneById(d, id);
  if (dr && d.geo && fly) map.flyTo(toLatLon(dr.x, dr.y, d.geo), Math.max(map.getZoom(), 15), { duration: 0.6 });
  refreshSelection(); renderLists(d);
}
function selectOrder(key, droneId, focusXY, fly) {
  selected = { kind: 'order', id: key, drone: droneId || null };
  const d = lastData;
  if (d && d.geo && fly && focusXY) map.flyTo(toLatLon(focusXY[0], focusXY[1], d.geo), Math.max(map.getZoom(), 15), { duration: 0.6 });
  refreshSelection(); renderLists(d);
}

// The drone currently implicated by the selection (for cross-highlight).
function selectedDroneId() {
  if (!selected) return null;
  if (selected.kind === 'drone') return selected.id;
  if (selected.kind === 'order') return selected.drone;
  return null;
}

// Restyle drone markers/paths + draw the bright highlight for the selected drone.
function refreshSelection() {
  selHighlight.clearLayers();
  const selId = selectedDroneId();
  for (const id in dronePaths) {
    const sel = id === selId;
    dronePaths[id].setStyle({ opacity: sel ? 0.95 : 0.4, weight: sel ? 4 : 2, color: sel ? '#7ef9ec' : '#00ccbc' });
    const el = dronePaths[id].getElement && dronePaths[id].getElement();
    if (el) el.classList.toggle('sel', sel);
  }
  for (const id in droneMarkers) {
    const sel = id === selId;
    droneMarkers[id].setStyle({ radius: sel ? 7 : 5, weight: sel ? 2 : 1, color: sel ? '#7ef9ec' : '#fff' });
  }
  const d = lastData;
  if (selId && d && d.geo) {
    const dr = droneById(d, selId);
    if (dr) {
      const here = toLatLon(dr.x, dr.y, d.geo);
      L.circleMarker(here, { pane: 'selPane', radius: 13, color: '#7ef9ec', weight: 2, fill: false, className: 'sel-ring' }).addTo(selHighlight);
      if (dr.job) {
        const pk = toLatLon(dr.job.px, dr.job.py, d.geo), dp = toLatLon(dr.job.dx, dr.job.dy, d.geo);
        L.circleMarker(pk, { pane: 'selPane', radius: 5, color: '#f2b84b', fillColor: '#f2b84b', fillOpacity: 1, weight: 1 }).bindTooltip('Pickup · ' + esc(dr.job.pickup)).addTo(selHighlight);
        L.circleMarker(dp, { pane: 'selPane', radius: 5, color: '#46d493', fillColor: '#46d493', fillOpacity: 1, weight: 1 }).bindTooltip('Drop-off · ' + esc(dr.job.dropoff)).addTo(selHighlight);
      }
    }
  }
  renderInspector();
}
map.on('click', () => clearSelection());

/* ---------------- inspector: ALL the detail on whatever you click ---------- */
const irow = (k, v, cls) => `<div class="ir"><span class="ik">${k}</span><span class="iv ${cls || ''}">${v}</span></div>`;
const ibar = (k, pct, col) => `<div class="ir"><span class="ik">${k}</span><span class="iv">${Math.round(pct)}%</span></div><div class="ibar"><span style="width:${Math.max(0, Math.min(100, pct))}%;background:var(--${col})"></span></div>`;
const isec = (title, rows) => `<div class="isec"><div class="ist">${title}</div>${rows.filter(Boolean).join('')}</div>`;
function fmtT(s) { if (s == null || !isFinite(s)) return '—'; const neg = s < 0; s = Math.abs(Math.round(s)); const t = s < 90 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; return neg ? t + ' late' : t; }

function inspectDrone(d, dr) {
  const geo = d.geo, ll = geo ? toLatLon(dr.x, dr.y, geo) : null, j = dr.job;
  const soc = Math.round(dr.soc || 0), socCol = soc > 55 ? 'green' : soc > 25 ? 'amber' : 'red';
  let h = isec('Status', [
    irow('Model', esc(dr.model || '—')),
    irow('Phase', esc(dr.phase)),
    irow('Health', dr.fault ? '⚠ ' + esc(dr.fault) : 'nominal', dr.fault ? 'red' : 'green'),
    dr.signal_lost ? irow('Comms', 'SIGNAL LOST', 'red') : '',
    dr.rtl ? irow('Failsafe', 'returning to base', 'amber') : '',
    irow('Airspace', dr.exposed ? 'over open ground ⚠' : 'over safe corridor', dr.exposed ? 'amber' : 'green'),
  ]);
  h += isec('Battery &amp; energy', [
    ibar('State of charge', soc, socCol),
    irow('Terminal voltage', dr.terminal_v ? dr.terminal_v.toFixed(1) + ' V' : '—'),
    irow('Pack temp', dr.pack_temp_c != null ? dr.pack_temp_c.toFixed(1) + ' °C' : '—'),
    irow('Range remaining', dr.range_km != null ? dr.range_km.toFixed(1) + ' km' : '—'),
    irow('Energy used (trip)', dr.energy_wh != null ? Math.round(dr.energy_wh) + ' Wh' : '—'),
    irow('Pack capacity', dr.batt_wh ? Math.round(dr.batt_wh) + ' Wh' : '—'),
  ]);
  h += isec('Flight', [
    irow('Ground speed', (dr.speed || 0).toFixed(1) + ' m/s'),
    irow('Set cruise', (dr.set_speed || 0).toFixed(1) + ' m/s'),
    irow('Altitude', (dr.alt || 0).toFixed(0) + ' m'),
    irow('Payload', (dr.payload || 0).toFixed(2) + ' / ' + (dr.max_payload || 0).toFixed(1) + ' kg'),
    ll ? irow('Position', ll[0].toFixed(5) + ', ' + ll[1].toFixed(5)) : '',
  ]);
  if (j) h += isec('Current order', [
    irow('Item', esc(j.item || '—')),
    irow('Mission', esc((j.mission_type || j.type || 'delivery').replaceAll('_', ' → '))),
    irow('Route', esc(j.pickup) + ' → ' + esc(j.dropoff)),
    irow('Distance', (j.dist_km || 0).toFixed(2) + ' km'),
    irow('Price', '£' + (j.price || 0).toFixed(2) + ' (base £' + (j.base_fee || 0).toFixed(2) + ' + dist)'),
    irow('ETA to drop', fmtT(j.eta_drop_s)),
    irow('Promised in', fmtT(j.due_in_s)),
    irow('On track', j.on_track ? 'YES' : 'AT RISK', j.on_track ? 'green' : 'red'),
  ]);
  h += isec('Lifetime', [irow('Deliveries completed', dr.deliveries || 0)]);
  return h;
}
function inspectOrder(d, r) {
  const dist = Math.hypot(r.dx - r.px, r.dy - r.py) / 1000;
  const pr = d.pricing || {};
  const excessKg = Math.max(0, (r.weight_kg || 0) - (pr.included_weight_kg ?? 0.75));
  const price = r.price ?? ((pr.base_fee || 2.5) + (pr.per_km || 1.2) * dist
    + (pr.per_excess_kg || 0) * excessKg + (pr.liquid_per_kg || 0) * (r.liquid_kg || 0));
  const late = r.due_in_s < 0;
  return isec('Order', [
    irow('Item', esc(r.item || 'parcel')),
    irow('Class', esc(r.order_class || r.pickup_cat || 'parcel')),
    irow('Mission', esc((r.mission_type || r.type || 'delivery').replaceAll('_', ' → '))),
    irow('Weight', (r.weight_kg || 0).toFixed(2) + ' kg'),
    (r.liquid_kg || 0) > 0 ? irow('Liquid mass', r.liquid_kg.toFixed(2) + ' kg') : '',
    r.basket_value_gbp != null ? irow('Basket value', '£' + r.basket_value_gbp.toFixed(2)) : '',
    irow('Pickup', esc(r.pickup)),
    irow('Drop-off', esc(r.dropoff)),
    irow('Distance', dist.toFixed(2) + ' km'),
    irow('Quoted price', '£' + price.toFixed(2)),
  ]) + isec('Status', [
    irow('State', late ? 'LATE' : r.ready ? 'ready for pickup' : 'preparing', late ? 'red' : r.ready ? 'green' : 'amber'),
    irow('Waiting', Math.round(r.age_s || 0) + 's'),
    irow('Promised in', fmtT(r.due_in_s)),
    irow('Assigned drone', 'awaiting dispatch', 'amber'),
  ]);
}
function renderInspector() {
  const insp = $('inspector'), body = $('insp-body'), title = $('insp-title'), d = lastData;
  if (!selected || !d) { insp.hidden = true; return; }
  if (selected.kind === 'drone') {
    const dr = droneById(d, selected.id);
    if (!dr) { insp.hidden = true; return; }
    title.textContent = shortId(dr.id) + ' · ' + (dr.model || 'drone');
    body.innerHTML = inspectDrone(d, dr);
  } else if (selected.kind === 'order') {
    if (selected.drone) {
      const dr = droneById(d, selected.drone);
      if (!dr) { insp.hidden = true; return; }
      title.textContent = 'Order → ' + shortId(dr.id);
      body.innerHTML = inspectDrone(d, dr);
    } else {
      const r = (d.requests || []).find((x) => reqKey(x) === selected.id);
      if (!r) { insp.hidden = true; return; }
      title.textContent = 'Order · ' + esc(r.dropoff);
      body.innerHTML = inspectOrder(d, r);
    }
  }
  insp.hidden = false;
}
function closeInspector(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  selected = null;
  $('inspector').hidden = true;          // hide immediately, don't wait for a render pass
  refreshSelection();
  renderLists(lastData);
}
$('insp-close').addEventListener('click', closeInspector);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInspector(); });

/* ---------------- map rendering (persistent, no teardown) ---------------- */
function renderMap(d) {
  const geo = d.geo; if (!geo) return;

  // Static layer (no-fly + depots): build once, rebuild only if it actually changes.
  const sig = JSON.stringify([(d.nofly || []).map((z) => z.name), (d.depots || []).length]);
  if (sig !== staticSig) {
    staticSig = sig; staticLayer.clearLayers();
    for (const z of d.nofly || []) {
      if (!z.poly || z.poly.length < 3) continue;
      const ring = z.poly.map((p) => toLatLon(p[0], p[1], geo));
      L.polygon(ring, { pane: 'staticPane', color: '#f0625d', weight: 1.4, fillColor: '#f0625d', fillOpacity: 0.10, dashArray: '5 4', interactive: true })
        .bindTooltip(z.name + ' · NO-FLY', { sticky: true }).addTo(staticLayer);
    }
    (d.depots || []).forEach((dep, i) => {
      const ll = toLatLon(dep.x, dep.y, geo); const hub = i === 0;
      L.circleMarker(ll, { pane: 'staticPane', radius: hub ? 8 : 6, color: '#46d493', fillColor: hub ? '#2c8' : '#1a6', fillOpacity: 0.9, weight: 2 })
        .bindTooltip(hub ? 'Castle Mound — launch / charge hub' : 'Charging depot').addTo(staticLayer);
    });
  }

  // Open-request pickup dots + faint pickup->dropoff legs (keyed, reconciled).
  const reqSeen = new Set();
  for (const r of d.requests || []) {
    const key = reqKey(r); reqSeen.add(key);
    const pk = toLatLon(r.px, r.py, geo), dp = toLatLon(r.dx, r.dy, geo);
    let o = reqDots[key];
    if (!o) {
      const leg = L.polyline([pk, dp], { pane: 'staticPane', color: '#f0625d', weight: 0.8, opacity: 0.22, dashArray: '3 5' }).addTo(reqLayer);
      const dot = L.circleMarker(pk, { pane: 'staticPane', radius: 3.5, color: '#f0625d', fillColor: '#f0625d', fillOpacity: 0.9, weight: 0 })
        .bindTooltip(`${esc(r.pickup)} → ${esc(r.dropoff)} · ${esc(r.item || '')}`).addTo(reqLayer);
      dot.on('click', (e) => { L.DomEvent.stop(e); selectOrder(key, null, [r.px, r.py], true); });
      reqDots[key] = { dot, leg };
    } else { o.dot.setLatLng(pk); o.leg.setLatLngs([pk, dp]); }
  }
  for (const key in reqDots) if (!reqSeen.has(key)) { reqLayer.removeLayer(reqDots[key].dot); reqLayer.removeLayer(reqDots[key].leg); delete reqDots[key]; }

  // Drone trajectories (persistent glowing polylines that update in place).
  const seen = new Set();
  for (const x of d.drones || []) {
    seen.add(x.id);
    const ll = toLatLon(x.x, x.y, geo);
    if (x.path && x.path.length >= 2) {
      const line = x.path.map((p) => toLatLon(p[0], p[1], geo));
      let pl = dronePaths[x.id];
      if (!pl) {
        pl = L.polyline(line, { pane: 'trajPane', color: '#00ccbc', weight: 2, opacity: 0.4, className: 'traj' }).addTo(map);
        pl.on('click', (e) => { L.DomEvent.stop(e); selectDrone(x.id, true); });
        dronePaths[x.id] = pl;
      } else pl.setLatLngs(line);
    } else if (dronePaths[x.id]) { map.removeLayer(dronePaths[x.id]); delete dronePaths[x.id]; }

    const grounded = x.phase === 'grounded' || x.phase === 'emergency';
    const c = grounded ? '#f0625d' : x.exposed ? '#f2b84b' : '#00ccbc';
    const tip = `${shortId(x.id)} · ${x.phase} · ${Math.round(x.soc)}%${x.job ? ' · → ' + esc(x.job.dropoff) : ''}${x.fault ? ' · ⚠ ' + esc(x.fault) : ''}`;
    let m = droneMarkers[x.id];
    if (!m) {
      m = L.circleMarker(ll, { radius: 5, color: '#fff', weight: 1, fillColor: c, fillOpacity: 0.96, className: 'drone-marker' }).addTo(map);
      m.on('click', (e) => { L.DomEvent.stop(e); selectDrone(x.id, true); });
      droneMarkers[x.id] = m;
    } else { m.setLatLng(ll); m.setStyle({ fillColor: c }); }
    m.bindTooltip(tip);
  }
  for (const id in droneMarkers) if (!seen.has(id)) { map.removeLayer(droneMarkers[id]); delete droneMarkers[id]; }
  for (const id in dronePaths) if (!seen.has(id)) { map.removeLayer(dronePaths[id]); delete dronePaths[id]; }

  // Aerial retrieval drones (recovery aircraft fetching downed drones).
  const rseen = new Set();
  for (const r of d.retrievals || []) {
    rseen.add(r.id);
    const ll = toLatLon(r.x, r.y, geo);
    let o = retrievalMarkers[r.id];
    if (!o) {
      o = {
        m: L.circleMarker(ll, { pane: 'selPane', radius: 6, color: '#fff', weight: 1.5, fillColor: '#f2b84b', fillOpacity: 0.97 }),
        line: L.polyline([ll, ll], { pane: 'trajPane', color: '#f2b84b', weight: 1.6, opacity: 0, dashArray: '4 6' }),
      };
      o.m.addTo(map); o.line.addTo(map);
      retrievalMarkers[r.id] = o;
    } else { o.m.setLatLng(ll); }
    const busy = r.phase !== 'idle';
    o.m.setStyle({ fillOpacity: busy ? 0.97 : 0.4 });
    o.m.bindTooltip('🛠 ' + shortId(r.id).replace('retrieval_', 'R') + ' · ' + r.phase + (r.target ? ' · ' + shortId(r.target) : ''));
    if (busy && r.tx != null) {
      const tll = toLatLon(r.tx, r.ty, geo);
      o.line.setLatLngs([ll, tll]); o.line.setStyle({ opacity: 0.6 });
    } else o.line.setStyle({ opacity: 0 });
  }
  for (const id in retrievalMarkers) if (!rseen.has(id)) { map.removeLayer(retrievalMarkers[id].m); map.removeLayer(retrievalMarkers[id].line); delete retrievalMarkers[id]; }

  if (!fitted) {
    const all = (d.depots || []).map((p) => toLatLon(p.x, p.y, geo)).concat((d.drones || []).map((x) => toLatLon(x.x, x.y, geo)));
    if (all.length) { map.fitBounds(all, { padding: [40, 40], maxZoom: 14 }); fitted = true; }
  }
  refreshSelection();
}

/* ---------------- stats: projected (instant) + live (measured) ---------------- */
function statCard(v, k, unit, cls) {
  return `<div class="stat ${cls || ''}"><div class="v">${v}<span class="u">${unit || ''}</span></div><div class="k">${k}</div></div>`;
}
function renderStats(d) {
  const s = d.stats, f = d.fleet, c = d.costs || {};
  const flying = (d.drones || []).filter((x) => x.phase !== 'idle' && x.phase !== 'charging' && x.phase !== 'grounded').length;
  const cards = [
    statCard(flying + '<span class="u">/' + f.drones + '</span>', 'Drones flying', '', ''),
    statCard(s.pending, 'Open requests', '', 'coral'),
    statCard(s.drone_completed, 'Deliveries', '', ''),
    ...((s.chained_pickups || 0) > 0 ? [statCard(Math.round(100 * s.chained_pickups / Math.max(1, s.drone_completed)), 'Backhaul-chained', '%', 'green')] : []),
  ];
  if (c.has_projection) {
    // ROC tracks the PROJECTED profit so fee/parameter tweaks show their effect instantly.
    const pp = hist.proj.filter((v) => v != null);
    let roc = null;
    if (pp.length > 6) roc = c.proj_profit_per_delivery - pp[Math.max(0, pp.length - 12)];
    const arrow = roc == null ? '' : roc > 0.01 ? ` <span class="roc up">▲${roc.toFixed(2)}</span>` : roc < -0.01 ? ` <span class="roc down">▼${(-roc).toFixed(2)}</span>` : ' <span class="roc">→</span>';
    const pr = c.proj_profit_per_delivery;
    const cal = d.calibration || {};
    const calTag = cal.calibrated ? ' · ✈ PHYSICS' : '';
    cards.push(statCard((pr >= 0 ? '+' : '') + pr.toFixed(2) + arrow, 'Profit/del £ · PROJECTED' + calTag, '', pr >= 0 ? 'green' : 'coral'));
    if (c.has_data) {
      const lp = c.profit_per_delivery;
      cards.push(statCard((lp >= 0 ? '+' : '') + lp.toFixed(2), 'Profit/del £ · LIVE', '', lp >= 0 ? 'green' : 'coral'));
    }
    cards.push(statCard(Math.round(c.proj_margin_pct), 'Margin · proj', '%', c.proj_margin_pct >= 0 ? 'green' : 'coral'));
    cards.push(statCard(Math.round(c.proj_daily_profit / 100) / 10 + 'k', 'Profit/day · proj', ' £', c.proj_daily_profit >= 0 ? 'green' : 'coral'));
    if (c.has_data) cards.push(statCard((c.deliveries_per_drone_day || 0).toFixed(0), 'Drops/drone/day', '', (c.deliveries_per_drone_day || 0) >= 22 ? 'green' : 'coral'));
  }
  const k = d.kpis || {};
  if ((k.sample || 0) > 0) {
    cards.push(statCard((k.throughput_per_hr || 0).toFixed(1), 'Throughput', ' /hr', ''));
    cards.push(statCard(Math.round(k.on_time_pct || 0), 'On-time', '%', (k.on_time_pct || 0) < 90 ? 'coral' : ''));
  }
  const m = d.market || {};
  if (m.demand_multiplier != null) {
    cards.push(statCard('×' + (m.demand_multiplier || 0).toFixed(1), 'Demand vs baseline', '', (m.demand_multiplier || 1) >= 1 ? 'green' : 'coral'));
    cards.push(statCard(Math.round((m.adoption || 0) * 100), 'Market adoption', '%', ''));
    cards.push(statCard(Math.round((m.brand_trust || 0) * 100), 'Brand trust', '%', (m.brand_trust || 0) < 0.5 ? 'coral' : 'green'));
    if (m.merchants != null) cards.push(statCard(m.merchants, 'Merchants live', '', ''));
  }
  if ((s.declined || m.declined || 0) > 0) cards.push(statCard(s.declined || m.declined, 'Declined (at capacity)', '', 'amber'));
  if ((s.expired || 0) > 0) cards.push(statCard(s.expired, 'Expired (SLA)', '', 'coral'));
  if ((m.refused || 0) > 0) cards.push(statCard(m.refused, 'Refused (no-fly)', '', 'amber'));
  if ((s.incidents || 0) > 0) {
    const safe = s.safe_landings || 0, unsafe = s.unsafe_landings || 0;
    cards.push(statCard(s.incidents, 'Incidents', '', 'coral'));
    cards.push(statCard(safe + unsafe > 0 ? Math.round((100 * safe) / (safe + unsafe)) : 100, 'Safe-landing', '%', unsafe > 0 ? 'coral' : ''));
  }
  const retr = d.retrievals || [];
  const retrBusy = retr.filter((r) => r.phase !== 'idle').length;
  if (retr.length > 0) cards.push(statCard(retrBusy + '<span class="u">/' + retr.length + '</span>', 'Retrieval drones out', '', retrBusy > 0 ? 'amber' : ''));
  if ((s.recoveries || 0) > 0 || (s.crews_busy || 0) > 0 || (s.awaiting_recovery || 0) > 0) {
    cards.push(statCard(s.recoveries || 0, 'Drones recovered', '', ''));
    if ((s.crews_busy || 0) > 0) cards.push(statCard((s.crews_busy || 0) + '<span class="u">/' + (s.crews_total || 0) + '</span>', 'Ground crews busy', '', ''));
    if ((s.awaiting_recovery || 0) > 0) cards.push(statCard(s.awaiting_recovery, 'Awaiting recovery', '', 'coral'));
  }
  // Handoff quality + purchase behaviour.
  const okh = m.handoffs_ok || 0, gr = m.grievances || 0;
  if (okh + gr > 0) {
    cards.push(statCard(Math.round(100 * okh / (okh + gr)), 'Clean handoffs', '%', (okh / (okh + gr)) < 0.9 ? 'coral' : 'green'));
    if (gr > 0) cards.push(statCard(gr, 'Grievances', '', 'coral'));
  }
  if ((m.abandoned_price || 0) > 0) cards.push(statCard(m.abandoned_price, 'Priced out (no sale)', '', 'amber'));
  if ((m.p2p_orders || 0) > 0) cards.push(statCard(m.p2p_orders, 'P2P parcels', '', ''));
  if ((m.b2b_orders || 0) > 0) cards.push(statCard(m.b2b_orders, 'Business supply drops', '', ''));
  if ((m.c2b_orders || 0) > 0) cards.push(statCard(m.c2b_orders, 'Returns to business', '', ''));
  $('stats').innerHTML = cards.join('');
}

/* ---------------- keyed list reconciliation (no flicker) ---------------- */
// Maintains child nodes keyed by data-key: updates in place, adds new, removes gone,
// reorders to match `items`. No innerHTML wipe -> no flash, no re-run animations.
function reconcile(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const el of Array.from(container.children)) existing.set(el.dataset.key, el);
  const used = new Set();
  let prev = null;
  for (const it of items) {
    const key = keyOf(it); used.add(key);
    let el = existing.get(key);
    if (!el) { el = create(it); el.dataset.key = key; } else { update(el, it); }
    // place in correct order
    if (prev) { if (prev.nextSibling !== el) container.insertBefore(el, prev.nextSibling); }
    else if (container.firstChild !== el) container.insertBefore(el, container.firstChild);
    prev = el;
  }
  for (const [key, el] of existing) if (!used.has(key)) el.remove();
}

const reqKey = (r) => `o:${Math.round(r.px)},${Math.round(r.py)},${Math.round(r.dx)},${Math.round(r.dy)}`;
function fmtDue(s) { return s < 0 ? `${Math.round(-s)}s late` : s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`; }
const missionPin = (mission, c) => mission === 'residence_to_residence' ? 'P2P'
  : mission === 'business_to_business' ? 'B2B'
  : mission === 'residence_to_business' ? 'R2B'
  : c === 'restaurant' ? 'FOOD' : 'B2C';

// Unified live order list: in-flight deliveries (with their assigned drone) first,
// then open/pending requests awaiting dispatch.
function buildOrders(d) {
  const orders = [];
  for (const x of d.drones || []) {
    if (!x.job) continue;
    const phase = x.phase || '';
    const status = phase.indexOf('pickup') >= 0 ? 'to pickup' : (x.carrying || phase.indexOf('drop') >= 0 || phase.indexOf('deliver') >= 0) ? 'in flight' : 'assigned';
    orders.push({
      key: 'd:' + x.id, kind: 'inflight', drone: x.id, status,
      pickup: x.job.pickup, dropoff: x.job.dropoff, price: x.job.price,
      pickup_cat: '', mission_type: x.job.mission_type, focus: [x.x, x.y], soc: x.soc,
    });
  }
  for (const r of (d.requests || []).slice().sort((a, b) => a.due_in_s - b.due_in_s)) {
    orders.push({
      key: reqKey(r), kind: 'pending', drone: null,
      status: r.due_in_s < 0 ? 'late' : r.ready ? 'ready' : 'preparing',
      pickup: r.pickup, dropoff: r.dropoff, item: r.item, pickup_cat: r.pickup_cat,
      mission_type: r.mission_type,
      due_in_s: r.due_in_s, age_s: r.age_s, focus: [r.px, r.py], price: null,
    });
  }
  return orders;
}

function orderCardHTML(o) {
  const badgeCls = o.kind === 'inflight' ? 'inflight' : o.status === 'late' ? 'late' : o.status === 'ready' ? 'ready' : 'prep';
  const badge = o.kind === 'inflight' ? `🚁 ${shortId(o.drone)}` : o.status;
  const sub = o.kind === 'inflight'
    ? `<span class="cat">${o.status}</span><span>£<b>${(o.price || 0).toFixed(2)}</b></span><span>🔋<b>${Math.round(o.soc || 0)}%</b></span>`
    : `<span class="cat">${esc(o.item || o.pickup_cat || 'parcel')}</span><span>wait <b>${Math.round(o.age_s || 0)}s</b></span><span>due <b>${fmtDue(o.due_in_s)}</b></span>`;
  return `<div class="req-top"><div class="req-route"><span class="pin">${o.kind === 'inflight' ? 'LIVE' : missionPin(o.mission_type, o.pickup_cat)}</span><span>${esc(o.pickup)}</span><span class="arrow">→</span><span class="to">${esc(o.dropoff)}</span></div><span class="badge ${badgeCls}">${esc(badge)}</span></div><div class="req-meta">${sub}</div>`;
}

function renderOrders(d) {
  const orders = buildOrders(d);
  $('req-count').textContent = (d.stats ? d.stats.pending : orders.length);
  const box = $('requests');
  if (!orders.length) { box.innerHTML = '<div class="empty">No live orders</div>'; return; }
  if (box.firstChild && box.firstChild.className === 'empty') box.innerHTML = '';
  const selId = selected && selected.kind === 'order' ? selected.id : null;
  reconcile(box, orders,
    (o) => o.key,
    (o) => {
      const el = document.createElement('div');
      el.className = 'req';
      el.innerHTML = orderCardHTML(o);
      el.onclick = () => selectOrder(o.key, o.drone, o.focus, true);
      decorateOrder(el, o, selId);
      return el;
    },
    (el, o) => { el.innerHTML = orderCardHTML(o); el.onclick = () => selectOrder(o.key, o.drone, o.focus, true); decorateOrder(el, o, selId); });
}
function decorateOrder(el, o, selId) {
  el.classList.toggle('ready', o.status === 'ready' || o.kind === 'inflight');
  el.classList.toggle('sel', o.key === selId);
  el.classList.toggle('inflight', o.kind === 'inflight');
}

function renderFleet(d) {
  const list = d.drones || [];
  $('fleet-count').textContent = list.length;
  const box = $('fleet');
  if (!list.length) { box.innerHTML = '<div class="empty">No drones deployed</div>'; return; }
  if (box.firstChild && box.firstChild.className === 'empty') box.innerHTML = '';
  const selId = selectedDroneId();
  reconcile(box, list,
    (x) => x.id,
    (x) => { const el = document.createElement('div'); el.className = 'drone-card'; el.innerHTML = fleetCardHTML(x); el.onclick = () => selectDrone(x.id, true); decorateFleet(el, x, selId); return el; },
    (el, x) => { el.innerHTML = fleetCardHTML(x); el.onclick = () => selectDrone(x.id, true); decorateFleet(el, x, selId); });
}
function fleetCardHTML(x) {
  const soc = Math.max(0, Math.min(100, x.soc || 0));
  const col = soc > 55 ? 'var(--green)' : soc > 25 ? 'var(--amber)' : 'var(--red)';
  const ph = (x.phase || 'idle').replace(/ /g, '-');
  const job = x.job ? `<div class="dc-job">→ ${esc(x.job.dropoff)} · £${(x.job.price || 0).toFixed(2)}</div>` : '';
  return `<div class="dc-top"><span class="dc-id">${esc(shortId(x.id))}</span><span class="phase ${ph}">${esc(x.phase)}</span></div>
    <div class="batt"><span style="width:${soc}%;background:${col}"></span></div>
    <div class="dc-meta"><span><b>${Math.round(soc)}%</b> · ${x.terminal_v ? x.terminal_v.toFixed(0) + 'V · ' : ''}${x.deliveries || 0} drops</span>
    ${x.fault ? '<span class="warn">⚠ ' + esc(x.fault) + '</span>' : x.exposed ? '<span class="warn">⚠ over open ground</span>' : (x.carrying ? '<span>📦 carrying</span>' : '<span>—</span>')}</div>${job}`;
}
function decorateFleet(el, x, selId) { el.classList.toggle('exposed', !!x.exposed); el.classList.toggle('sel', x.id === selId); }

function renderLists(d) { if (!d) return; renderOrders(d); renderFleet(d); }

/* ---------------- weather ---------------- */
function renderWeather(c) {
  const w = c.wind_mps || 0, el = $('weather');
  let label, cls;
  if (c.recall) { label = '🚨 RECALL ALL'; cls = 'storm'; }
  else if (c.signal_outage) { label = '📡 SIGNAL OUTAGE'; cls = 'storm'; }
  else if (c.ground_stop) { label = `⛔ GROUND STOP · ${Math.round(w)} m/s`; cls = 'storm'; }
  else if (w >= 16) { label = `⛈ storm · ${Math.round(w)} m/s`; cls = 'storm'; }
  else if (w >= 5 || c.failures_on) { label = `🌬 breezy · ${Math.round(w)} m/s`; cls = 'breezy'; }
  else { label = '☀ clear'; cls = ''; }
  el.textContent = label; el.className = 'weatherpill ' + cls;
}

/* ---------------- analytics (uPlot, robust live time-series) ---------------- */
const MAXH = 600;
const hist = {
  t: [], throughput: [], profit: [], proj: [], ontime: [], energy: [],
  adoption: [], trust: [], demand: [], queue: [], complaints: [],
  maintenance: [], recovery: [], comms: [],
};
function pushHist(d) {
  const k = d.kpis || {}, c = d.costs || {}, m = d.market || {}, s = d.stats || {}, o = d.operations || {};
  const simT = Number(d.sim_time_s || 0);
  const previous = hist.t.length ? hist.t[hist.t.length - 1] : null;
  hist.t.push(previous == null ? simT : Math.max(simT, previous + POLL_MS / 1000));
  hist.throughput.push(k.throughput_per_hr || 0);
  hist.profit.push(c.has_data ? c.profit_per_delivery : null);
  hist.proj.push(c.has_projection ? c.proj_profit_per_delivery : null);
  hist.ontime.push(k.on_time_pct ?? null);
  hist.energy.push(k.wh_per_delivery || null);
  hist.adoption.push((m.adoption || 0) * 100);
  hist.trust.push((m.brand_trust || 0) * 100);
  hist.demand.push(m.demand_multiplier || 0);
  hist.queue.push(s.pending || 0);
  hist.complaints.push(m.grievances || 0);
  hist.maintenance.push(o.aircraft_in_maintenance || 0);
  hist.recovery.push(o.recovery_crews_busy || 0);
  hist.comms.push(o.aircraft_signal_lost || 0);
  for (const key of Object.keys(hist)) if (hist[key].length > MAXH) hist[key].shift();
}

const AX = '#8a93a6', GRID = 'rgba(255,255,255,.06)';
const axis = (scale) => ({ scale, stroke: AX, grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID }, font: '10px Inter', size: scale === 'x' ? 28 : 34 });
const charts = {};
function ser(label, color, opts = {}) { return Object.assign({ label, stroke: color, width: 1.8, points: { show: false } }, opts); }
function buildCharts() {
  const defs = {
    'uc-profit': { scales: { x: { time: false } }, series: [{}, ser('proj', '#46d493', { dash: [5, 4], width: 1.4 }), ser('live', '#7ef9ec')] },
    'uc-throughput': { scales: { x: { time: false } }, series: [{}, ser('/hr', '#00ccbc')] },
    'uc-ontime': { scales: { x: { time: false }, y: { range: [0, 100] } }, series: [{}, ser('%', '#f2b84b')] },
    'uc-energy': { scales: { x: { time: false } }, series: [{}, ser('Wh', '#88c4ec')] },
    'uc-market': { scales: { x: { time: false }, y: { range: [0, 100] } }, series: [{}, ser('adoption %', '#00ccbc'), ser('trust %', '#f2b84b')] },
    'uc-demand': { scales: { x: { time: false }, y: {}, q: {} }, series: [{}, ser('demand ×', '#46d493'), ser('queue', '#f0625d', { scale: 'q' })] },
    'uc-workforce': { scales: { x: { time: false } }, series: [{}, ser('maintenance', '#f2b84b'), ser('recovery crews', '#f0625d')] },
    'uc-comms': { scales: { x: { time: false } }, series: [{}, ser('signal lost', '#88c4ec'), ser('complaints', '#f0625d')] },
  };
  for (const id in defs) {
    const el = $(id); if (!el || charts[id]) continue;
    const w = el.clientWidth || 240, h = el.clientHeight || 96;
    const d = defs[id];
    const yAxes = id === 'uc-demand' ? [axis('x'), axis('y'), Object.assign(axis('q'), { side: 1 })] : [axis('x'), axis('y')];
    charts[id] = new uPlot({ width: w, height: h, legend: { show: false }, cursor: { points: { size: 5 } }, scales: d.scales, axes: yAxes, series: d.series }, [[0]], el);
  }
}
function chartData(id) {
  const t = hist.t;
  switch (id) {
    case 'uc-profit': return [t, hist.proj, hist.profit];
    case 'uc-throughput': return [t, hist.throughput];
    case 'uc-ontime': return [t, hist.ontime];
    case 'uc-energy': return [t, hist.energy];
    case 'uc-market': return [t, hist.adoption, hist.trust];
    case 'uc-demand': return [t, hist.demand, hist.queue];
    case 'uc-workforce': return [t, hist.maintenance, hist.recovery];
    case 'uc-comms': return [t, hist.comms, hist.complaints];
  }
}

/* ---------------- operations, workforce, communications and audit feed ----------- */
const activity = [];
let activityBaseline = null;
function addActivity(level, area, message, t) {
  activity.unshift({ level, area, message, t: t || 0 });
  if (activity.length > 80) activity.length = 80;
}
function captureActivity(d) {
  const s = d.stats || {}, m = d.market || {}, o = d.operations || {};
  const current = {
    incidents: s.incidents || 0,
    recoveries: s.recoveries || 0,
    complaints: m.grievances || 0,
    signal: o.aircraft_signal_lost || 0,
    maintenance: o.aircraft_in_maintenance || 0,
    awaiting: o.aircraft_awaiting_recovery || 0,
    groundStop: !!(d.conditions || {}).ground_stop,
  };
  if (!activityBaseline) {
    activityBaseline = current;
    addActivity('info', 'system', 'Operations telemetry connected', d.sim_time_s);
    return;
  }
  const deltaEvent = (key, level, area, singular) => {
    const delta = current[key] - activityBaseline[key];
    if (delta > 0) addActivity(level, area, `${delta} ${singular}${delta === 1 ? '' : 's'} detected`, d.sim_time_s);
  };
  deltaEvent('incidents', 'critical', 'safety', 'new incident');
  deltaEvent('recoveries', 'ok', 'recovery', 'recovery completed');
  deltaEvent('complaints', 'warn', 'customer', 'new complaint');
  if (current.signal !== activityBaseline.signal)
    addActivity(current.signal ? 'critical' : 'ok', 'comms', current.signal ? `${current.signal} aircraft reporting signal loss` : 'All aircraft communications restored', d.sim_time_s);
  if (current.maintenance !== activityBaseline.maintenance)
    addActivity(current.maintenance ? 'warn' : 'ok', 'maintenance', `${current.maintenance} aircraft currently in maintenance`, d.sim_time_s);
  if (current.awaiting !== activityBaseline.awaiting && current.awaiting)
    addActivity('critical', 'recovery', `${current.awaiting} aircraft awaiting a field crew`, d.sim_time_s);
  if (current.groundStop !== activityBaseline.groundStop)
    addActivity(current.groundStop ? 'critical' : 'ok', 'operations', current.groundStop ? 'Weather ground stop activated' : 'Weather ground stop cleared', d.sim_time_s);
  activityBaseline = current;
}
function renderOperations(d) {
  const el = $('operations'); if (!el) return;
  const source = d.operations || {}, m = d.market || {}, c = d.conditions || {}, s = d.stats || {};
  const drones = d.drones || [], fleetCount = (d.fleet || {}).drones || drones.length;
  const o = {
    supervisors_on_shift: source.supervisors_on_shift ?? (d.costs || {}).supervisors ?? Math.ceil(fleetCount / 18),
    drones_per_supervisor: source.drones_per_supervisor ?? 18,
    mechanics_on_shift: source.mechanics_on_shift ?? Math.ceil(Math.max(1, fleetCount) / 25),
    aircraft_in_maintenance: source.aircraft_in_maintenance ?? drones.filter((x) => x.phase === 'grounded' || x.phase === 'emergency').length,
    recovery_crews_busy: source.recovery_crews_busy ?? s.crews_busy ?? 0,
    recovery_crews_total: source.recovery_crews_total ?? s.crews_total ?? 0,
    aircraft_awaiting_recovery: source.aircraft_awaiting_recovery ?? s.awaiting_recovery ?? 0,
    aircraft_signal_lost: source.aircraft_signal_lost ?? drones.filter((x) => x.signal_lost).length,
    aircraft_with_faults: source.aircraft_with_faults ?? drones.filter((x) => x.fault).length,
  };
  const cards = [
    ['Remote supervisors', `${o.supervisors_on_shift || 0}`, `${o.drones_per_supervisor || 0} drones / supervisor`, ''],
    ['Maintenance team', `${o.mechanics_on_shift || 0}`, `${o.aircraft_in_maintenance || 0} aircraft active`, o.aircraft_in_maintenance ? 'warn' : ''],
    ['Recovery crews', `${o.recovery_crews_busy || 0}/${o.recovery_crews_total || 0}`, `${o.aircraft_awaiting_recovery || 0} awaiting`, o.aircraft_awaiting_recovery ? 'critical' : ''],
    ['Communications', `${o.aircraft_signal_lost || 0}`, 'aircraft signal lost', o.aircraft_signal_lost ? 'critical' : ''],
    ['Open faults', `${o.aircraft_with_faults || 0}`, 'aircraft reporting faults', o.aircraft_with_faults ? 'warn' : ''],
    ['Complaints', `${m.grievances || 0}`, `${m.handoffs_ok || 0} clean handoffs`, (m.grievances || 0) ? 'warn' : ''],
  ];
  $('ops-cards').innerHTML = cards.map(([label, value, sub, cls]) =>
    `<article class="${cls}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub)}</small></article>`).join('');
  const recoveryJobs = Array.isArray(d.recovery_jobs) ? d.recovery_jobs : [];
  $('recovery-count').textContent = `${recoveryJobs.length} active`;
  $('recovery-jobs').innerHTML = recoveryJobs.length ? recoveryJobs.map((job) => {
    const eta = Number(job.eta_s || 0);
    const etaLabel = eta > 0 ? `${Math.ceil(eta / 60)}m` : 'now';
    const orderState = job.affected_order_requeued ? 'replacement order queued' : 'order impact assessing';
    return `<article class="recovery-job"><b>${esc(shortId(job.drone_id))}</b><div><strong>${esc(job.status)}</strong><small>${esc(job.fault || 'inspection pending')} · ${orderState}</small></div><time>${etaLabel}</time></article>`;
  }).join('') : '<div class="recovery-empty">No active aircraft recovery or hub-maintenance jobs.</div>';
  $('ops-status').textContent = c.ground_stop ? 'GROUND STOP' : c.signal_outage ? 'COMMS OUTAGE' : 'OPERATING';
  $('ops-status').className = (c.ground_stop || c.signal_outage) ? 'ops-state critical' : 'ops-state';
  $('activity-feed').innerHTML = activity.map((e) =>
    `<li class="${e.level}"><time>${fmtClock(e.t)}</time><b>${esc(e.area)}</b><span>${esc(e.message)}</span></li>`).join('');
}
// Full unit-economics breakdown + hosting comparison + scaling + minimisation levers.
function renderCostBreakdown(d) {
  const el = $('cost-wrap'); if (!el) return;
  const c = (d && d.costs) || {};
  if (!c.has_data) { el.innerHTML = '<div class="cost-card"><div class="cost-h">Unit economics</div><div class="empty">Warming up — collecting live deliveries to compute realised cost…</div></div>'; return; }
  const items = [
    ['Labour (ops + maintenance + recovery crew)', c.labour_per_delivery],
    ['Drone capex (amortised)', c.capex_per_delivery],
    ['Infrastructure (' + (c.self_host ? 'self-hosted' : 'cloud') + ')', c.infra_per_delivery],
    ['Insurance', c.insurance_per_delivery],
    ['Licensing / SORA / UTM', c.licensing_per_delivery],
    ['Admin / back-office', c.admin_per_delivery],
    ['Depot / docks', c.depot_per_delivery],
    ['Connectivity', c.connectivity_per_delivery],
    ['Energy', c.energy_per_delivery],
    ['Battery wear', c.battery_per_delivery],
    ['Maintenance', c.maintenance_per_delivery],
    ['Recovery callouts', c.recovery_per_delivery],
    ['Packaging', c.packaging_per_delivery],
  ].filter((x) => (x[1] || 0) > 0.0001).sort((a, b) => b[1] - a[1]);
  const total = c.cost_per_delivery || items.reduce((s, x) => s + x[1], 0);
  const rev = c.revenue_per_delivery || 0, van = c.van_per_delivery || 0;
  const max = Math.max(...items.map((x) => x[1]), 0.01);
  const bars = items.map(([k, v]) => `<div class="cb-row"><span class="cb-k">${k}</span><span class="cb-bar"><span style="width:${(100 * v / max).toFixed(0)}%"></span></span><span class="cb-v">£${v.toFixed(3)} <em>${Math.round(100 * v / total)}%</em></span></div>`).join('');

  // Hosting comparison + scaling + levers.
  const altLabel = c.self_host ? 'managed cloud' : 'self-hosting';
  const altSaves = (c.infra_per_delivery || 0) - (c.infra_per_delivery_alt || 0); // >0 means alt is cheaper
  const scaleDelta = total - (c.cost_per_delivery_2x_fleet || total);
  const top = items[0];
  const levers = [];
  if (top && /Labour/.test(top[0])) levers.push('<b>Labour is your biggest line (' + Math.round(100 * top[1] / total) + '%).</b> The single strongest lever is the remote-supervision ratio — every extra drone per pilot drops this. Automation that lifts drones/supervisor from 18→25 is worth ~£' + (top[1] * 0.28).toFixed(2) + '/delivery.');
  if (altSaves > 0.001) levers.push('Switching to <b>' + altLabel + '</b> would cut infra by ~£' + altSaves.toFixed(3) + '/delivery at this scale.');
  else levers.push('Your current <b>' + (c.self_host ? 'self-hosted' : 'cloud') + '</b> infra is the cheaper option at this scale (' + altLabel + ' would be £' + (c.infra_per_delivery_alt || 0).toFixed(3) + '/del).');
  if (scaleDelta > 0.001) levers.push('<b>Economies of scale:</b> doubling the fleet drops unit cost to £' + (c.cost_per_delivery_2x_fleet || 0).toFixed(2) + ' (−£' + scaleDelta.toFixed(2) + '/delivery) as fixed costs amortise over more drops.');
  levers.push('Keep <b>battery-swap</b> on — slow full-charge would gut the duty cycle and raise every fixed cost per delivery.');
  levers.push('<b>Density wins:</b> shorter average legs cut energy, battery wear and cycle time — concentrate launch hubs near demand.');

  el.innerHTML = `
    <div class="cost-card">
      <div class="cost-h">Unit economics · £ per delivery <span class="cost-sum">total £${total.toFixed(2)} · revenue £${rev.toFixed(2)} · ${rev > total ? '<em class="g">+£' + (rev - total).toFixed(2) + ' profit</em>' : '<em class="r">−£' + (total - rev).toFixed(2) + ' loss</em>'} · van baseline £${van.toFixed(2)}</span></div>
      <div class="cb-list">${bars}</div>
    </div>
    <div class="cost-card">
      <div class="cost-h">How to minimise cost &amp; what scaling adds</div>
      <ul class="levers">${levers.map((l) => '<li>' + l + '</li>').join('')}</ul>
      <div class="cost-note">Scaling adds these lines you must budget for: more <b>recovery crews</b> &amp; mechanics (step costs), <b>depot/dock</b> build-out as range demands it, rising <b>insurance &amp; SORA</b> scope per airframe, and <b>infra</b> — cloud grows linearly per drone while self-host is lumpy capex that wins past ~80–120 drones.</div>
    </div>`;
}
function renderPlots() {
  if ($('plots').hidden) return;
  renderCostBreakdown(lastData);
  buildCharts();
  for (const id in charts) {
    const el = $(id);
    if (el && (charts[id].width !== el.clientWidth || charts[id].height !== el.clientHeight) && el.clientWidth)
      charts[id].setSize({ width: el.clientWidth, height: el.clientHeight });
    charts[id].setData(chartData(id));
  }
}
$('plot-btn').onclick = () => {
  $('inspector').hidden = true;
  $('plots').hidden = false;
  $('plots').scrollTop = 0;
  document.body.classList.add('analytics-open');
  setTimeout(renderPlots, 40);
};
$('plot-close').onclick = () => {
  $('plots').hidden = true;
  document.body.classList.remove('analytics-open');
};

/* ---------------- helpers + poll ---------------- */
function shortId(id) { return String(id || '').replace('delivery_drone_', 'D'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtClock(s) { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function setConn(on) { $('conn').className = 'dot ' + (on ? 'online' : 'offline'); $('conn-label').textContent = on ? 'live' : 'waiting for simulator…'; }

let polling = false;
async function poll() {
  if (polling) return; polling = true; // never overlap fetches -> smooth async updates
  try {
    const res = await fetch('data/state.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    lastData = d; lastOk = Date.now(); setConn(true);
    $('model').textContent = d.fleet.drone_model || '—';
    const c0 = d.conditions || {};
    if (c0.day_cycle && c0.tod_hours >= 0) {
      const hh = Math.floor(c0.tod_hours), mm = Math.floor((c0.tod_hours - hh) * 60);
      $('simclock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ·${(c0.demand_x || 1).toFixed(1)}×`;
    } else $('simclock').textContent = fmtClock(d.sim_time_s || 0);
    $('speed').textContent = (d.fleet.time_scale || 1).toFixed(1) + '×';
    captureActivity(d);
    renderWeather(c0); renderStats(d); renderLists(d); renderMap(d); drawHeat(); renderOperations(d);
    pushHist(d); renderPlots();
  } catch (e) {
    if (Date.now() - lastOk > 4000) setConn(false);
  } finally { polling = false; }
}
poll();
setInterval(poll, POLL_MS);
window.addEventListener('resize', () => { map.invalidateSize(); renderPlots(); });
