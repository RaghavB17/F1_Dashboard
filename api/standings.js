let cachedToken = null;
let tokenExpiry = 0;

async function getOpenF1Token() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;
  if (!username || !password) {
    console.warn('[AUTH] OpenF1 credentials missing in Vercel Env Vars');
    return null;
  }
  try {
    const params = new URLSearchParams();
    params.append("username", username);
    params.append("password", password);
    const authRes = await fetch("https://api.openf1.org/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!authRes.ok) throw new Error(`Auth failed: ${authRes.status}`);
    const authData = await authRes.json();
    cachedToken = authData.access_token;
    tokenExpiry = Date.now() + ((parseInt(authData.expires_in) || 3600) * 1000);
    console.log('[AUTH] Successfully grabbed new OpenF1 token.');
    return cachedToken;
  } catch (error) {
    console.error('[AUTH ERROR]', error.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600'); 

  console.log(`[STANDINGS] Starting dashboard data aggregation...`);

  try {
    const token = await getOpenF1Token();
    const openF1Headers = { 'accept': 'application/json' };
    if (token) openF1Headers['Authorization'] = `Bearer ${token}`;

    const fetchJson = async (url, headers = {}) => {
      try {
        console.log(`[FETCH] GET ${url}`);
        const response = await fetch(url, { headers });
        if (!response.ok) {
          console.error(`[FETCH ERROR] ${url} returned HTTP ${response.status}`);
          return null;
        }
        return await response.json();
      } catch (e) {
        console.error(`[FETCH EXCEPTION] ${url} ->`, e.message);
        return null;
      }
    };

    // THE FIX: Exactly 9 variables matching 9 fetches
    const [
      driversData, consData, schedData, lastRaceData, allQualiData, 
      openf1Weather, openf1Stints, openf1Session, winnersData
    ] = await Promise.all([
      fetchJson('https://api.jolpi.ca/ergast/f1/current/driverStandings.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current/constructorStandings.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current/last/results.json'),
      fetchJson('https://api.jolpi.ca/ergast/f1/current/qualifying.json'),
      fetchJson('https://api.openf1.org/v1/weather?session_key=latest', openF1Headers),
      fetchJson('https://api.openf1.org/v1/stints?session_key=latest', openF1Headers),
      fetchJson('https://api.openf1.org/v1/sessions?session_key=latest', openF1Headers),
      fetchJson('https://api.jolpi.ca/ergast/f1/current/results/1.json?limit=100')
    ]);

    const getRaces = (data) => data?.MRData?.RaceTable?.Races || [];

    const driverList = driversData?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
    const topPts = driverList.length ? parseFloat(driverList[0].points) : 0;
    const drivers = driverList.map(d => {
      const pts = parseFloat(d.points) || 0;
      return {
        code: d.Driver?.code || '',
        short_name: `${(d.Driver?.givenName || '').charAt(0)}. ${d.Driver?.familyName || ''}`,
        pos: parseInt(d.position) || 0,
        pts: pts,
        team_id: (d.Constructors?.[0]?.constructorId || '').replace(/\s+/g, '_').toLowerCase(),
        gap: topPts - pts > 0 ? (topPts - pts) : 0
      };
    });

    const consList = consData?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || [];
    const constructors = consList.map(c => ({
      id: (c.Constructor?.constructorId || '').replace(/\s+/g, '_').toLowerCase(),
      name: c.Constructor?.name || '',
      pos: parseInt(c.position) || 0,
      pts: parseFloat(c.points) || 0,
    }));

    const races = getRaces(schedData);
    const schedule = races.map(r => ({
      round: parseInt(r.round) || 0,
      country: r.Circuit?.Location?.country || '',
      circuit: r.Circuit?.circuitName || '',
      short_name: (r.raceName || '').replace(' Grand Prix', ''),
      start_utc: new Date(`${r.date}T${r.time || '15:00:00Z'}`).toISOString(),
      status: new Date(`${r.date}T${r.time || '15:00:00Z'}`) > new Date() ? 'upcoming' : 'done'
    }));
    const next_race = schedule.find(r => r.status === 'upcoming') || null;

    let qualifying = null;
    const allQualis = getRaces(allQualiData);
    const latestQualiRace = allQualis.length > 0 ? allQualis[allQualis.length - 1] : null;
    if (latestQualiRace && latestQualiRace.QualifyingResults) {
      qualifying = {
        short_name: (latestQualiRace.raceName || '').replace(' Grand Prix', ''),
        pole: {
          driver_short: `${latestQualiRace.QualifyingResults[0].Driver?.givenName.charAt(0)}. ${latestQualiRace.QualifyingResults[0].Driver?.familyName}`,
          time: latestQualiRace.QualifyingResults[0].Q3 || latestQualiRace.QualifyingResults[0].Q2 || latestQualiRace.QualifyingResults[0].Q1 || ''
        },
        results: latestQualiRace.QualifyingResults.slice(0, 5).map(q => ({
          pos: parseInt(q.position) || 0,
          driver_short: `${q.Driver?.givenName.charAt(0)}. ${q.Driver?.familyName}`,
          team_id: (q.Constructor?.constructorId || '').replace(/\s+/g, '_').toLowerCase(),
          time: q.Q3 || q.Q2 || q.Q1 || ''
        }))
      };
    }

    let weather = null;
    if (openf1Weather && Array.isArray(openf1Weather) && openf1Weather.length > 0) {
      const w = openf1Weather[openf1Weather.length - 1];
      const s = (openf1Session && openf1Session.length > 0) ? openf1Session[openf1Session.length - 1] : null;
      weather = {
        session_name: s ? `${s.country_name} · ${s.session_name}` : 'Latest Session',
        air_temp: w.air_temperature,
        track_temp: w.track_temperature,
        humidity: w.humidity,
        rain_pct: w.rainfall === 1 ? 100 : 0
      };
    }

    let stints = null;
    if (openf1Stints && Array.isArray(openf1Stints) && openf1Stints.length > 0) {
      const stintMap = {};
      openf1Stints.forEach(s => {
        if (!stintMap[s.driver_number] || s.stint_number > stintMap[s.driver_number].stint_number) {
          stintMap[s.driver_number] = {
            stint_number: s.stint_number,
            compound: s.compound,
            tyre_age: s.tyre_age_at_start
          };
        }
      });
      stints = stintMap;
    }

    let last_race = null;
    const lrData = getRaces(lastRaceData)[0];
    if (lrData) {
      last_race = {
        round: parseInt(lrData.round) || 0,
        short_name: (lrData.raceName || '').replace(' Grand Prix', ''),
        podium: lrData.Results?.slice(0, 3).map(r => ({
          driver: `${r.Driver?.givenName.charAt(0)}. ${r.Driver?.familyName}`,
          team_id: (r.Constructor?.constructorId || '').replace(/\s+/g, '_').toLowerCase(),
          time: r.Time?.time || r.status || ''
        }))
      };
    }

    const winners = {};
    getRaces(winnersData).forEach(r => {
      if (r.Results && r.Results.length > 0) {
         winners[r.round] = `${r.Results[0].Driver.givenName.charAt(0)}. ${r.Results[0].Driver.familyName}`;
      }
    });

    console.log(`[STANDINGS] Success. Data aggregated safely.`);
    res.status(200).json({ drivers, constructors, schedule, next_race, last_race, qualifying, weather, stints, winners, _fetched_at_utc: new Date().toISOString() });
  } catch (error) {
    console.error(`[CRITICAL ERROR] api/standings.js crashed:`, error.message);
    res.status(500).json({ error: error.message });
  }
}