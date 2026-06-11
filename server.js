// ============================================================================
//  SERVIDOR (backend) de la plataforma de futbol
//  - Guarda tu clave de API en secreto (nunca llega al navegador)
//  - Hace de intermediario ("proxy") con API-Football
//  - Cachea (guarda temporalmente) las respuestas para no gastar
//    tus 100 peticiones diarias gratuitas tan rapido
// ============================================================================

import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cargar el archivo .env que esta JUNTO a este server.js,
// sin importar desde que carpeta se ejecute el comando.
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// Tu clave de la API (se lee del archivo .env, nunca se escribe en el codigo)
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';

if (!API_KEY) {
  console.warn('\n⚠️  No se encontro la clave API_FOOTBALL_KEY en el archivo .env');
  console.warn('   La web abrira, pero los datos reales no cargaran hasta poner la clave.\n');
}

// Servir los archivos de la pagina web (carpeta /public)
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
//  Cache sencillo en memoria: guarda cada respuesta durante unos minutos
//  para reutilizarla y no volver a gastar una peticion a la API.
// ----------------------------------------------------------------------------
const cache = new Map();

async function fetchApi(endpoint, ttlSeconds) {
  const cacheKey = endpoint;
  const now = Date.now();

  // Si ya lo pedimos hace poco, devolvemos lo guardado (sin gastar peticion)
  const cached = cache.get(cacheKey);
  if (cached && now - cached.time < ttlSeconds * 1000) {
    return { ...cached.data, _cached: true };
  }

  if (!API_KEY) {
    throw new Error('Falta la clave API_FOOTBALL_KEY en el archivo .env');
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'x-apisports-key': API_KEY },
  });

  if (!res.ok) {
    throw new Error(`La API respondio con error ${res.status}`);
  }

  const data = await res.json();
  cache.set(cacheKey, { time: now, data });
  return { ...data, _cached: false };
}

// Pequena ayuda para responder de forma uniforme y atrapar errores
function handler(buildEndpoint, ttlSeconds) {
  return async (req, res) => {
    try {
      const endpoint = buildEndpoint(req);
      const data = await fetchApi(endpoint, ttlSeconds);
      res.json(data);
    } catch (err) {
      console.error('Error en', req.path, '->', err.message);
      res.status(500).json({ error: err.message });
    }
  };
}

// ============================================================================
//  ZAFRONIX — Mundial 2026 REAL (gratis: calendario, estadios, plantillas)
//  Otra API distinta (otra URL y otra clave). Normalizamos sus datos al
//  mismo formato que usa la web para reutilizar todo lo ya construido.
// ============================================================================
const ZAF_KEY = process.env.ZAFRONIX_KEY;
const ZAF_BASE = 'https://api.zafronix.com/fifa/worldcup/v1';
const zafCache = new Map();

async function zafFetch(endpoint, ttlSeconds) {
  const now = Date.now();
  const cached = zafCache.get(endpoint);
  if (cached && now - cached.time < ttlSeconds * 1000) return cached.data;
  if (!ZAF_KEY) throw new Error('Falta la clave ZAFRONIX_KEY en el archivo .env');

  const res = await fetch(`${ZAF_BASE}${endpoint}`, { headers: { 'X-API-Key': ZAF_KEY } });
  if (!res.ok) throw new Error(`Zafronix respondio con error ${res.status}`);
  const data = await res.json();
  zafCache.set(endpoint, { time: now, data });
  return data;
}

// Normaliza un nombre: minusculas y sin acentos (para comparar bien)
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Algunos equipos vienen con nombre distinto en /matches y en /tournaments.
// Aqui igualamos el nombre del partido al nombre del torneo (ya normalizados).
const TEAM_ALIAS = {
  "cote d'ivoire": 'ivory coast',
  'cabo verde': 'cape verde',
  'congo dr': 'dr congo',
  'czechia': 'czech republic',
  'ir iran': 'iran',
  'korea republic': 'south korea',
  'turkiye': 'turkey',
  'usa': 'united states',
};
const canon = (name) => TEAM_ALIAS[norm(name)] || norm(name);

// Traduce la fase ("group_a", "round_of_32"...) a texto en español
function stageLabel(stage) {
  if (!stage) return '';
  const s = String(stage).toLowerCase();
  const gm = s.match(/group_([a-l])/);
  if (gm) return 'Grupo ' + gm[1].toUpperCase();
  if (s.includes('round_of_32')) return 'Dieciseisavos';
  if (s.includes('round_of_16')) return 'Octavos de final';
  if (s.includes('quarter')) return 'Cuartos de final';
  if (s.includes('semi')) return 'Semifinal';
  if (s.includes('third') || s.includes('3rd')) return 'Tercer puesto';
  if (s.includes('final')) return 'Final';
  return stage;
}

// En eliminatorias aun no se sabe el rival: viene una referencia tipo
// "2A" (2º del grupo A), "1E", "3ABCDF" (un 3º clasificado), "W89" (ganador
// del partido 89). La convertimos a texto claro en español.
function formatRef(ref) {
  if (!ref) return 'Por definir';
  let m;
  if ((m = ref.match(/^(\d)([A-L])$/))) return `${m[1]}º Grupo ${m[2]}`;
  if ((m = ref.match(/^(\d)([A-L]{2,})$/))) return `${m[1]}º mejor (${m[2].split('').join('/')})`;
  if ((m = ref.match(/^W(\d+)$/i))) return `Ganador partido ${m[1]}`;
  if ((m = ref.match(/^L(\d+)$/i))) return `Perdedor partido ${m[1]}`;
  return ref;
}

// Todos los partidos del Mundial 2026, normalizados al formato de la web
app.get('/api/wc2026', async (req, res) => {
  try {
    const [matches, tourn] = await Promise.all([
      zafFetch('/matches?year=2026', 60),       // 60s: marcadores casi en vivo
      zafFetch('/tournaments/2026', 60 * 60),   // plantillas/grupos: 1 hora
    ]);

    // Mapa nombre-de-equipo -> bandera + grupo (para mostrar escudos)
    const info = {};
    for (const t of tourn.teams || []) {
      info[norm(t.name)] = { logo: t.flag?.flagUrl || '', group: t.groupStage?.group || '', code: t.code };
    }

    const fixtures = (matches.data || []).map((m) => {
      const h = info[canon(m.homeTeam)] || {};
      const a = info[canon(m.awayTeam)] || {};
      const homeName = m.homeTeam || formatRef(m.homeRef);
      const awayName = m.awayTeam || formatRef(m.awayRef);
      const tbd = !m.homeTeam || !m.awayTeam;   // rival por definir (eliminatorias)

      // Estado del partido calculado segun la hora actual vs la hora de inicio
      const koIso = m.kickoffUtc || `${m.date}T${(m.kickoff || '00:00')}:00Z`;
      const ko = new Date(koIso).getTime();
      const now = Date.now();
      const hasScore = m.homeScore != null && m.awayScore != null;
      const WINDOW = 150 * 60000; // ~2.5h (incluye descanso y añadido)
      let short = 'NS', elapsed = null;
      if (m.result != null || (hasScore && now > ko + WINDOW)) {
        short = 'FT';
      } else if (now >= ko && now < ko + WINDOW) {
        short = 'LIVE';
        elapsed = Math.max(1, Math.min(120, Math.floor((now - ko) / 60000)));
      }

      return {
        fixture: {
          id: m.id,
          date: koIso,
          status: { short, elapsed },
          venue: { name: m.stadium || '', city: m.city || '' },
        },
        teams: {
          home: { id: m.homeTeam || m.homeRef, name: homeName, logo: h.logo },
          away: { id: m.awayTeam || m.awayRef, name: awayName, logo: a.logo },
        },
        goals: { home: m.homeScore, away: m.awayScore },
        league: { id: 'wc2026', name: 'Mundial 2026', country: 'FIFA', logo: '', round: stageLabel(m.stage) },
        tbd,
      };
    });

    res.json({ response: fixtures });
  } catch (err) {
    console.error('Error en /api/wc2026 ->', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Plantilla, entrenador y grupo de una seleccion (para el detalle del partido)
//   /api/wc2026/team?name=Mexico
app.get('/api/wc2026/team', async (req, res) => {
  try {
    const tourn = await zafFetch('/tournaments/2026', 60 * 60);
    const t = (tourn.teams || []).find((x) => norm(x.name) === canon(req.query.name));
    res.json({ response: t ? [t] : [] });
  } catch (err) {
    console.error('Error en /api/wc2026/team ->', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Lista de grupos con su clasificacion (para la vista de Grupos)
app.get('/api/wc2026/groups', async (req, res) => {
  try {
    const tourn = await zafFetch('/tournaments/2026', 60 * 60);
    const groups = {};
    for (const t of tourn.teams || []) {
      const g = t.groupStage?.group;
      if (!g) continue;
      (groups[g] ||= []).push({
        name: t.name, code: t.code, logo: t.flag?.flagUrl || '',
        ...(t.groupStage || {}),
      });
    }
    res.json({ response: groups });
  } catch (err) {
    console.error('Error en /api/wc2026/groups ->', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Goleadores del Mundial 2026. Zafronix gratis no tiene un endpoint propio de
// goleadores, asi que los armamos a partir de los goles de cada partido jugado
// (si Zafronix los incluye). Antes de empezar el torneo sale vacio y se va
// llenando solo conforme se juegan los partidos.
app.get('/api/wc2026/scorers', async (req, res) => {
  try {
    const [matches, tourn] = await Promise.all([
      zafFetch('/matches?year=2026', 60),
      zafFetch('/tournaments/2026', 60 * 60),
    ]);
    const flag = {};
    for (const t of tourn.teams || []) flag[norm(t.name)] = t.flag?.flagUrl || '';

    // Buscamos arrays de goleadores dentro de cada partido (varios nombres posibles)
    const tally = {};
    for (const m of matches.data || []) {
      const events = m.goals || m.scorers || m.goalscorers || [];
      for (const g of events) {
        const name = g.player || g.name || g.scorer;
        if (!name) continue;
        const team = g.team || g.country || '';
        const own = /own/i.test(g.type || g.detail || '');
        if (own) continue;
        const key = name + '|' + team;
        if (!tally[key]) tally[key] = { player: name, team, logo: flag[canon(team)] || '', goals: 0, assists: 0 };
        tally[key].goals += 1;
        if (g.assist) {
          const akey = g.assist + '|' + team;
          if (!tally[akey]) tally[akey] = { player: g.assist, team, logo: flag[canon(team)] || '', goals: 0, assists: 0 };
          tally[akey].assists += 1;
        }
      }
    }
    let scorers = Object.values(tally).sort((x, y) => y.goals - x.goals || y.assists - x.assists);

    // Si no hay goles aun pero el torneo ya designo un maximo goleador, lo mostramos
    const ts = tourn.tournament?.topScorer;
    if (!scorers.length && ts && (ts.player || ts.name)) {
      scorers = [{ player: ts.player || ts.name, team: ts.team || '', logo: flag[canon(ts.team || '')] || '', goals: ts.goals || 0, assists: 0 }];
    }

    res.json({ response: scorers });
  } catch (err) {
    console.error('Error en /api/wc2026/scorers ->', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
//  RUTAS de nuestra API interna (las que usa la pagina web)
// ----------------------------------------------------------------------------

// TODOS los partidos del Mundial de una temporada, en UNA sola llamada.
// Asi el navegador puede agrupar por fecha y moverse entre dias sin
// gastar mas peticiones de tu cuota diaria.
//   /api/worldcup?season=2026&timezone=America/Caracas
app.get('/api/worldcup', handler((req) => {
  const tz = req.query.timezone || 'UTC';
  const season = req.query.season;
  return `/fixtures?league=1&season=${encodeURIComponent(season)}&timezone=${encodeURIComponent(tz)}`;
}, 60 * 10)); // se guarda 10 minutos

// Partidos de un dia (con hora segun la zona horaria del usuario)
//   /api/fixtures?date=2026-06-11&timezone=America/Bogota&league=140
app.get('/api/fixtures', handler((req) => {
  const date = req.query.date;
  const tz = req.query.timezone || 'UTC';
  const league = req.query.league;
  const season = req.query.season;
  let ep = `/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(tz)}`;
  if (league) ep += `&league=${encodeURIComponent(league)}`;
  if (season) ep += `&season=${encodeURIComponent(season)}`;
  return ep;
}, 60 * 5)); // se guarda 5 minutos

// Partidos EN VIVO ahora mismo
//   /api/live?timezone=America/Bogota
app.get('/api/live', handler((req) => {
  const tz = req.query.timezone || 'UTC';
  return `/fixtures?live=all&timezone=${encodeURIComponent(tz)}`;
}, 30)); // en vivo: solo 30 segundos de cache

// Alineaciones de un partido
//   /api/lineups?fixture=12345
app.get('/api/lineups', handler((req) => {
  return `/fixtures/lineups?fixture=${encodeURIComponent(req.query.fixture)}`;
}, 60 * 10));

// Prediccion de probabilidad de victoria de un partido
//   /api/predictions?fixture=12345
app.get('/api/predictions', handler((req) => {
  return `/predictions?fixture=${encodeURIComponent(req.query.fixture)}`;
}, 60 * 60)); // las predicciones cambian poco: 1 hora

// Estadisticas de un partido (posesion, tiros, etc.)
//   /api/stats?fixture=12345
app.get('/api/stats', handler((req) => {
  return `/fixtures/statistics?fixture=${encodeURIComponent(req.query.fixture)}`;
}, 60 * 2));

// Tabla de posiciones de una liga
//   /api/standings?league=140&season=2024
app.get('/api/standings', handler((req) => {
  return `/standings?league=${encodeURIComponent(req.query.league)}&season=${encodeURIComponent(req.query.season)}`;
}, 60 * 30));

// Historial entre dos equipos (head-to-head)
//   /api/h2h?h2h=33-34
app.get('/api/h2h', handler((req) => {
  return `/fixtures/headtohead?h2h=${encodeURIComponent(req.query.h2h)}&last=8`;
}, 60 * 30));

// Eventos de un partido (goles, tarjetas, cambios)
//   /api/events?fixture=12345
app.get('/api/events', handler((req) => {
  return `/fixtures/events?fixture=${encodeURIComponent(req.query.fixture)}`;
}, 30));

// Goleadores del Mundial
//   /api/topscorers?season=2022
app.get('/api/topscorers', handler((req) => {
  return `/players/topscorers?league=1&season=${encodeURIComponent(req.query.season)}`;
}, 60 * 30));

// Asistidores del Mundial
//   /api/topassists?season=2022
app.get('/api/topassists', handler((req) => {
  return `/players/topassists?league=1&season=${encodeURIComponent(req.query.season)}`;
}, 60 * 30));

// Cuanta cuota de peticiones nos queda hoy (diagnostico)
app.get('/api/status', handler(() => `/status`, 60));

app.listen(PORT, () => {
  console.log(`\n✅ Servidor listo. Abre tu navegador en:  http://localhost:${PORT}\n`);
});
