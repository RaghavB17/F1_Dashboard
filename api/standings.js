export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600');
  
    try {
      const fetchJson = async (url) => {
        try {
          const response = await fetch(url);
          if (!response.ok) return null;
          return await response.json();
        } catch (e) {
          return null;
        }
      };
  
      const [
        driversData, consData, schedData, lastRaceData, qualiData, 
        openf1Weather, openf1Stints, winnersData
      ] = await Promise.all([
        fetchJson('https://api.jolpi.ca/ergast/f1/current/driverStandings.json'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current/constructorStandings.json'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current.json'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current/last/results.json'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current/last/qualifying.json'),
        fetchJson('https://api.openf1.org/v1/weather?session_key=latest'),
        fetchJson('https://api.openf1.org/v1/stints?session_key=latest'),
        fetchJson('https://api.jolpi.ca/ergast/f1/current/results/1.json?limit=100')
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
          gap: topPts - pts > 0 ? (topPts - pts) : 0,
          permanent_number: d.Driver?.permanentNumber || ''
        };
      });
  
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
          date: r.date,
          status: raceDate > now ? 'upcoming' : 'done'
        };
      });
      const next_race = schedule.find(r => r.status === 'upcoming') || null;
  
      let weather = null;
      let stints = null;
      if (openf1Weather && openf1Weather.length > 0) {
        const w = openf1Weather[openf1Weather.length - 1];
        weather = {
          air_temp: w.air_temperature,
          track_temp: w.track_temperature,
          humidity: w.humidity,
          rain_pct: w.rainfall === 1 ? 100 : 0
        };
      }
  
      const lastRaceResults = getRaces(lastRaceData)[0];
      if (openf1Stints && openf1Stints.length > 0 && lastRaceResults) {
        const driverMap = {};
        let maxLap = 1;
        openf1Stints.forEach(s => {
          if (!driverMap[s.driver_number]) driverMap[s.driver_number] = [];
          const lapStart = s.lap_start || 1;
          const lapEnd = s.lap_end || lapStart;
          const laps = lapEnd - lapStart + 1;
          if (lapEnd > maxLap) maxLap = lapEnd;
          driverMap[s.driver_number].push({
            compound: (s.compound || 'unknown').toLowerCase(),
            lap_start: lapStart,
            lap_end: lapEnd,
            laps: laps > 0 ? laps : 1
          });
        });
  
        // Map OpenF1 tire data
        const stintDrivers = (lastRaceResults.Results || []).slice(0, 3).map(r => {
          const dNum = parseInt(r.number);
          const sData = driverMap[dNum] || [];
          return {
            num: dNum,
            code: r.Driver?.code || '',
            driver: `${(r.Driver?.givenName || '').charAt(0)}. ${r.Driver?.familyName || ''}`,
            stints: sData.sort((a,b) => a.lap_start - b.lap_start)
          };
        }).filter(d => d.stints.length > 0);
  
        if (stintDrivers.length > 0) {
          stints = { total_laps: maxLap, drivers: stintDrivers };
        }
      }
  
      let last_race = null;
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
  
        let qualifying = null;
        const qualiRace = getRaces(qualiData)[0];
        if (qualiRace && qualiRace.QualifyingResults && qualiRace.QualifyingResults.length > 0) {
          const p1 = qualiRace.QualifyingResults[0];
          qualifying = {
            pole: {
              driver_short: `${(p1.Driver?.givenName || '').charAt(0)}. ${p1.Driver?.familyName || ''}`,
              time: p1.Q3 || p1.Q2 || p1.Q1 || ''
            },
            results: qualiRace.QualifyingResults.map(q => ({
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
          weather,     
          stints       
        };
      }
  
      // 2. Map out the winners for every completed race
      const winners = {};
      const allCompletedRaces = getRaces(winnersData);
      allCompletedRaces.forEach(r => {
        if (r.Results && r.Results.length > 0) {
           const d = r.Results[0].Driver;
           winners[r.round] = `${(d.givenName || '').charAt(0)}. ${d.familyName || ''}`;
        }
      });
  
      res.status(200).json({ 
        drivers, 
        constructors, 
        schedule, 
        next_race, 
        last_race,
        winners, // 3. Pass the newly built winners dictionary to the frontend
        _fetched_at_utc: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }