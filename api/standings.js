export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600');
  
    try {
      // Helper function to safely fetch JSON without crashing on 404s
      const fetchJson = async (url) => {
        try {
          const response = await fetch(url);
          if (!response.ok) return null;
          return await response.json();
        } catch (e) {
          return null;
        }
      };
  
      // Fetch all 5 data feeds concurrently for maximum speed
      const [driversData, consData, schedData, lastRaceData, qualiData] = await Promise.all([
        fetchJson('https://api.jolpi.ca/ergast/f1/current/driverStandings.json'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current/constructorStandings.json'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current.json'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current/last/results.json'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current/last/qualifying.json')
      ]);
  
      // Safety checks for deep JSON trees
      const getStandingsList = (data) => data?.MRData?.StandingsTable?.StandingsLists?.[0] || {};
      const getRaces = (data) => data?.MRData?.RaceTable?.Races || [];
  
      // 1. Parse Drivers
      const driverList = getStandingsList(driversData).DriverStandings || [];
      const topPts = driverList.length ? parseFloat(driverList[0].points) : 0;
      const drivers = driverList.map(d => {
        const pts = parseFloat(d.points) || 0;
        return {
          code: d.Driver?.code || '',
          short_name: `${(d.Driver?.givenName || '').charAt(0)}. ${d.Driver?.familyName || ''}`,
          given_name: d.Driver?.givenName || '',
          family_name: d.Driver?.familyName || '',
          pos: parseInt(d.position) || 0,
          pts: pts,
          wins: parseInt(d.wins) || 0,
          nationality: d.Driver?.nationality || '',
          team_id: (d.Constructors?.[0]?.constructorId || '').replace(/\s+/g, '_').toLowerCase(),
          team_name: d.Constructors?.[0]?.name || '',
          gap: topPts - pts > 0 ? (topPts - pts) : 0
        };
      });
  
      // 2. Parse Constructors
      const consList = getStandingsList(consData).ConstructorStandings || [];
      const maxConPts = consList.length ? parseFloat(consList[0].points) : 1;
      const constructors = consList.map(c => ({
        id: (c.Constructor?.constructorId || '').replace(/\s+/g, '_').toLowerCase(),
        name: c.Constructor?.name || '',
        pos: parseInt(c.position) || 0,
        pts: parseFloat(c.points) || 0,
        wins: parseInt(c.wins) || 0,
        nationality: c.Constructor?.nationality || '',
        pct: ((parseFloat(c.points) || 0) / maxConPts) * 100
      }));
  
      // 3. Parse Schedule & Find Next Race
      const races = getRaces(schedData);
      const now = new Date();
      const schedule = races.map(r => {
        const raceDate = new Date(`${r.date}T${r.time || '15:00:00Z'}`);
        return {
          round: parseInt(r.round) || 0,
          country: r.Circuit?.Location?.country || '',
          locality: r.Circuit?.Location?.locality || '',
          circuit: r.Circuit?.circuitName || '',
          circuit_id: r.Circuit?.circuitId || '',
          short_name: (r.raceName || '').replace(' Grand Prix', ''),
          start_utc: raceDate.toISOString(),
          status: raceDate > now ? 'upcoming' : 'done'
        };
      });
      const next_race = schedule.find(r => r.status === 'upcoming') || null;
  
      // 4. Parse Last Race Details & Qualifying
      let last_race = null;
      const lastRaceResults = getRaces(lastRaceData)[0];
      
      if (lastRaceResults) {
        const podium = (lastRaceResults.Results || []).slice(0, 3).map(r => ({
          driver: `${(r.Driver?.givenName || '').charAt(0)}. ${r.Driver?.familyName || ''}`,
          driver_short: `${(r.Driver?.givenName || '').charAt(0)}. ${r.Driver?.familyName || ''}`,
          team_id: (r.Constructor?.constructorId || '').replace(/\s+/g, '_').toLowerCase(),
          team: r.Constructor?.name || '',
          time: r.Time?.time || r.status || '',
          number: r.number || ''
        }));
  
        const flResult = (lastRaceResults.Results || []).find(r => r.FastestLap && String(r.FastestLap.rank) === "1");
        const fastest_lap = flResult ? {
          driver: `${(flResult.Driver?.givenName || '').charAt(0)}. ${flResult.Driver?.familyName || ''}`,
          time: flResult.FastestLap.Time?.time || '',
          lap: flResult.FastestLap.lap || ''
        } : null;
  
        // Qualifying
        let qualifying = null;
        const qualiRace = getRaces(qualiData)[0];
        if (qualiRace && qualiRace.QualifyingResults && qualiRace.QualifyingResults.length > 0) {
          const p1 = qualiRace.QualifyingResults[0];
          qualifying = {
            pole: {
              driver_short: `${(p1.Driver?.givenName || '').charAt(0)}. ${p1.Driver?.familyName || ''}`,
              time: p1.Q3 || p1.Q2 || p1.Q1 || ''
            },
            results: qualiRace.QualifyingResults.slice(0, 5).map(q => ({
              pos: parseInt(q.position) || 0,
              driver_short: `${(q.Driver?.givenName || '').charAt(0)}. ${q.Driver?.familyName || ''}`,
              team_id: (q.Constructor?.constructorId || '').replace(/\s+/g, '_').toLowerCase(),
              team: q.Constructor?.name || '',
              q1: q.Q1 || '', q2: q.Q2 || '', q3: q.Q3 || '',
              best: q.Q3 || q.Q2 || q.Q1 || ''
            }))
          };
        }
  
        last_race = {
          round: parseInt(lastRaceResults.round) || 0,
          short_name: (lastRaceResults.raceName || '').replace(' Grand Prix', ''),
          circuit: lastRaceResults.Circuit?.circuitName || '',
          country: lastRaceResults.Circuit?.Location?.country || '',
          podium,
          fastest_lap,
          qualifying,
          weather: null,
          stints: null
        };
      }
  
      res.status(200).json({ drivers, constructors, schedule, next_race, last_race });
    } catch (error) {
      // If something crashes, return a 500 error so we can debug it
      res.status(500).json({ error: error.message });
    }
  }