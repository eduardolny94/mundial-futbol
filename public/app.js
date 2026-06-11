// ============================================================================
//  Logica de "Mundial" (lado del navegador)
//  - Trae TODOS los partidos del Mundial en una sola llamada y los agrupa
//    por fecha, para que moverse entre dias NO gaste tu cuota diaria.
//  - Muestra el % de victoria en cada tarjeta de la portada.
//  - Al hacer clic en un partido: alineaciones, probabilidad, eventos y stats.
// ============================================================================

// Zona horaria del usuario (ej: "America/Caracas")
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Temporadas a intentar: primero el Mundial 2026; si aun no tiene calendario,
// usamos el 2022 como ejemplo para que se vea funcionando.
const PRIMARY_SEASON = 2026;
const FALLBACK_SEASON = 2022;

const el = {
  matches: document.getElementById('matches'),
  banner: document.getElementById('banner'),
  tagline: document.getElementById('tagline'),
  brandSeason: document.querySelector('.brand h1 span'),
  tzBadge: document.getElementById('tzBadge'),
  dateSelect: document.getElementById('dateSelect'),
  prevDay: document.getElementById('prevDay'),
  nextDay: document.getElementById('nextDay'),
  todayBtn: document.getElementById('todayBtn'),
  dayTitle: document.getElementById('dayTitle'),
  modal: document.getElementById('modal'),
  modalBody: document.getElementById('modalBody'),
  modalClose: document.getElementById('modalClose'),
  tabPartidos: document.getElementById('tabPartidos'),
  tabGroups: document.getElementById('tabGroups'),
  tabScorers: document.getElementById('tabScorers'),
  viewPartidos: document.getElementById('viewPartidos'),
  viewStats: document.getElementById('viewStats'),
  statsBoard: document.getElementById('statsBoard'),
  favBar: document.getElementById('favBar'),
  refreshBar: document.getElementById('refreshBar'),
  ed2026: document.getElementById('ed2026'),
  ed2022: document.getElementById('ed2022'),
};

// Edicion activa: '2026' = datos reales de Zafronix (calendario, plantillas);
// '2022' = API-Football (incluye alineaciones titulares y % de victoria).
let edition = '2026';

// Estado
let seasonUsed = PRIMARY_SEASON;
let byDate = new Map();      // "2026-06-11" -> [partidos]
let dates = [];             // lista ordenada de fechas con partidos
let teams = new Map();      // id -> {id, name, logo}  (todas las selecciones)
let selectedDate = null;
let currentFixtureId = null;
let currentMeta = null;
let currentSection = 'partidos';   // 'partidos' | 'groups' | 'scorers'
let groupsLoaded = false;
let scorersLoaded = false;
let refreshTimer = null;           // temporizador de auto-actualizacion

// Seleccion favorita (se guarda en el navegador con localStorage)
const FAV_KEY = 'mundial_fav_team';
let favTeam = loadFav();
function loadFav() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || null; } catch { return null; }
}
function saveFav(t) {
  favTeam = t;
  if (t) localStorage.setItem(FAV_KEY, JSON.stringify(t));
  else localStorage.removeItem(FAV_KEY);
}

// Cache de detalles por partido (para no repetir llamadas)
const detailCache = new Map();
const LIVE_TTL = 90 * 1000;

el.tzBadge.textContent = '🌍 ' + TZ;

// --------------------------------------------------------------------------
//  Utilidades de fecha y estado
// --------------------------------------------------------------------------
function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function dayKey(iso) {
  return String(iso).slice(0, 10);   // "2026-06-11T18:00:00+00:00" -> "2026-06-11"
}
function timeOnly(iso) {
  return new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}
function dateNice(iso) {
  return new Date(iso).toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
}
function dateFull(iso) {
  return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}
function dayLabel(dateStr) {
  // dateStr = "2026-06-11"; lo fijamos al mediodia para evitar saltos de huso
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}
function dayLabelShort(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function isLiveStatus(s) { return ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'].includes(s); }
function isFinishedStatus(s) { return ['FT', 'AET', 'PEN'].includes(s); }
function notStarted(s) { return ['NS', 'TBD', 'PST', 'CANC', 'SUSP', 'AWD', 'WO'].includes(s); }

// --------------------------------------------------------------------------
//  Llamadas a la API con manejo de errores uniforme
// --------------------------------------------------------------------------
async function apiGet(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error('No se pudo conectar con el servidor. ¿Está corriendo?');
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.response || [];
}
function spinnerHtml(msg) {
  return `<div class="placeholder"><div class="spinner"></div>${msg}</div>`;
}
function emptyHtml(icon, msg) {
  return `<div class="empty"><span class="big">${icon}</span>${msg}</div>`;
}
function errorNote(msg) {
  return `<div class="modal-note error">⚠️ ${msg}</div>`;
}

// --------------------------------------------------------------------------
//  Arranque: traer todos los partidos del Mundial
// --------------------------------------------------------------------------
async function init() {
  groupsLoaded = false;
  scorersLoaded = false;
  stopAutoRefresh();
  // La pestaña "Grupos" solo existe en el Mundial 2026
  el.tabGroups.classList.toggle('hidden', edition !== '2026');
  el.matches.innerHTML = spinnerHtml('Cargando partidos del Mundial…');
  try {
    let list;
    if (edition === '2026') {
      list = await apiGet('/api/wc2026');           // Zafronix: Mundial 2026 real
      seasonUsed = 2026;
      el.brandSeason.textContent = '2026';
      showBanner2026();
    } else {
      list = await apiGet(`/api/worldcup?season=2022&timezone=${encodeURIComponent(TZ)}`); // API-Football
      seasonUsed = 2022;
      el.brandSeason.textContent = '2022';
      showBanner2022();
    }

    if (!list.length) {
      el.matches.innerHTML = emptyHtml('🏆', 'Todavía no hay partidos disponibles.<br>Vuelve a intentarlo más tarde.');
      return;
    }

    groupByDate(list);
    buildTeams(list);
    buildDateNav();
    renderFavBar();
    showSection('partidos');
    selectDate(pickDefaultDate());
  } catch (e) {
    el.matches.innerHTML = `<div class="error-note">⚠️ ${e.message}<small>Revisa que tus claves estén en el archivo .env y que el servidor esté corriendo.</small></div>`;
  }
}

function showBanner2026() {
  el.banner.innerHTML = `✅ <strong>Mundial 2026 REAL</strong>: calendario completo, estadios, plantillas y grupos
    (datos de Zafronix). Las <strong>alineaciones titulares</strong> de cada partido y el <strong>% de victoria</strong>
    son de pago en las APIs; para verlas en acción, abre la pestaña <strong>📼 Mundial 2022</strong>.`;
  el.banner.classList.remove('hidden');
  el.tagline.textContent = 'Mundial 2026 · datos reales en vivo';
}

function showBanner2022() {
  el.banner.innerHTML = `📼 <strong>Mundial 2022</strong>: edición con datos completos —
    alineaciones titulares, % de victoria, eventos y estadísticas (API-Football). Útil para ver
    todas las funciones mientras el 2026 está en marcha.`;
  el.banner.classList.remove('hidden');
  el.tagline.textContent = 'Mundial 2022 · con alineaciones y %';
}

// Cambiar de edicion (2026 <-> 2022)
function setEdition(ed) {
  if (edition === ed) return;
  edition = ed;
  el.ed2026.classList.toggle('active', ed === '2026');
  el.ed2022.classList.toggle('active', ed === '2022');
  // Limpiamos caches y estado del anterior
  detailCache.clear();
  selectedDate = null;
  init();
}

// Construir la lista de todas las selecciones del torneo (para favoritos)
function buildTeams(list) {
  teams = new Map();
  for (const f of list) {
    for (const t of [f.teams.home, f.teams.away]) {
      if (t?.id && !teams.has(t.id)) teams.set(t.id, { id: t.id, name: t.name, logo: t.logo });
    }
  }
}

function groupByDate(list) {
  byDate = new Map();
  for (const f of list) {
    const k = dayKey(f.fixture.date);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(f);
  }
  // Ordenar cada dia por hora de inicio
  for (const arr of byDate.values()) {
    arr.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  }
  dates = [...byDate.keys()].sort();
}

// Elegir la fecha inicial: hoy si hay partidos; si no, el proximo dia con
// partidos; si todo es pasado (ej. 2022), el primer dia del torneo.
function pickDefaultDate() {
  const today = todayISO();
  if (byDate.has(today)) return today;
  const upcoming = dates.find((d) => d >= today);
  return upcoming || dates[0];
}

// --------------------------------------------------------------------------
//  Navegador de fechas
// --------------------------------------------------------------------------
function buildDateNav() {
  el.dateSelect.innerHTML = dates.map((d) => {
    const n = byDate.get(d).length;
    return `<option value="${d}">${cap(dayLabelShort(d))} · ${n} ${n === 1 ? 'partido' : 'partidos'}</option>`;
  }).join('');
}

function selectDate(date) {
  if (!date || !byDate.has(date)) return;
  selectedDate = date;
  el.dateSelect.value = date;

  const idx = dates.indexOf(date);
  el.prevDay.disabled = idx <= 0;
  el.nextDay.disabled = idx >= dates.length - 1;

  const matches = byDate.get(date);
  el.dayTitle.innerHTML = `<span class="dt-date">${cap(dayLabel(date))}</span>
    <span class="dt-count">${matches.length} ${matches.length === 1 ? 'partido' : 'partidos'}</span>`;

  renderDay(matches);
  maybeAutoRefresh();
}

// --------------------------------------------------------------------------
//  Auto-actualización (marcadores en vivo) — solo Mundial 2026 viendo "hoy"
// --------------------------------------------------------------------------
function hasLiveMatch(matches) {
  return (matches || []).some((f) => isLiveStatus(f.fixture.status.short));
}

function setRefreshBar(matches) {
  const live = hasLiveMatch(matches);
  el.refreshBar.classList.remove('hidden');
  el.refreshBar.innerHTML = `<span class="rb-dot ${live ? '' : 'off'}"></span> ` +
    (live ? 'Marcadores en vivo · se actualizan solos' : 'Actualización automática activada para hoy');
}

function maybeAutoRefresh() {
  stopAutoRefresh();
  const today = todayISO();
  if (edition === '2026' && selectedDate === today) {
    setRefreshBar(byDate.get(selectedDate) || []);
    refreshTimer = setInterval(refreshData, 90000); // cada 90 segundos
  } else {
    el.refreshBar.classList.add('hidden');
  }
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function refreshData() {
  try {
    const list = await apiGet('/api/wc2026');
    groupByDate(list);
    buildTeams(list);
    // Redibujar solo si seguimos en Partidos, en la misma fecha, y sin modal abierto
    if (currentSection === 'partidos' && selectedDate && byDate.has(selectedDate)
        && el.modal.classList.contains('hidden')) {
      renderDay(byDate.get(selectedDate));
      setRefreshBar(byDate.get(selectedDate));
    }
  } catch (e) {
    /* si falla una actualización, lo ignoramos en silencio */
  }
}

function pickToday() {
  const today = todayISO();
  if (byDate.has(today)) { selectDate(today); return; }
  // Si hoy no tiene partidos, vamos al dia mas cercano a hoy
  const future = dates.find((d) => d >= today);
  selectDate(future || dates[dates.length - 1]);
}

// --------------------------------------------------------------------------
//  Seleccion favorita
// --------------------------------------------------------------------------
function toggleFav(t) {
  if (favTeam && favTeam.id === t.id) saveFav(null);   // quitar si ya era la favorita
  else saveFav(t);
  renderFavBar();
  // Redibujar el dia para reordenar y resaltar
  if (selectedDate) renderDay(byDate.get(selectedDate));
}

function renderFavBar() {
  if (favTeam) {
    el.favBar.innerHTML = `<div class="fav-current">
        <span class="fav-label">⭐ Tu selección:</span>
        <img src="${favTeam.logo}" alt=""> <strong>${favTeam.name}</strong>
        <button class="fav-next" id="favNextBtn">📅 Próximo partido</button>
        <button class="fav-clear" id="favClearBtn" title="Quitar">✕</button>
      </div>`;
    document.getElementById('favNextBtn').addEventListener('click', gotoNextFavMatch);
    document.getElementById('favClearBtn').addEventListener('click', () => { saveFav(null); renderFavBar(); if (selectedDate) renderDay(byDate.get(selectedDate)); });
  } else {
    const opts = [...teams.values()].sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
    el.favBar.innerHTML = `<div class="fav-choose">
        <span class="fav-label">⭐ Elige tu selección favorita:</span>
        <select id="favSelect"><option value="">— Selecciona —</option>${opts}</select>
        <span class="fav-hint">o toca la ★ junto a un equipo</span>
      </div>`;
    document.getElementById('favSelect').addEventListener('change', (e) => {
      const t = teams.get(+e.target.value);
      if (t) toggleFav(t);
    });
  }
}

// Saltar al proximo partido de la seleccion favorita (o el ultimo si ya pasaron)
function gotoNextFavMatch() {
  if (!favTeam) return;
  const today = todayISO();
  const hasFav = (d) => byDate.get(d).some((f) => f.teams.home.id === favTeam.id || f.teams.away.id === favTeam.id);
  const favDates = dates.filter(hasFav);
  if (!favDates.length) return;
  const next = favDates.find((d) => d >= today) || favDates[favDates.length - 1];
  showSection('partidos');
  selectDate(next);
}

// --------------------------------------------------------------------------
//  Cambio de vista: Partidos <-> Estadisticas
// --------------------------------------------------------------------------
function showSection(section) {
  currentSection = section;
  const isPartidos = section === 'partidos';
  el.viewPartidos.classList.toggle('hidden', !isPartidos);
  el.viewStats.classList.toggle('hidden', isPartidos);
  el.tabPartidos.classList.toggle('active', section === 'partidos');
  el.tabGroups.classList.toggle('active', section === 'groups');
  el.tabScorers.classList.toggle('active', section === 'scorers');
  if (section === 'groups' && !groupsLoaded) loadGroupsView();
  if (section === 'scorers' && !scorersLoaded) loadScorers();
}

// Goleadores: en 2022 vienen de API-Football; en 2026 de Zafronix (se llenan
// conforme avanza el torneo).
function loadScorers() {
  return edition === '2026' ? loadScorers2026() : loadStats();
}

async function loadScorers2026() {
  el.statsBoard.innerHTML = spinnerHtml('Cargando goleadores…');
  try {
    const scorers = await apiGet('/api/wc2026/scorers');
    scorersLoaded = true;
    if (!scorers.length) {
      el.statsBoard.innerHTML = `<div class="rank-col" style="grid-column:1/-1">
        <h3>⚽ Goleadores · Mundial 2026</h3>
        ${emptyHtml('⏳', 'El Mundial 2026 arranca el <strong>11 de junio</strong>.<br>La tabla de goleadores se irá llenando sola en cuanto se marquen los primeros goles. ¡Vuelve pronto!')}
      </div>`;
      return;
    }
    el.statsBoard.innerHTML = rankingHtml('⚽ Goleadores · Mundial 2026',
      scorers.map((s) => ({ player: { name: s.player, photo: '' }, statistics: [{ team: { name: s.team, logo: s.logo }, goals: { total: s.goals, assists: s.assists } }] })),
      (st) => st.goals.total, 'goles');
  } catch (e) {
    el.statsBoard.innerHTML = `<div class="error-note">⚠️ ${e.message}<small>No se pudieron cargar los goleadores.</small></div>`;
  }
}

// (2026) Vista de los 12 grupos con su clasificación
async function loadGroupsView() {
  el.statsBoard.innerHTML = spinnerHtml('Cargando los 12 grupos…');
  try {
    const groups = await apiGet('/api/wc2026/groups');
    groupsLoaded = true;
    const letters = Object.keys(groups).sort();
    if (!letters.length) {
      el.statsBoard.innerHTML = emptyHtml('🏆', 'Aún no hay grupos disponibles.');
      return;
    }
    el.statsBoard.innerHTML = `<div class="groups-board">` + letters.map((L) => `
      <div class="group-card">
        <h3>Grupo ${L}</h3>
        ${groupTableHtml(groups[L] || [])}
      </div>`).join('') + `</div>`;
  } catch (e) {
    el.statsBoard.innerHTML = `<div class="error-note">⚠️ ${e.message}<small>No se pudieron cargar los grupos.</small></div>`;
  }
}

// --------------------------------------------------------------------------
//  Estadisticas del Mundial: goleadores y asistidores (lazy + cache)
// --------------------------------------------------------------------------
async function loadStats() {
  el.statsBoard.innerHTML = spinnerHtml('Cargando goleadores y asistidores…');
  try {
    const [scorers, assists] = await Promise.all([
      apiGet(`/api/topscorers?season=${seasonUsed}`),
      apiGet(`/api/topassists?season=${seasonUsed}`),
    ]);
    scorersLoaded = true;
    el.statsBoard.innerHTML =
      rankingHtml('⚽ Goleadores', scorers, (st) => st.goals.total, 'goles') +
      rankingHtml('🅰️ Asistidores', assists, (st) => st.goals.assists, 'asistencias');
  } catch (e) {
    el.statsBoard.innerHTML = `<div class="error-note">⚠️ ${e.message}<small>No se pudieron cargar las estadísticas. Inténtalo más tarde.</small></div>`;
  }
}

function rankingHtml(title, list, valueOf, unit) {
  if (!list || !list.length) {
    return `<div class="rank-col"><h3>${title}</h3>${emptyHtml('📊', 'No hay datos disponibles para esta edición.')}</div>`;
  }
  const top = list.slice(0, 15);
  const row = (p, i) => {
    const st = p.statistics[0] || {};
    const val = valueOf(st) ?? 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
    return `<div class="rank-row" style="animation-delay:${Math.min(i * 35, 450)}ms">
      <span class="rk-pos">${medal}</span>
      <img class="rk-photo" src="${p.player.photo}" alt="" onerror="this.style.visibility='hidden'">
      <div class="rk-info">
        <span class="rk-name">${p.player.name}</span>
        <span class="rk-team"><img src="${st.team?.logo || ''}" alt="">${st.team?.name || ''}</span>
      </div>
      <span class="rk-val">${val}<small>${unit === 'goles' ? 'g' : 'a'}</small></span>
    </div>`;
  };
  return `<div class="rank-col">
    <h3>${title}</h3>
    <div class="rank-list">${top.map(row).join('')}</div>
  </div>`;
}

// --------------------------------------------------------------------------
//  Dibujar los partidos del dia + cargar el % de victoria de cada uno
// --------------------------------------------------------------------------
function renderDay(matches) {
  // Si hay seleccion favorita, sus partidos van primero
  const ordered = [...matches].sort((a, b) => favScore(b) - favScore(a));
  el.matches.innerHTML = `<div class="day-grid">${ordered.map(matchCard).join('')}</div>`;

  document.querySelectorAll('.match-card').forEach((c) => {
    c.addEventListener('click', () => {
      openMatch(c.dataset.fixture, JSON.parse(decodeURIComponent(c.dataset.meta)));
    });
  });

  // Estrellas para marcar seleccion favorita (sin abrir el partido)
  document.querySelectorAll('.fav-star').forEach((s) => {
    s.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav({ id: +s.dataset.id, name: s.dataset.name, logo: s.dataset.logo });
    });
  });

  // El % de victoria solo está disponible en la edición 2022 (API-Football)
  if (edition === '2022') hydrateProbabilities(ordered);
}

function favScore(f) {
  if (!favTeam) return 0;
  return (f.teams.home.id === favTeam.id || f.teams.away.id === favTeam.id) ? 1 : 0;
}

function matchCard(f, index = 0) {
  const status = f.fixture.status.short;
  const isLive = isLiveStatus(status);
  const isDone = isFinishedStatus(status);
  const locked = f.fixture.locked;   // marcador en vivo bloqueado (Zafronix gratis)

  let statusLabel, statusClass = '';
  if (status === 'HT') { statusLabel = 'ENTRETIEMPO'; statusClass = 'live'; }
  else if (isLive) { statusLabel = f.fixture.status.elapsed ? f.fixture.status.elapsed + "'" : 'EN VIVO'; statusClass = 'live'; }
  else if (isDone) { statusLabel = 'Final'; statusClass = 'finished'; }
  else { statusLabel = timeOnly(f.fixture.date); }

  const hs = f.goals.home, as = f.goals.away;
  const homeWin = hs != null && as != null && hs > as;
  const awayWin = hs != null && as != null && as > hs;
  const showScore = hs != null && as != null;

  const meta = encodeURIComponent(JSON.stringify({
    home: f.teams.home, away: f.teams.away,
    league: f.league, date: f.fixture.date,
    goals: f.goals, status: f.fixture.status, venue: f.fixture.venue,
  }));

  const round = f.league?.round ? `<span class="round">${translateRound(f.league.round)}</span>` : '';
  const isFav = favTeam && (f.teams.home.id === favTeam.id || f.teams.away.id === favTeam.id);
  const ven = f.fixture.venue;
  const venue = ven?.name ? `🏟️ ${ven.name}${ven.city ? ' · ' + ven.city : ''}` : '';

  const teamRow = (t, win) => `<div class="team-row ${win ? 'winner' : ''} ${favTeam && t.id === favTeam.id ? 'is-fav' : ''}">
      ${t.logo
        ? `<button class="fav-star ${favTeam && t.id === favTeam.id ? 'on' : ''}" data-id="${t.id}" data-name="${t.name}" data-logo="${t.logo}" title="Marcar como mi selección">★</button>`
        : '<span class="fav-star-gap"></span>'}
      <img src="${t.logo || ''}" alt="" onerror="this.style.visibility='hidden'">
      <span class="name ${t.logo ? '' : 'tbd'}">${t.name}</span>
      <span class="score">${showScore ? (t.id === f.teams.home.id ? hs : as) : ''}</span>
    </div>`;

  return `<div class="match-card ${isFav ? 'fav-card' : ''}" data-fixture="${f.fixture.id}" data-meta="${meta}" style="animation-delay:${Math.min(index * 45, 400)}ms">
    <div class="card-top">
      ${round}
      <span class="status ${statusClass}">${statusLabel}</span>
    </div>
    <div class="teams">
      ${teamRow(f.teams.home, homeWin)}
      ${teamRow(f.teams.away, awayWin)}
    </div>
    ${edition === '2022'
      ? `<div class="card-prob" id="prob-${f.fixture.id}"><div class="cp-loading">Calculando probabilidad…</div></div>`
      : ''}
    ${(isLive && locked)
      ? `<div class="card-live-note">🔴 En juego · el marcador en vivo es función de pago; se mostrará al finalizar</div>`
      : ''}
    ${venue ? `<div class="card-venue">${venue}</div>` : ''}
    <div class="card-foot">
      <span>${dateNice(f.fixture.date)} · ${timeOnly(f.fixture.date)}</span>
      <span class="vs-hint">${edition === '2026' ? 'Plantillas →' : 'Alineaciones →'}</span>
    </div>
  </div>`;
}

// Traduce nombres tipico de rondas del Mundial
function translateRound(r) {
  return r
    .replace('Group Stage', 'Fase de grupos')
    .replace(/Group /, 'Grupo ')
    .replace('Round of 16', 'Octavos de final')
    .replace('Quarter-finals', 'Cuartos de final')
    .replace('Semi-finals', 'Semifinales')
    .replace('3rd Place Final', 'Tercer puesto')
    .replace('Final', 'Final')
    .replace(' - ', ' · ');
}

// Carga el % de victoria de cada tarjeta visible (lazy + cache)
async function hydrateProbabilities(matches) {
  await Promise.all(matches.map(async (f) => {
    const box = document.getElementById('prob-' + f.fixture.id);
    if (!box) return;
    try {
      const pred = await getDetailFor(f.fixture.id, 'predictions', '/api/predictions?fixture=' + f.fixture.id, f.fixture.status?.short);
      // Si el usuario ya cambio de dia, este box quizas ya no existe
      const stillHere = document.getElementById('prob-' + f.fixture.id);
      if (stillHere) stillHere.innerHTML = cardProbHtml(pred, f.teams);
    } catch (e) {
      const stillHere = document.getElementById('prob-' + f.fixture.id);
      if (stillHere) stillHere.innerHTML = `<div class="cp-none">Probabilidad no disponible</div>`;
    }
  }));
}

function cardProbHtml(resp, teams) {
  const p = resp && resp[0];
  if (!p || !p.predictions || !p.predictions.percent) {
    return `<div class="cp-none">El % aparece cuando se acerca el partido</div>`;
  }
  const pc = p.predictions.percent;
  const home = parseInt(pc.home) || 0;
  const draw = parseInt(pc.draw) || 0;
  const away = parseInt(pc.away) || 0;
  const fav = home >= away && home >= draw ? 'home' : (away >= home && away >= draw ? 'away' : 'draw');

  return `<div class="cp-head">
      <span class="cp-pct home ${fav === 'home' ? 'fav' : ''}">${home}%</span>
      <span class="cp-mid">probabilidad de victoria</span>
      <span class="cp-pct away ${fav === 'away' ? 'fav' : ''}">${away}%</span>
    </div>
    <div class="cp-bar">
      <div class="cp-seg home" style="width:${home}%"></div>
      <div class="cp-seg draw" style="width:${draw}%"></div>
      <div class="cp-seg away" style="width:${away}%"></div>
    </div>
    <div class="cp-foot"><span>${teams.home.name}</span><span>Empate ${draw}%</span><span>${teams.away.name}</span></div>`;
}

// --------------------------------------------------------------------------
//  Detalle del partido (modal con pestañas, carga lazy de cada una)
// --------------------------------------------------------------------------
function openMatch(fixtureId, meta) {
  currentFixtureId = fixtureId;
  currentMeta = meta;

  el.modal.classList.remove('hidden');

  let tabs, first;
  if (edition === '2026') {
    tabs = `<button class="mtab active" data-tab="plantillas">👕 Alineaciones</button>
      <button class="mtab" data-tab="grupo">🏆 Grupo</button>`;
    first = 'plantillas';
  } else {
    tabs = `<button class="mtab active" data-tab="alineaciones">👕 Alineaciones</button>
      <button class="mtab" data-tab="probabilidad">📊 Probabilidad</button>
      <button class="mtab" data-tab="eventos">⚽ Eventos</button>
      <button class="mtab" data-tab="stats">📈 Estadísticas</button>
      <button class="mtab" data-tab="h2h">🆚 Cara a cara</button>`;
    first = 'alineaciones';
  }

  el.modalBody.innerHTML = headHtml(meta) +
    `<div class="mtabs">${tabs}</div><div class="mtab-content" id="mtabContent"></div>`;

  el.modalBody.querySelectorAll('.mtab').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  switchTab(first);
}

function closeModal() {
  el.modal.classList.add('hidden');
  currentFixtureId = null;
  currentMeta = null;
}

function switchTab(name) {
  el.modalBody.querySelectorAll('.mtab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  const box = document.getElementById('mtabContent');
  if (!box) return;
  const loaders = {
    alineaciones: tabAlineaciones, probabilidad: tabProbabilidad,
    eventos: tabEventos, stats: tabStats, h2h: tabH2H,
    plantillas: tabPlantillas, grupo: tabGrupo,
  };
  loaders[name]?.(box);
}

// ---------- (2026) Pestaña Plantillas: jugadores de cada selección ----------
const POS_ES = { Goalkeeper: 'POR', Defender: 'DEF', Midfielder: 'MED', Forward: 'DEL', GK: 'POR', DF: 'DEF', MF: 'MED', FW: 'DEL' };
function posEs(p) { return POS_ES[p] || p || ''; }

async function tabPlantillas(box) {
  box.innerHTML = spinnerHtml('Cargando alineaciones…');
  const m = currentMeta, id = currentFixtureId;
  try {
    const [match, home, away] = await Promise.all([
      getDetail('matchLineup', '/api/wc2026/match?id=' + encodeURIComponent(id)),
      m.home.logo ? getDetail('squadHome', '/api/wc2026/team?name=' + encodeURIComponent(m.home.name)) : Promise.resolve([]),
      m.away.logo ? getDetail('squadAway', '/api/wc2026/team?name=' + encodeURIComponent(m.away.name)) : Promise.resolve([]),
    ]);
    if (currentFixtureId !== id) return;
    box.innerHTML = lineup2026Html(match, home[0], away[0], m);
  } catch (e) {
    if (currentFixtureId === id) box.innerHTML = errorNote(e.message);
  }
}

function lineup2026Html(match, homeTeam, awayTeam, m) {
  const lu = match && match.lineups;
  const hasLineups = lu && ((lu.home && lu.home.length) || (lu.away && lu.away.length));

  if (hasLineups) {
    const note = match.locked
      ? `<div class="modal-note" style="margin-top:14px">🔴 El partido está en juego. Los <strong>cambios</strong> (quién entra y sale), goles, tarjetas y el marcador en vivo son función de pago de Zafronix; aquí ves las <strong>alineaciones titulares confirmadas</strong>.</div>`
      : `<div class="modal-note" style="margin-top:14px">✅ Alineaciones titulares confirmadas. Los cambios durante el partido requieren el plan de pago de Zafronix.</div>`;
    return `<div class="lineups">
        ${lineupSide(lu.home, match.formations?.home, match.managers?.home, m.home, homeTeam)}
        ${lineupSide(lu.away, match.formations?.away, match.managers?.away, m.away, awayTeam)}
      </div>${note}`;
  }

  // Aún no hay alineación publicada: mostramos la convocatoria (plantilla)
  return `<div class="modal-note">Las <strong>alineaciones titulares</strong> se publican aproximadamente <strong>40 a 60 minutos antes</strong> del partido. Mientras tanto, esta es la convocatoria de cada selección.</div>
    <div class="lineups">${squadCol(homeTeam, m.home)}${squadCol(awayTeam, m.away)}</div>`;
}

function lineupSide(players, formation, manager, mt, teamFull) {
  const starters = (players || []).filter((p) => p.starter !== false);
  // "Resto de la convocatoria": jugadores del squad que no son titulares
  const starterNames = new Set(starters.map((p) => (p.player || '').toLowerCase()));
  const rest = ((teamFull && teamFull.squad) || []).filter((p) => !starterNames.has((p.name || '').toLowerCase()));
  return `<div class="lineup-col">
    <h4><img src="${teamFull?.flag?.flagUrl || mt.logo || ''}" alt="" onerror="this.style.visibility='hidden'">${mt.name}</h4>
    <div class="formation">Formación: ${formation || '—'}</div>
    <div class="coach">👔 DT: ${manager || teamFull?.coach?.name || '—'}</div>
    <div class="ll-label">⚽ Titulares (${starters.length})</div>
    ${starters.map((p) => `<div class="player"><span class="num">${p.number ?? '·'}</span>${p.player}${p.captain ? ' <span class="cap">Ⓒ</span>' : ''}<span class="pos">${posEs(p.position)}</span></div>`).join('')}
    ${rest.length ? `<div class="ll-label">Resto de la convocatoria (${rest.length})</div>` +
      rest.slice(0, 15).map((p) => `<div class="player sub"><span class="num">${p.jersey ?? '·'}</span>${p.name}<span class="pos">${posEs(p.position)}</span></div>`).join('') : ''}
  </div>`;
}

function squadCol(t, mt) {
  if (!t) {
    return `<div class="lineup-col">
      <h4><span class="name tbd">${mt.name}</span></h4>
      <div class="modal-note">Rival aún por definir (depende de cómo termine la fase de grupos).</div>
    </div>`;
  }
  const players = t.squad || [];
  return `<div class="lineup-col">
    <h4><img src="${t.flag?.flagUrl || mt.logo || ''}" alt="" onerror="this.style.visibility='hidden'">${t.name}</h4>
    <div class="coach">👔 DT: ${t.coach?.name || '—'}</div>
    <div class="ll-label">Plantilla (${players.length} jugadores)</div>
    ${players.map((p) => `<div class="player"><span class="num">${p.jersey ?? '·'}</span>${p.name}<span class="pos">${posEs(p.position)}</span></div>`).join('')}
  </div>`;
}

// ---------- (2026) Pestaña Grupo: clasificación del grupo del partido ----------
async function tabGrupo(box) {
  const m = currentMeta, id = currentFixtureId;
  const gm = (m.league?.round || '').match(/Grupo ([A-L])/);
  if (!gm) {
    box.innerHTML = emptyHtml('🏆', 'Este es un partido de <strong>fase eliminatoria</strong>.<br>La tabla del grupo aplica solo a la fase de grupos.');
    return;
  }
  box.innerHTML = spinnerHtml('Cargando grupo…');
  try {
    const groups = await getDetail('groups', '/api/wc2026/groups');
    if (currentFixtureId !== id) return;
    box.innerHTML = `<div class="section-title">Grupo ${gm[1]}</div>` +
      groupTableHtml(groups[gm[1]] || [], [m.home.name, m.away.name]);
  } catch (e) {
    if (currentFixtureId === id) box.innerHTML = errorNote(e.message);
  }
}

function groupTableHtml(rows, highlight = []) {
  if (!rows.length) return emptyHtml('🏆', 'No hay datos del grupo todavía.');
  const sorted = [...rows].sort((a, b) =>
    (b.points - a.points) || ((b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst)) || a.name.localeCompare(b.name));
  const hi = highlight.map((s) => (s || '').toLowerCase());
  const tr = (t, i) => `<tr class="${hi.includes((t.name || '').toLowerCase()) ? 'gr-hi' : ''} ${i < 2 ? 'zone-top' : ''}">
      <td>${i + 1}</td>
      <td class="t-left"><span class="st-team"><img src="${t.logo}" alt="" onerror="this.style.visibility='hidden'">${t.name}</span></td>
      <td>${t.played ?? 0}</td><td>${t.won ?? 0}</td><td>${t.drawn ?? 0}</td><td>${t.lost ?? 0}</td>
      <td class="st-pts">${t.points ?? 0}</td>
    </tr>`;
  return `<div class="standings-table-wrap"><table class="standings-table">
      <thead><tr><th>#</th><th class="t-left">Equipo</th><th>PJ</th><th>G</th><th>E</th><th>P</th><th>Pts</th></tr></thead>
      <tbody>${sorted.map(tr).join('')}</tbody>
    </table></div>
    <div class="modal-note" style="margin-top:10px">Los 2 primeros de cada grupo (y los 8 mejores terceros) avanzan a la fase eliminatoria.</div>`;
}

// Pide un dato del partido con cache (caducidad corta si esta en vivo)
function getDetail(key, url) {
  return getDetailFor(currentFixtureId, key, url, currentMeta?.status?.short);
}
async function getDetailFor(id, key, url, statusShort) {
  let entry = detailCache.get(id);
  if (!entry) { entry = { _ts: {} }; detailCache.set(id, entry); }

  const live = isLiveStatus(statusShort);
  const fresh = entry[key] !== undefined &&
    (!live || (Date.now() - (entry._ts[key] || 0)) < LIVE_TTL);
  if (fresh) return entry[key];

  const data = await apiGet(url);
  entry[key] = data;
  entry._ts[key] = Date.now();
  return data;
}

// ---------- Pestaña Alineaciones (la principal) ----------
async function tabAlineaciones(box) {
  box.innerHTML = spinnerHtml('Cargando alineaciones…');
  const id = currentFixtureId;
  try {
    const lineups = await getDetail('lineups', '/api/lineups?fixture=' + id);
    if (currentFixtureId !== id) return;
    box.innerHTML = lineupHtml(lineups);
  } catch (e) {
    if (currentFixtureId !== id) return;
    box.innerHTML = errorNote(e.message);
  }
}

function lineupHtml(lus) {
  if (!lus || !lus.length) {
    return `<div class="modal-note">Las alineaciones se publican aproximadamente <strong>20 a 40 minutos antes</strong> del inicio del partido. Vuelve a abrir esta ventana entonces.</div>`;
  }
  const col = (lu) => {
    const players = (lu.startXI || []).map((x) => x.player);
    const subs = (lu.substitutes || []).map((x) => x.player);
    return `<div class="lineup-col">
      <h4><img src="${lu.team.logo}" alt="">${lu.team.name}</h4>
      <div class="formation">Formación: ${lu.formation || '—'}</div>
      <div class="coach">👔 DT: ${lu.coach?.name || '—'}</div>
      <div class="ll-label">Titulares</div>
      ${players.map((pl) => `<div class="player"><span class="num">${pl.number ?? '·'}</span>${pl.name} <span class="pos">${pl.pos || ''}</span></div>`).join('')}
      ${subs.length ? `<div class="ll-label">Suplentes</div>` + subs.slice(0, 9).map((pl) => `<div class="player sub"><span class="num">${pl.number ?? '·'}</span>${pl.name}</div>`).join('') : ''}
    </div>`;
  };
  return `<div class="lineups">${lus.map(col).join('')}</div>`;
}

// ---------- Pestaña Probabilidad ----------
async function tabProbabilidad(box) {
  box.innerHTML = spinnerHtml('Cargando probabilidades…');
  const id = currentFixtureId, m = currentMeta;
  try {
    const pred = await getDetail('predictions', '/api/predictions?fixture=' + id);
    if (currentFixtureId !== id) return;
    box.innerHTML = predictionHtml(pred, m);
  } catch (e) {
    if (currentFixtureId !== id) return;
    box.innerHTML = errorNote(e.message);
  }
}

function predictionHtml(resp, m) {
  const p = resp && resp[0];
  if (!p || !p.predictions || !p.predictions.percent) {
    return `<div class="prob-block"><div class="prob-title">Probabilidad de victoria</div>
      <div class="modal-note">Aún no hay predicción disponible para este partido (suele aparecer en los días previos).</div></div>`;
  }
  const pc = p.predictions.percent;
  const home = parseInt(pc.home) || 0;
  const draw = parseInt(pc.draw) || 0;
  const away = parseInt(pc.away) || 0;
  const advice = p.predictions.advice
    ? `<div class="modal-note" style="margin-top:14px">💡 Sugerencia del modelo: <strong>${p.predictions.advice}</strong></div>` : '';
  const cmp = p.comparison ? comparisonHtml(p.comparison, m) : '';

  return `<div class="prob-block">
    <div class="prob-title">Probabilidad de victoria</div>
    <div class="prob-bar">
      <div class="prob-seg home" style="width:${home}%">${home >= 8 ? home + '%' : ''}</div>
      <div class="prob-seg draw" style="width:${draw}%">${draw >= 8 ? draw + '%' : ''}</div>
      <div class="prob-seg away" style="width:${away}%">${away >= 8 ? away + '%' : ''}</div>
    </div>
    <div class="prob-legend">
      <span>🟢 ${m.home.name} ${home}%</span>
      <span>⚪ Empate ${draw}%</span>
      <span>🔵 ${m.away.name} ${away}%</span>
    </div>
    ${advice}
    ${cmp}
  </div>`;
}

// Comparativa (fuerza, forma, ataque, defensa) que da el modelo
function comparisonHtml(c, m) {
  const rows = [
    ['Forma', c.form], ['Ataque', c.att], ['Defensa', c.def],
    ['Fuerza general', c.total],
  ].filter(([, v]) => v && v.home);
  if (!rows.length) return '';
  const row = ([label, v]) => {
    const h = parseInt(v.home) || 0, a = parseInt(v.away) || 0;
    return `<div class="cmp-row">
      <span class="cmp-v ${h >= a ? 'lead' : ''}">${v.home}</span>
      <span class="cmp-label">${label}</span>
      <span class="cmp-v ${a >= h ? 'lead' : ''}">${v.away}</span>
    </div>
    <div class="cmp-track"><div class="cmp-fill home" style="width:${h}%"></div><div class="cmp-fill away" style="width:${a}%"></div></div>`;
  };
  return `<div class="section-title">Comparativa de los equipos</div>
    <div class="cmp-teams"><span>${m.home.name}</span><span>${m.away.name}</span></div>
    <div class="cmp-grid">${rows.map(row).join('')}</div>`;
}

// ---------- Pestaña Eventos: linea de tiempo ----------
async function tabEventos(box) {
  const m = currentMeta;
  if (notStarted(m.status?.short)) {
    box.innerHTML = emptyHtml('⏳', 'El partido aún no ha comenzado.<br>Aquí verás los goles, tarjetas y cambios en cuanto ruede el balón.');
    return;
  }
  box.innerHTML = spinnerHtml('Cargando eventos del partido…');
  const id = currentFixtureId;
  try {
    const events = await getDetail('events', '/api/events?fixture=' + id);
    if (currentFixtureId !== id) return;
    box.innerHTML = eventsHtml(events, m);
  } catch (e) {
    if (currentFixtureId !== id) return;
    box.innerHTML = errorNote(e.message);
  }
}

function eventsHtml(events, m) {
  if (!events || !events.length) {
    return emptyHtml('📭', 'Todavía no hay eventos registrados para este partido.');
  }
  const sorted = [...events].sort((a, b) =>
    (a.time.elapsed + (a.time.extra || 0) / 100) - (b.time.elapsed + (b.time.extra || 0) / 100));

  const item = (ev, i) => {
    const isHome = ev.team?.id === m.home.id;
    const side = isHome ? 'home' : 'away';
    const minute = ev.time.elapsed + (ev.time.extra ? `+${ev.time.extra}` : '') + "'";
    let icon = '•', cls = '', detail = ev.detail || '';
    const type = (ev.type || '').toLowerCase();
    if (type === 'goal') {
      cls = 'goal'; icon = '⚽';
      if (/own/i.test(detail)) { detail = 'Gol en propia puerta'; }
      else if (/penalty/i.test(detail) && /missed/i.test(detail)) { icon = '❌'; detail = 'Penal fallado'; cls = ''; }
      else if (/penalty/i.test(detail)) { detail = 'Gol de penal'; }
      else { detail = 'Gol'; }
      if (ev.assist?.name && cls === 'goal' && !/propia/.test(detail)) detail += ` · Asiste: ${ev.assist.name}`;
    } else if (type === 'card') {
      if (/red/i.test(detail)) { icon = '🟥'; cls = 'red'; detail = 'Tarjeta roja'; }
      else { icon = '🟨'; detail = 'Tarjeta amarilla'; }
    } else if (type === 'subst') {
      icon = '🔄'; detail = ev.assist?.name ? `Cambio · ${ev.assist.name}` : 'Cambio';
    } else if (type === 'var') {
      icon = '📺'; detail = 'VAR: ' + (ev.detail || 'revisión');
    }
    const body = `<div class="e-body ${side}">
      <span class="e-main">${isHome ? `${ev.player?.name || '—'} ${icon}` : `${icon} ${ev.player?.name || '—'}`}</span>
      <span class="e-detail">${detail}</span>
    </div>`;
    return `<div class="evt ${cls}" style="animation-delay:${Math.min(i * 40, 500)}ms">
      ${isHome ? body : '<span></span>'}
      <span class="e-min">${minute}</span>
      ${isHome ? '<span></span>' : body}
    </div>`;
  };

  return `<div class="stats-teams">
      <span class="tm"><img src="${m.home.logo}" alt=""> ${m.home.name}</span>
      <span class="tm">${m.away.name} <img src="${m.away.logo}" alt=""></span>
    </div>
    <div class="timeline">${sorted.map(item).join('')}</div>`;
}

// ---------- Pestaña Estadisticas: barras comparativas ----------
const STAT_NAMES = {
  'Shots on Goal': 'Tiros a puerta', 'Shots off Goal': 'Tiros fuera',
  'Total Shots': 'Tiros totales', 'Blocked Shots': 'Tiros bloqueados',
  'Shots insidebox': 'Tiros dentro del área', 'Shots outsidebox': 'Tiros fuera del área',
  'Fouls': 'Faltas', 'Corner Kicks': 'Córners', 'Offsides': 'Fueras de juego',
  'Ball Possession': 'Posesión del balón', 'Yellow Cards': 'Tarjetas amarillas',
  'Red Cards': 'Tarjetas rojas', 'Goalkeeper Saves': 'Paradas del portero',
  'Total passes': 'Pases totales', 'Passes accurate': 'Pases precisos',
  'Passes %': 'Precisión de pases', 'expected_goals': 'Goles esperados (xG)',
};

async function tabStats(box) {
  const m = currentMeta;
  if (notStarted(m.status?.short)) {
    box.innerHTML = emptyHtml('⏳', 'El partido aún no ha comenzado.<br>Las estadísticas aparecerán durante el encuentro.');
    return;
  }
  box.innerHTML = spinnerHtml('Cargando estadísticas…');
  const id = currentFixtureId;
  try {
    const stats = await getDetail('stats', '/api/stats?fixture=' + id);
    if (currentFixtureId !== id) return;
    box.innerHTML = statsHtml(stats, m);
  } catch (e) {
    if (currentFixtureId !== id) return;
    box.innerHTML = errorNote(e.message);
  }
}

function statsHtml(stats, m) {
  if (!stats || stats.length < 2) {
    return emptyHtml('📊', 'Todavía no hay estadísticas disponibles para este partido.');
  }
  const homeSide = stats.find((s) => s.team?.id === m.home.id) || stats[0];
  const awaySide = stats.find((s) => s.team?.id === m.away.id) || stats[1];
  const num = (v) => (v == null ? 0 : (typeof v === 'string' ? parseFloat(v) || 0 : v));
  const show = (v) => (v == null ? '0' : String(v));

  const awayMap = {};
  for (const s of awaySide.statistics || []) awayMap[s.type] = s.value;

  let rows = '', i = 0;
  for (const s of homeSide.statistics || []) {
    const name = STAT_NAMES[s.type] || s.type;
    const hv = num(s.value), av = num(awayMap[s.type]);
    const total = hv + av;
    const hw = total > 0 ? (hv / total) * 100 : 50;
    const aw = total > 0 ? (av / total) * 100 : 50;
    rows += `<div class="stat-row" style="animation-delay:${Math.min(i * 40, 500)}ms">
      <div class="stat-vals">
        <span class="sv home ${hv > av ? 'lead' : ''}">${show(s.value)}</span>
        <span class="stat-name">${name}</span>
        <span class="sv away ${av > hv ? 'lead' : ''}">${show(awayMap[s.type])}</span>
      </div>
      <div class="stat-track">
        <div class="stat-fill home" style="width:${hw}%"></div>
        <div class="stat-fill away" style="width:${aw}%"></div>
      </div>
    </div>`;
    i++;
  }

  return `<div class="stats-teams">
      <span class="tm"><img src="${homeSide.team.logo}" alt=""> ${homeSide.team.name}</span>
      <span class="tm">${awaySide.team.name} <img src="${awaySide.team.logo}" alt=""></span>
    </div>
    <div class="stats-grid">${rows}</div>`;
}

// ---------- Pestaña Cara a cara (H2H) ----------
async function tabH2H(box) {
  box.innerHTML = spinnerHtml('Buscando enfrentamientos anteriores…');
  const id = currentFixtureId, m = currentMeta;
  try {
    const list = await getDetail('h2h', `/api/h2h?h2h=${m.home.id}-${m.away.id}`);
    if (currentFixtureId !== id) return;
    box.innerHTML = h2hHtml(list, m);
  } catch (e) {
    if (currentFixtureId !== id) return;
    box.innerHTML = errorNote(e.message);
  }
}

function h2hHtml(list, m) {
  if (!list || !list.length) {
    return emptyHtml('🤝', 'No encontramos enfrentamientos anteriores entre estos dos equipos.');
  }
  const played = list
    .filter((f) => f.goals.home != null && f.goals.away != null && isFinishedStatus(f.fixture.status.short))
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  if (!played.length) {
    return emptyHtml('🤝', 'Aún no hay resultados finalizados entre estos dos equipos.');
  }

  let winsHome = 0, winsAway = 0, draws = 0;
  for (const f of played) {
    const hs = f.goals.home, as = f.goals.away;
    let winnerId = hs > as ? f.teams.home.id : (as > hs ? f.teams.away.id : null);
    if (winnerId === m.home.id) winsHome++;
    else if (winnerId === m.away.id) winsAway++;
    else draws++;
  }

  const recent = played.slice(0, 10);
  const item = (f, i) => {
    const hs = f.goals.home, as = f.goals.away;
    return `<div class="h2h-item" style="animation-delay:${Math.min(i * 50, 450)}ms">
      <span class="h2h-date">${dateFull(f.fixture.date)} · ${f.league.name}</span>
      <div class="h2h-line">
        <span class="h2h-team home ${hs > as ? 'win' : ''}"><span class="nm">${f.teams.home.name}</span><img src="${f.teams.home.logo}" alt=""></span>
        <span class="h2h-score">${hs} - ${as}</span>
        <span class="h2h-team away ${as > hs ? 'win' : ''}"><img src="${f.teams.away.logo}" alt=""><span class="nm">${f.teams.away.name}</span></span>
      </div>
    </div>`;
  };

  return `<div class="h2h-summary">
      <div class="h2h-stat home"><b>${winsHome}</b><span>Victorias<br>${m.home.name}</span></div>
      <div class="h2h-stat draws"><b>${draws}</b><span>Empates</span></div>
      <div class="h2h-stat away"><b>${winsAway}</b><span>Victorias<br>${m.away.name}</span></div>
    </div>
    <div class="section-title">Últimos enfrentamientos</div>
    <div class="h2h-list">${recent.map(item).join('')}</div>`;
}

// ---------- Cabecera del modal ----------
function headHtml(m) {
  const hs = m.goals?.home, as = m.goals?.away;
  const score = (hs != null && as != null) ? `${hs} - ${as}` : 'vs';
  const live = isLiveStatus(m.status?.short)
    ? ` · <span class="live-tag">● EN VIVO ${m.status.elapsed || ''}'</span>` : '';
  const round = m.league?.round ? translateRound(m.league.round) : '';
  const ven = m.venue;
  const venue = ven?.name ? `<div class="modal-venue">🏟️ ${ven.name}${ven.city ? ' · ' + ven.city : ''}</div>` : '';
  return `<div class="modal-head">
      <div class="mteam"><img src="${m.home.logo}" alt=""><span class="name">${m.home.name}</span></div>
      <div class="mscore">${score}</div>
      <div class="mteam"><img src="${m.away.logo}" alt=""><span class="name">${m.away.name}</span></div>
    </div>
    <div class="modal-sub">${m.league.name}${round ? ' · ' + round : ''} · ${dateNice(m.date)} ${timeOnly(m.date)}${live}</div>
    ${venue}`;
}

// --------------------------------------------------------------------------
//  Eventos de la interfaz
// --------------------------------------------------------------------------
el.dateSelect.addEventListener('change', () => selectDate(el.dateSelect.value));
el.prevDay.addEventListener('click', () => {
  const i = dates.indexOf(selectedDate);
  if (i > 0) selectDate(dates[i - 1]);
});
el.nextDay.addEventListener('click', () => {
  const i = dates.indexOf(selectedDate);
  if (i < dates.length - 1) selectDate(dates[i + 1]);
});
el.todayBtn.addEventListener('click', pickToday);

el.ed2026.addEventListener('click', () => setEdition('2026'));
el.ed2022.addEventListener('click', () => setEdition('2022'));

el.tabPartidos.addEventListener('click', () => showSection('partidos'));
el.tabGroups.addEventListener('click', () => showSection('groups'));
el.tabScorers.addEventListener('click', () => showSection('scorers'));

el.modalClose.addEventListener('click', closeModal);
el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Arranque
init();
