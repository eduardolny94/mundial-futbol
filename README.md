# ⚽ Mundial — Partidos, plantillas y probabilidades

Web del Mundial de fútbol: calendario por fecha (según tu zona horaria), estadios,
plantillas de cada selección, grupos, goleadores, selección favorita y marcadores
con auto-actualización. Tiene dos ediciones:

- **Mundial 2026** (datos reales de [Zafronix](https://api.zafronix.com/)): calendario completo,
  estadios, plantillas y grupos, con auto-actualización de marcadores.
- **Mundial 2022** (datos de [API-Football](https://www.api-football.com/)): incluye alineaciones
  titulares, % de victoria, eventos y estadísticas.

## Tecnología
- **Backend:** Node.js + Express (hace de intermediario con las APIs y cachea respuestas).
- **Frontend:** HTML + CSS + JavaScript (sin frameworks).

## Cómo correrlo en tu computadora
1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Crea un archivo `.env` (copia `.env.example`) con tus claves:
   ```
   API_FOOTBALL_KEY=tu_clave
   ZAFRONIX_KEY=tu_clave
   ```
3. Arranca el servidor:
   ```bash
   npm start
   ```
4. Abre http://localhost:3000

## Variables de entorno
- `API_FOOTBALL_KEY` — clave de API-Football (Mundial 2022).
- `ZAFRONIX_KEY` — clave de Zafronix (Mundial 2026).
- `PORT` — opcional; el hosting (Render) lo asigna automáticamente.
