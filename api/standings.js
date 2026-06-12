let cachedToken = null;
let tokenExpiry = 0;

async function getOpenF1Token() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;
  if (!username || !password) return null;

  const response = await fetch('https://api.openf1.org/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password })
  });
  if (!response.ok) return null;

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + ((parseInt(data.expires_in, 10) || 3600) * 1000);
  return cachedToken;
}

async function fetchJson(url, headers = {}) {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

const getRaces = data => data?.MRData?.RaceTable?.Races || [];
const getStandingsList = data => data?.MRData?.StandingsTable?.StandingsLists?.[0] || {};
const shortDriverName = driver => `${(driver?.givenName || '').charAt(0)}. ${driver?.familyName || ''}`;
const teamId = constructor => (constructor?.constructorId || '').replace(/\s+/g, '_').toLowerCase();

function parseQualifying(data) {
  const races = getRaces(data);
  const race = races.length ? races[races.length - 1] : null;
  const results = race?.QualifyingResults || [];
  if (!results.length) return null;

  const parsed = results.map(result => ({
    pos: parseInt(result.position, 10) || 0,
    driver_short: shortDriverName(result.Driver),
    team_id: teamId(result.Constructor),
    team: result.Constructor?.name || '',
    q1: result.Q1 || '',
    q2: result.Q2 || '',
    q3: result.Q3 || '',
    best: result.Q3 || result.Q2 || result.Q1 || ''
  }));

  return {
    short_name: (race.raceName || '').replace(' Grand Prix', ''),
    pole: { driver_short: parsed[0].driver_short, time: parsed[0].best },
    results: parsed
  };
}

function buildLatestSession(sessionData, weatherData, stintData, driverData, positionData) {
  const session = Array.isArray(sessionData) ? sessionData[0] : null;
  if (!session) return null;

  const weatherRecords = Array.isArray(weatherData) ? weatherData : [];
  const weatherRecord = weatherRecords[weatherRecords.length - 1];
  const weather = weatherRecord ? {
    air_temp: weatherRecord.air_temperature,
    track_temp: weatherRecord.track_temperature,
    humidity: weatherRecord.humidity,
    rain_pct: weatherRecord.rainfall === 1 ? 100 : 0
  } : null;

  const drivers = new Map();
  for (const driver of Array.isArray(driverData) ? driverData : []) {
    if (driver?.driver_number != null) drivers.set(driver.driver_number, driver);
  }

  const latestPositions = new Map();
  for (const position of Array.isArray(positionData) ? positionData : []) {
    if (position?.driver_number == null) continue;
    const previous = latestPositions.get(position.driver_number);
    if (!previous || Date.parse(position.date || '') >= Date.parse(previous.date || '')) {
      latestPositions.set(position.driver_number, position);
    }
  }

  const stintsByDriver = new Map();
  let maxLap = 1;
  for (const stint of Array.isArray(stintData) ? stintData : []) {
    if (stint?.driver_number == null) continue;
    const lapStart = stint.lap_start || 1;
    const lapEnd = stint.lap_end || lapStart;
    maxLap = Math.max(maxLap, lapEnd);
    if (!stintsByDriver.has(stint.driver_number)) stintsByDriver.set(stint.driver_number, []);
    stintsByDriver.get(stint.driver_number).push({
      compound: (stint.compound || 'unknown').toLowerCase(),
      lap_start: lapStart,
      lap_end: lapEnd,
      laps: Math.max(1, lapEnd - lapStart + 1)
    });
  }

  const rankedDrivers = [...stintsByDriver.keys()].sort((a, b) => {
    const posA = latestPositions.get(a)?.position || 999;
    const posB = latestPositions.get(b)?.position || 999;
    return posA - posB;
  }).slice(0, 3);

  const stints = rankedDrivers.length ? {
    total_laps: maxLap,
    drivers: rankedDrivers.map(number => {
      const driver = drivers.get(number);
      return {
        num: number,
        code: driver?.name_acronym || String(number),
        driver: driver?.full_name || driver?.broadcast_name || driver?.last_name || `#${number}`,
        stints: stintsByDriver.get(number).sort((a, b) => a.lap_start - b.lap_start)
      };
    })
  } : null;

  return {
    session_key: session.session_key,
    session_name: session.session_name || '',
    country: session.country_name || '',
    circuit: session.circuit_short_name || session.location || '',
    label: [session.country_name, session.session_name].filter(Boolean).join(' · '),
    weather,
    stints
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=120');

  try {
    const token = await getOpenF1Token();
    const openF1Headers = { accept: 'application/json' };
    if (token) openF1Headers.Authorization = `Bearer ${token}`;

    const [
      driversData, constructorsData, scheduleData, lastRaceData, qualifyingData, winnersData,
      sessionData, weatherData, stintData, openF1Drivers, positionData
    ] = await Promise.all([
      fetchJson('https://api.jolpi.ca/ergast/f1/current/driverStandings.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current/constructorStandings.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current/last/results.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current/qualifying.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current/results/1.json?limit=100'),
      fetchJson('https://api.openf1.org/v1/sessions?session_key=latest', openF1Headers),
      fetchJson('https://api.openf1.org/v1/weather?session_key=latest', openF1Headers),
      fetchJson('https://api.openf1.org/v1/stints?session_key=latest', openF1Headers),
      fetchJson('https://api.openf1.org/v1/drivers?session_key=latest', openF1Headers),
      fetchJson('https://api.openf1.org/v1/position?session_key=latest', openF1Headers)
    ]);

    const driverList = getStandingsList(driversData).DriverStandings || [];
    const topPoints = parseFloat(driverList[0]?.points) || 0;
    const drivers = driverList.map(item => {
      const points = parseFloat(item.points) || 0;
      return {
        code: item.Driver?.code || '',
        short_name: shortDriverName(item.Driver),
        given_name: item.Driver?.givenName || '',
        family_name: item.Driver?.familyName || '',
        pos: parseInt(item.position, 10) || 0,
        pts: points,
        wins: parseInt(item.wins, 10) || 0,
        nationality: item.Driver?.nationality || '',
        team_id: teamId(item.Constructors?.[0]),
        team_name: item.Constructors?.[0]?.name || '',
        gap: Math.max(0, topPoints - points),
        permanent_number: item.Driver?.permanentNumber || ''
      };
    });

    const constructorList = getStandingsList(constructorsData).ConstructorStandings || [];
    const topConstructorPoints = parseFloat(constructorList[0]?.points) || 1;
    const constructors = constructorList.map(item => ({
      id: teamId(item.Constructor),
      name: item.Constructor?.name || '',
      pos: parseInt(item.position, 10) || 0,
      pts: parseFloat(item.points) || 0,
      wins: parseInt(item.wins, 10) || 0,
      nationality: item.Constructor?.nationality || '',
      pct: ((parseFloat(item.points) || 0) / topConstructorPoints) * 100
    }));

    const now = new Date();
    const schedule = getRaces(scheduleData).map(race => {
      const start = new Date(`${race.date}T${race.time || '15:00:00Z'}`);
      return {
        round: parseInt(race.round, 10) || 0,
        country: race.Circuit?.Location?.country || '',
        locality: race.Circuit?.Location?.locality || '',
        circuit: race.Circuit?.circuitName || '',
        circuit_id: race.Circuit?.circuitId || '',
        short_name: (race.raceName || '').replace(' Grand Prix', ''),
        start_utc: start.toISOString(),
        date: race.date,
        status: start > now ? 'upcoming' : 'done'
      };
    });
    const next_race = schedule.find(race => race.status === 'upcoming') || null;

    const qualifying = parseQualifying(qualifyingData);
    const latest_session = buildLatestSession(sessionData, weatherData, stintData, openF1Drivers, positionData);

    const lastRace = getRaces(lastRaceData)[0];
    let last_race = null;
    if (lastRace) {
      const podium = (lastRace.Results || []).slice(0, 3).map(result => ({
        driver: shortDriverName(result.Driver),
        driver_short: shortDriverName(result.Driver),
        team_id: teamId(result.Constructor),
        team: result.Constructor?.name || '',
        time: result.Time?.time || result.status || '',
        number: result.number || ''
      }));
      const fastest = (lastRace.Results || []).find(result => String(result.FastestLap?.rank) === '1');
      last_race = {
        round: parseInt(lastRace.round, 10) || 0,
        short_name: (lastRace.raceName || '').replace(' Grand Prix', ''),
        circuit: lastRace.Circuit?.circuitName || '',
        country: lastRace.Circuit?.Location?.country || '',
        podium,
        fastest_lap: fastest ? {
          driver: shortDriverName(fastest.Driver),
          time: fastest.FastestLap?.Time?.time || '',
          lap: fastest.FastestLap?.lap || ''
        } : null
      };
    }

    const winners = {};
    for (const race of getRaces(winnersData)) {
      if (race.Results?.[0]?.Driver) winners[race.round] = shortDriverName(race.Results[0].Driver);
    }

    return res.status(200).json({
      drivers, constructors, schedule, next_race, last_race, qualifying, latest_session, winners,
      _fetched_at_utc: new Date().toISOString()
    });
  } catch (error) {
    console.error('Standings aggregation error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
