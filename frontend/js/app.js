const API_BASE = "https://gis-dss-osogbo.onrender.com";

// ── Initialize map centered on Osogbo ──────────────────────────────────────
const map = L.map('map').setView([7.7700, 4.5600], 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
}).addTo(map);

// State
let suitabilityLayer, roadsLayer, poisLayer;
let poisData = null;
let topZonesData = { type: "FeatureCollection", features: [] };
let selectedBusinessType = "";

// ── Category metadata: colors + display names ───────────────────────────────
const CATEGORY_META = {
  car_repair:       { label: "Car Repair",        color: "#e67e22" },
  car:              { label: "Car Dealer",        color: "#e67e22" },
  bank:             { label: "Bank",              color: "#2980b9" },
  electronics:      { label: "Electronics",       color: "#8e44ad" },
  computer:         { label: "Computer Shop",     color: "#8e44ad" },
  pharmacy:         { label: "Pharmacy",          color: "#27ae60" },
  school:           { label: "School",            color: "#f1c40f" },
  place_of_worship: { label: "Place of Worship",  color: "#95a5a6" },
  marketplace:      { label: "Marketplace",       color: "#d35400" },
  parking:          { label: "Parking",           color: "#7f8c8d" },
  fuel:             { label: "Fuel Station",      color: "#c0392b" },
  police:           { label: "Police",            color: "#34495e" },
  educational_institution: { label: "Educational Institution", color: "#f39c12" },
  bar:              { label: "Bar",               color: "#9b59b6" },
  supermarket:      { label: "Supermarket",       color: "#16a085" },
  department_store: { label: "Department Store", color: "#16a085" },
  fast_food:        { label: "Fast Food",         color: "#e74c3c" },
  clothes:          { label: "Clothing",          color: "#d63384" },
};

function categoryMeta(cat) {
  return CATEGORY_META[cat] || { label: cat || "Other", color: "#999999" };
}

// ── Loading overlay control ──────────────────────────────────────────────────
let loadedLayers = 0;
const TOTAL_LAYERS = 3; // suitability, roads, pois
function layerLoaded() {
  loadedLayers++;
  if (loadedLayers >= TOTAL_LAYERS) {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }
}

// ── Color scale for suitability ─────────────────────────────────────────────
function getColor(score) {
  if (score === null || score === undefined) return '#cccccc';
  if (score >= 70) return '#006837';
  if (score >= 55) return '#78c679';
  if (score >= 45) return '#ffffbf';
  if (score >= 30) return '#fdae61';
  return '#d73027';
}

function highlightZone(e) {
  const layer = e.target;
  layer.setStyle({ weight: 3, color: '#00d4ff', fillOpacity: 0.85 });
  layer.bringToFront();
}

function resetZone(e) {
  if (suitabilityLayer) suitabilityLayer.resetStyle(e.target);
}

// ── Get rank of a zone among current top zones (or null) ────────────────────
function getZoneRank(zoneId) {
  const idx = topZonesData.features.findIndex(f => f.properties.zone_id === zoneId);
  return idx >= 0 ? idx + 1 : null;
}

function onZoneClick(e) {
  const p = e.target.feature.properties;
  const rank = getZoneRank(p.zone_id);
  const score = p.adjusted_score !== undefined ? p.adjusted_score : p.composite_score;
  const barColor = getColor(score);

  let html = '';
  if (rank) {
    const contextLabel = selectedBusinessType ? categoryMeta(selectedBusinessType).label : 'General Use';
    html += `<span class="rank-badge">🏆 Ranked #${rank} for ${contextLabel}</span>`;
  }

  html += `
    <div class="stat-row"><span>Zone ID</span><span>${p.zone_id}</span></div>
    <div class="stat-row"><span>Base AHP Score</span><span>${p.ahp_score.toFixed(2)}</span></div>
    <div class="stat-row"><span>Base Composite Score</span><span>${p.composite_score.toFixed(2)}</span></div>
  `;

  if (p.competitor_count !== undefined && selectedBusinessType) {
    const meta = categoryMeta(selectedBusinessType);
    html += `
      <div class="stat-row"><span>${meta.label} here</span><span>${p.competitor_count}</span></div>
      <div class="stat-row"><span>Saturation Penalty</span><span>-${p.penalty}</span></div>
      <div class="stat-row"><span><b>Adjusted Score</b></span><span><b>${score.toFixed(2)} / 100</b></span></div>
    `;
  } else {
    html += `<div class="stat-row"><span><b>Composite Score</b></span><span><b>${score.toFixed(2)} / 100</b></span></div>`;
  }

  html += `
    <div class="score-bar-track">
      <div class="score-bar-fill" style="width:${score}%; background:${barColor}"></div>
    </div>
  `;

  document.getElementById('zoneInfo').innerHTML = html;
}

function onEachZone(feature, layer) {
  layer.on({
    mouseover: highlightZone,
    mouseout: resetZone,
    click: onZoneClick
  });
  const rank = getZoneRank(feature.properties.zone_id);
  const score = feature.properties.adjusted_score !== undefined
    ? feature.properties.adjusted_score
    : feature.properties.composite_score;
  const rankText = rank ? ` (Rank #${rank})` : '';
  layer.bindTooltip(`Zone ${feature.properties.zone_id}: ${score.toFixed(1)}${rankText}`);
}

// ── Render top zones list ────────────────────────────────────────────────────
function renderTopZonesList() {
  const title = document.getElementById('topZonesTitle');
  title.textContent = selectedBusinessType
    ? `Top Zones for ${categoryMeta(selectedBusinessType).label}`
    : 'Top Recommended Zones';

  const list = document.getElementById('topZonesList');
  list.innerHTML = '';
  topZonesData.features.forEach((f, i) => {
    const score = f.properties.adjusted_score !== undefined
      ? f.properties.adjusted_score
      : f.properties.composite_score;

    const div = document.createElement('div');
    div.className = 'zone-item';
    div.innerHTML = `
      <span><span class="zone-rank">${i + 1}</span>Zone ${f.properties.zone_id}</span>
      <span class="zone-score">${score.toFixed(1)}</span>
    `;
    div.addEventListener('click', () => {
      const bounds = L.geoJSON(f).getBounds();
      map.fitBounds(bounds, { maxZoom: 16 });
      suitabilityLayer.eachLayer(l => {
        if (l.feature.properties.zone_id === f.properties.zone_id) {
          onZoneClick({ target: l });
          l.openTooltip();
        }
      });
    });
    list.appendChild(div);
  });
}

// ── Load / Recompute Suitability Layer ───────────────────────────────────────
function loadRecommendation(businessType) {
  const url = businessType
    ? `${API_BASE}/api/recommend?type=${encodeURIComponent(businessType)}`
    : `${API_BASE}/api/recommend`;

  return fetch(url)
    .then(res => res.json())
    .then(data => {
      // Sort by adjusted_score for ranking
      const sorted = [...data.features].sort(
        (a, b) => b.properties.adjusted_score - a.properties.adjusted_score
      );
      topZonesData = { type: "FeatureCollection", features: sorted.slice(0, 10) };

      if (suitabilityLayer) map.removeLayer(suitabilityLayer);

      suitabilityLayer = L.geoJSON(data, {
        style: feature => ({
          fillColor: getColor(feature.properties.adjusted_score),
          weight: 1,
          opacity: 1,
          color: '#555',
          fillOpacity: 0.65
        }),
        onEachFeature: onEachZone
      });

      if (document.getElementById('toggleSuitability').checked) {
        suitabilityLayer.addTo(map);
      }

      renderTopZonesList();

      // Clear zone info panel on context switch
      document.getElementById('zoneInfo').innerHTML = 'Click a zone on the map to see details.';
    });
}

// ── Roads Layer ───────────────────────────────────────────────────────────────
fetch(`${API_BASE}/api/roads`)
  .then(res => res.json())
  .then(data => {
    roadsLayer = L.geoJSON(data, {
      style: { color: '#444', weight: 1.2, opacity: 0.6 }
    }).addTo(map);
    layerLoaded();
  })
  .catch(() => layerLoaded());

// ── POIs Layer ────────────────────────────────────────────────────────────────
function buildPoisLayer() {
  if (poisLayer) map.removeLayer(poisLayer);

  poisLayer = L.geoJSON(poisData, {
    pointToLayer: (feature, latlng) => {
      const cat = feature.properties.category;
      const meta = categoryMeta(cat);
      const isMatch = selectedBusinessType && cat === selectedBusinessType;

      return L.circleMarker(latlng, {
        radius: isMatch ? 9 : 5,
        fillColor: isMatch ? '#ff1744' : meta.color,
        color: '#fff',
        weight: isMatch ? 2 : 1,
        fillOpacity: 0.9,
        className: isMatch ? 'competitor-marker' : ''
      });
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      const meta = categoryMeta(p.category);
      const isMatch = selectedBusinessType && p.category === selectedBusinessType;
      layer.bindPopup(`
        <div class="popup-title">${p.name || 'Unnamed Business'}</div>
        <span class="popup-badge" style="background:${meta.color}">${meta.label}</span>
        ${isMatch ? '<div class="popup-row"><b style="color:#ff1744">⚠ Direct Competitor</b></div>' : ''}
        <div class="popup-row"><span>Source</span><span>${p.source || 'OSM'}</span></div>
      `);
    }
  }).addTo(map);
}

fetch(`${API_BASE}/api/pois`)
  .then(res => res.json())
  .then(data => {
    poisData = data;
    buildPoisLayer();
    layerLoaded();
  })
  .catch(() => layerLoaded());

// ── Stats ─────────────────────────────────────────────────────────────────────
fetch(`${API_BASE}/api/stats`)
  .then(res => res.json())
  .then(data => {
    document.getElementById('statsContent').innerHTML = `
      <div class="stat-row"><span>Analysis Zones</span><span>${data.total_zones}</span></div>
      <div class="stat-row"><span>Business POIs</span><span>${data.total_pois}</span></div>
      <div class="stat-row"><span>Road Segments</span><span>${data.total_road_segments}</span></div>
      <div class="stat-row"><span>Min Score</span><span>${data.suitability_min}</span></div>
      <div class="stat-row"><span>Max Score</span><span>${data.suitability_max}</span></div>
      <div class="stat-row"><span>Avg Score</span><span>${data.suitability_avg}</span></div>
    `;
  });

// ── Initial Suitability Load (general) ───────────────────────────────────────
loadRecommendation("").then(() => layerLoaded());

// ── Layer Toggles ────────────────────────────────────────────────────────────
document.getElementById('toggleSuitability').addEventListener('change', e => {
  if (!suitabilityLayer) return;
  if (e.target.checked) map.addLayer(suitabilityLayer);
  else map.removeLayer(suitabilityLayer);
});
document.getElementById('toggleRoads').addEventListener('change', e => {
  if (e.target.checked) map.addLayer(roadsLayer);
  else map.removeLayer(roadsLayer);
});
document.getElementById('togglePOIs').addEventListener('change', e => {
  if (e.target.checked) map.addLayer(poisLayer);
  else map.removeLayer(poisLayer);
});

// ── Business Type Selector ───────────────────────────────────────────────────
document.getElementById('businessType').addEventListener('change', e => {
  selectedBusinessType = e.target.value;
  const hint = document.getElementById('businessHint');

  if (selectedBusinessType) {
    const meta = categoryMeta(selectedBusinessType);
    hint.innerHTML = `<b>Recalculated for ${meta.label}.</b> Zones with existing ${meta.label} locations are penalized for market saturation. Map colors and rankings updated accordingly.`;
  } else {
    hint.textContent = 'Showing general-purpose suitability across all zones.';
  }

  if (poisData) buildPoisLayer();
  loadRecommendation(selectedBusinessType);
});

// ── Location Search (Nominatim Geocoding) ────────────────────────────────────
function performSearch() {
  const query = document.getElementById('searchInput').value.trim();
  const status = document.getElementById('searchStatus');
  if (!query) return;

  status.textContent = 'Searching...';

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query + ', Osogbo, Osun State, Nigeria')}`;

  fetch(url, { headers: { 'Accept-Language': 'en' } })
    .then(res => res.json())
    .then(results => {
      if (results.length === 0) {
        status.textContent = `No results found for "${query}".`;
        return;
      }
      const r = results[0];
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      map.setView([lat, lon], 16);

      L.marker([lat, lon]).addTo(map)
        .bindPopup(`<b>${r.display_name}</b>`)
        .openPopup();

      status.textContent = `Found: ${r.display_name}`;
    })
    .catch(() => {
      status.textContent = 'Search failed. Check your connection.';
    });
}

document.getElementById('searchBtn').addEventListener('click', performSearch);
document.getElementById('searchInput').addEventListener('keypress', e => {
  if (e.key === 'Enter') performSearch();
});