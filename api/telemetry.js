let cachedToken = null;
let tokenExpiry = 0;

const ALLOWED_ENDPOINTS = new Set(['drivers', 'intervals', 'laps', 'position', 'sessions', 'stints']);

async function getOpenF1Token() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;
  if (!username || !password) return null;

  const params = new URLSearchParams({ username, password });
  const response = await fetch('https://api.openf1.org/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) throw new Error(`OpenF1 authentication failed: ${response.status}`);

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + ((parseInt(data.expires_in, 10) || 3600) * 1000);
  return cachedToken;
}

function latestByDriver(records, compare) {
  const latest = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.driver_number == null) continue;
    const previous = latest.get(record.driver_number);
    if (!previous || compare(record, previous) >= 0) latest.set(record.driver_number, record);
  }
  return latest;
}

function recordTime(record) {
  return Date.parse(record?.date || '') || 0;
}

async function fetchOpenF1(endpoint, query, headers) {
  const qs = new URLSearchParams(query).toString();
  const response = await fetch(`https://api.openf1.org/v1/${endpoint}?${qs}`, { headers });
  if (!response.ok) throw new Error(`OpenF1 ${endpoint} failed: ${response.status}`);
  return response.json();
}

async function fetchOptionalOpenF1(endpoint, query, headers) {
  try {
    return await fetchOpenF1(endpoint, query, headers);
  } catch (error) {
    console.warn(`Optional OpenF1 ${endpoint} feed unavailable:`, error.message);
    return [];
  }
}

async function fetchTiming(query, headers) {
  const sessionKey = query.session_key || 'latest';
  const recentQuery = { session_key: sessionKey };
  if (query['date>=']) recentQuery['date>='] = query['date>='];

  const [positions, intervals, laps, stints] = await Promise.all([
    fetchOptionalOpenF1('position', { session_key: sessionKey }, headers),
    fetchOptionalOpenF1('intervals', recentQuery, headers),
    fetchOptionalOpenF1('laps', { session_key: sessionKey }, headers),
    fetchOptionalOpenF1('stints', { session_key: sessionKey }, headers)
  ]);

  const latestPosition = latestByDriver(positions, (a, b) => recordTime(a) - recordTime(b));
  const latestInterval = latestByDriver(intervals, (a, b) => recordTime(a) - recordTime(b));
  const latestLap = latestByDriver(laps, (a, b) => (a.lap_number || 0) - (b.lap_number || 0));
  const latestStint = latestByDriver(stints, (a, b) => (a.stint_number || 0) - (b.stint_number || 0));
  const bestLap = new Map();

  for (const lap of Array.isArray(laps) ? laps : []) {
    if (lap?.driver_number == null || !Number.isFinite(lap.lap_duration)) continue;
    const previous = bestLap.get(lap.driver_number);
    if (!previous || lap.lap_duration < previous.lap_duration) bestLap.set(lap.driver_number, lap);
  }

  const driverNumbers = new Set([
    ...latestPosition.keys(),
    ...latestInterval.keys(),
    ...latestLap.keys(),
    ...latestStint.keys()
  ]);

  return [...driverNumbers].map(driverNumber => {
    const position = latestPosition.get(driverNumber);
    const interval = latestInterval.get(driverNumber);
    const lastLap = latestLap.get(driverNumber);
    const fastestLap = bestLap.get(driverNumber);
    const stint = latestStint.get(driverNumber);
    return {
      driver_number: driverNumber,
      position: position?.position ?? null,
      gap_to_leader: interval?.gap_to_leader ?? null,
      interval: interval?.interval ?? null,
      lap_number: lastLap?.lap_number ?? null,
      last_lap: lastLap?.lap_duration ?? null,
      best_lap: fastestLap?.lap_duration ?? null,
      compound: stint?.compound ?? null,
      stint_number: stint?.stint_number ?? null,
      tyre_age_at_start: stint?.tyre_age_at_start ?? null
    };
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=5');

  const { endpoint, ...query } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint parameter' });
  if (endpoint !== 'timing' && !ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error: 'Unsupported endpoint' });
  }

  try {
    const token = await getOpenF1Token();
    const headers = { accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const data = endpoint === 'timing'
      ? await fetchTiming(query, headers)
      : await fetchOpenF1(endpoint, query, headers);
    return res.status(200).json(data);
  } catch (error) {
    console.error('Telemetry proxy error:', error.message);
    return res.status(502).json({ error: error.message });
  }
}
