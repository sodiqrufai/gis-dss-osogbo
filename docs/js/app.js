const API_BASE = "https://gis-dss-osogbo.onrender.com";

// ── Wake server on page load ──────────────────────────────────────────────
setTimeout(() => { fetch(`${API_BASE}/`).catch(() => {}); }, 500);

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  businessType: null, businessLabel: null, budget: 2500000,
  shopSize: 'small', customers: 'low', prefArea: '',
  avoidArea: '', competitorTolerance: 'avoid', priority: 'foot_traffic'
};

let resultMap = null;
let currentStep = 1;

// ── Load live stats ───────────────────────────────────────────────────────
fetch(`${API_BASE}/api/stats`)
  .then(r => r.json())
  .then(d => {
    if (d.total_zones) document.getElementById('stat-zones').textContent = d.total_zones;
    if (d.total_road_segments) document.getElementById('stat-roads').textContent = d.total_road_segments;
  }).catch(() => {});

// ── Business type selection ───────────────────────────────────────────────
function selectBiz(el) {
  document.querySelectorAll('.biz-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  state.businessType = el.dataset.value;
  state.businessLabel = el.querySelector('.biz-label').textContent;
}

// ── Budget slider ─────────────────────────────────────────────────────────
function updateBudget(val) {
  state.budget = parseInt(val);
  const formatted = new Intl.NumberFormat('en-NG', {
    style: 'currency', currency: 'NGN', maximumFractionDigits: 0
  }).format(val);
  document.getElementById('budgetDisplay').textContent = formatted;
  const pct = ((val - 500000) / (10000000 - 500000)) * 100;
  document.getElementById('budgetSlider').style.background =
    `linear-gradient(to right, var(--gold) ${pct}%, var(--border) ${pct}%)`;
}

// ── Toggle buttons ────────────────────────────────────────────────────────
function toggleSelect(el, groupId) {
  document.querySelectorAll(`#${groupId} .toggle-btn`).forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  if (groupId === 'sizeGroup') state.shopSize = el.dataset.value;
  if (groupId === 'custGroup') state.customers = el.dataset.value;
  if (groupId === 'compGroup') state.competitorTolerance = el.dataset.value;
  if (groupId === 'priorityGroup') state.priority = el.dataset.value;
}

// ── Step navigation ───────────────────────────────────────────────────────
function goStep(n) {
  if (n === 2 && !state.businessType) {
    alert('Please select a business type to continue.');
    return;
  }
  state.prefArea = document.getElementById('prefArea')?.value || '';
  state.avoidArea = document.getElementById('avoidArea')?.value || '';

  const cur = document.getElementById(`step-${currentStep}`);
  if (cur) cur.style.display = 'none';
  document.getElementById(`step-${n}`).style.display = 'block';

  for (let i = 1; i <= 4; i++) {
    const prog = document.getElementById(`prog-${i}`);
    prog.classList.remove('active', 'done');
    if (i < n) prog.classList.add('done');
    if (i === n) prog.classList.add('active');
  }
  currentStep = n;
  document.getElementById('wizard-section').scrollIntoView({ behavior: 'smooth' });
}

// ── Delay helper ──────────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Run Analysis with retry logic ─────────────────────────────────────────
async function runAnalysis() {
  state.prefArea = document.getElementById('prefArea')?.value || '';

  document.getElementById('step-3').style.display = 'none';
  document.getElementById('loading-screen').style.display = 'block';
  document.getElementById('prog-4').classList.add('active');

  const stepIds = ['ls-1', 'ls-2', 'ls-3', 'ls-4', 'ls-5'];
  const stepTexts = [
    'Querying spatial database',
    'Calculating competitor density',
    'Running AHP weighted overlay',
    'Applying ML suitability model',
    'Ranking best locations'
  ];

  // Animate loading steps
  for (let i = 0; i < stepIds.length; i++) {
    await delay(500);
    const el = document.getElementById(stepIds[i]);
    el.className = 'done';
    el.textContent = '✅ ' + stepTexts[i];
    if (i + 1 < stepIds.length) {
      const next = document.getElementById(stepIds[i + 1]);
      next.className = 'active';
      next.textContent = '⏳ ' + stepTexts[i + 1];
    }
  }

  await delay(400);

  // ── Fetch with retry (handles Render cold start) ──────────────────────
  let data = null;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const lastStep = document.getElementById('ls-5');
      if (attempt > 1) {
        lastStep.className = 'active';
        lastStep.textContent = `⏳ Server waking up, retrying... (${attempt}/${maxAttempts})`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 65000); // 65s timeout

      const res = await fetch(
        `${API_BASE}/api/recommend?type=${encodeURIComponent(state.businessType)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      data = await res.json();

      // Success
      document.getElementById('ls-5').className = 'done';
      document.getElementById('ls-5').textContent = '✅ Ranking best locations';
      break;

    } catch (e) {
      if (attempt < maxAttempts) {
        await delay(6000); // wait 6 seconds before retry
      }
    }
  }

  if (!data || !data.features) {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('step-3').style.display = 'block';
    alert('The analysis server is still starting up (this can take up to 60 seconds on first use). Please wait a moment and try again.');
    goStep(3);
    return;
  }

  // ── Compute final scores ──────────────────────────────────────────────
  const penaltyMap = { avoid: 10, neutral: 5, cluster: 0 };
  const penalty = penaltyMap[state.competitorTolerance] || 8;

  const sorted = data.features
    .map(f => ({ ...f, finalScore: computeFinalScore(f, penalty) }))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 3);

  showResults(sorted);
}

function computeFinalScore(feature, penaltyPerCompetitor) {
  const p = feature.properties;
  const base = p.composite_score || 0;
  const competitors = p.competitor_count || 0;
  const penalty = Math.min(competitors * penaltyPerCompetitor, 40);
  let boost = 0;
  if (state.priority === 'road_access' && p.ahp_score > 50) boost = 5;
  if (state.priority === 'population' && p.ml_score > 50) boost = 5;
  if (state.priority === 'low_competition' && competitors === 0) boost = 8;
  return Math.max(0, base - penalty + boost);
}

// ── Show Results ──────────────────────────────────────────────────────────
function showResults(zones) {
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('results-section').style.display = 'block';

  document.getElementById('results-title').textContent =
    `Top 3 Locations for Your ${state.businessLabel}`;
  document.getElementById('results-sub').textContent =
    `Analysed ${state.businessType} suitability across 131 zones in Osogbo · Budget: ${formatCurrency(state.budget)}`;

  initResultMap(zones);

  const grid = document.getElementById('locations-grid');
  grid.innerHTML = '';
  zones.forEach((zone, i) => {
    const p = zone.properties;
    const score = zone.finalScore;
    const rank = i + 1;
    const reason = generateReason(p, score, rank, i);
    const card = document.createElement('div');
    card.className = `location-card rank-${rank}`;
    card.onclick = () => flyToZone(zone, rank);
    card.innerHTML = `
      <div class="location-card-header">
        <div class="rank-badge">#${rank}</div>
        <div>
          <div class="location-zone">Zone ${p.zone_id}</div>
          <div class="location-score-row">
            <span class="location-score">${score.toFixed(1)}</span>
            <span class="location-score-max">/ 100</span>
          </div>
        </div>
      </div>
      <div class="score-bar">
        <div class="score-bar-fill" style="width:${score}%"></div>
      </div>
      <div class="location-body">
        <p class="location-reason">${reason}</p>
        <div class="location-tags">
          ${p.competitor_count > 0
            ? `<span class="loc-tag">⚠ ${p.competitor_count} competitor${p.competitor_count > 1 ? 's' : ''} nearby</span>`
            : '<span class="loc-tag">✅ No competitors</span>'}
          ${p.ahp_score > 50 ? '<span class="loc-tag">🛣 Good road access</span>' : ''}
          ${p.ml_score > 55 ? '<span class="loc-tag">🏘 High population</span>' : ''}
          <span class="loc-tag">AHP: ${(p.ahp_score || 0).toFixed(1)}</span>
          <span class="loc-tag">ML: ${(p.ml_score || 0).toFixed(1)}</span>
        </div>
      </div>`;
    grid.appendChild(card);
  });

  document.getElementById('detail-grid').innerHTML = `
    <div class="detail-stat">
      <span class="detail-stat-num">${zones[0].finalScore.toFixed(1)}</span>
      <div class="detail-stat-label">Top Zone Score</div>
    </div>
    <div class="detail-stat">
      <span class="detail-stat-num">${state.businessLabel.split('/')[0].trim()}</span>
      <div class="detail-stat-label">Business Type</div>
    </div>
    <div class="detail-stat">
      <span class="detail-stat-num">${formatCurrency(state.budget)}</span>
      <div class="detail-stat-label">Your Budget</div>
    </div>
    <div class="detail-stat">
      <span class="detail-stat-num">${zones.reduce((s, z) => s + (z.properties.competitor_count || 0), 0)}</span>
      <div class="detail-stat-label">Competitors in Top 3</div>
    </div>`;

  document.getElementById('wizard-section').scrollIntoView({ behavior: 'smooth' });
}

// ── Map ───────────────────────────────────────────────────────────────────
const RANK_COLORS = ['#c9922a', '#64748b', '#92400e'];

function initResultMap(zones) {
  if (resultMap) { resultMap.remove(); resultMap = null; }
  resultMap = L.map('result-map').setView([7.7700, 4.5600], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(resultMap);

  fetch(`${API_BASE}/api/suitability`)
    .then(r => r.json())
    .then(data => {
      L.geoJSON(data, {
        style: { fillColor: '#e5e7eb', weight: 0.5, color: '#9ca3af', fillOpacity: 0.4 }
      }).addTo(resultMap);

      zones.forEach((zone, i) => {
        const color = RANK_COLORS[i];
        L.geoJSON(zone, {
          style: { fillColor: color, weight: 2.5, color: color, fillOpacity: 0.7 }
        }).addTo(resultMap);

        const coords = zone.geometry.coordinates[0];
        const lats = coords.map(c => c[1]);
        const lngs = coords.map(c => c[0]);
        const lat = lats.reduce((a, b) => a + b, 0) / lats.length;
        const lng = lngs.reduce((a, b) => a + b, 0) / lngs.length;

        const icon = L.divIcon({
          html: `<div style="background:${color};color:white;width:32px;height:32px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3)"><span style="transform:rotate(45deg);font-weight:bold;font-size:13px">${i + 1}</span></div>`,
          className: '', iconSize: [32, 32], iconAnchor: [16, 32]
        });

        L.marker([lat, lng], { icon })
          .bindPopup(`<b>#${i + 1} Recommended Zone</b><br>Zone ID: ${zone.properties.zone_id}<br>Score: ${zone.finalScore.toFixed(1)}/100`)
          .addTo(resultMap);
      });

      const topGroup = L.geoJSON({ type: 'FeatureCollection', features: zones });
      resultMap.fitBounds(topGroup.getBounds().pad(0.3));
    }).catch(() => {});
}

function flyToZone(zone) {
  if (!resultMap) return;
  resultMap.fitBounds(L.geoJSON(zone).getBounds().pad(0.2), { maxZoom: 16 });
}

// ── Reason generator ──────────────────────────────────────────────────────
function generateReason(p, score, rank, idx) {
  const bizLabel = state.businessLabel;
  const competitors = p.competitor_count || 0;
  const ahp = p.ahp_score || 0;
  const ml = p.ml_score || 0;
  const reasons = [
    `This zone ranks highest for your ${bizLabel} with a composite score of ${score.toFixed(1)}/100. ${competitors === 0 ? 'No existing competitors were found here — giving you first-mover advantage.' : `With ${competitors} existing competitor${competitors > 1 ? 's' : ''}, the market is established but manageable.`} ${ahp > 50 ? 'Road accessibility is excellent.' : ''} ${ml > 55 ? 'High building density signals strong population catchment.' : ''}`,
    `Second-best option for your ${bizLabel}. ${ml > ahp ? 'The ML model rates this zone highly for population density.' : 'Strong road network accessibility makes this zone commercially attractive.'} ${competitors === 0 ? 'No direct competitors in this zone.' : `${competitors} existing ${bizLabel.toLowerCase()} business${competitors > 1 ? 'es' : ''} already operate here.`} Score: ${score.toFixed(1)}/100.`,
    `A solid third choice${score > 45 ? ' with above-average suitability' : ''}. ${ahp > 45 ? 'Good road proximity and connectivity.' : 'Moderate road access.'} ${competitors === 0 ? 'No competing businesses detected in this zone.' : `${competitors} competitor${competitors > 1 ? 's' : ''} present.`} Score: ${score.toFixed(1)}/100.`
  ];
  return reasons[idx] || reasons[2];
}

// ── Utilities ─────────────────────────────────────────────────────────────
function formatCurrency(n) {
  if (n >= 1000000) return `₦${(n / 1000000).toFixed(1)}M`;
  return `₦${(n / 1000).toFixed(0)}K`;
}

function restart() {
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('loading-screen').style.display = 'none';
  document.querySelectorAll('.biz-card').forEach(c => c.classList.remove('selected'));
  state.businessType = null; state.businessLabel = null;
  for (let i = 1; i <= 4; i++) {
    const p = document.getElementById(`prog-${i}`);
    p.classList.remove('active', 'done');
  }
  document.getElementById('prog-1').classList.add('active');

  // Reset loading steps text
  const stepTexts = [
    'Querying spatial database',
    'Calculating competitor density',
    'Running AHP weighted overlay',
    'Applying ML suitability model',
    'Ranking best locations'
  ];
  ['ls-1','ls-2','ls-3','ls-4','ls-5'].forEach((id, i) => {
    const el = document.getElementById(id);
    el.className = '';
    el.textContent = '⏳ ' + stepTexts[i];
  });

  document.getElementById('step-1').style.display = 'block';
  currentStep = 1;
  document.getElementById('wizard-section').scrollIntoView({ behavior: 'smooth' });
}