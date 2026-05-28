export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600');
  
    try {
      // Fetch all required data from Jolpica F1 concurrently for speed
      const [driversRes, consRes, schedRes, lastRaceRes, qualiRes] = await Promise.all([
        fetch('https://api.jolpi.ca/ergast/f1/current/driverStandings.json'),
        fetch('https://api.jolpi.ca/ergast/f1/current/constructorStandings.json'),
        fetch('https://api.jolpi.ca/ergast/f1/current.json'),
        fetch('https://api.jolpi.ca/ergast/f1/current/last/results.json'),
        fetch('https://api.jolpi.ca/ergast/f1/current/last/qualifying.json')
      ]);
  
      const driversData = await driversRes.json();
      const consData = await consRes.json();
      const schedData = await schedRes.json();
      const lastRaceData = await lastRaceRes.json();
      const qualiData = await qualiRes.json();
  
      // 1. Parse Drivers
      const driverList = driversData.MRData.StandingsTable.StandingsLists[0]?.DriverStandings || [];
      const topPts = driverList.length ? parseFloat(driverList[0].points) : 0;
      const drivers = driverList.map(d => ({
        code: d.Driver.code,
        short_name: `${d.Driver.givenName.charAt(0)}. ${d.Driver.familyName}`,
        given_name: d.Driver.givenName,
        family_name: d.Driver.familyName,
        pos: parseInt(d.position),
        pts: parseFloat(d.points),
        wins: parseInt(d.wins),
        nationality: d.Driver.nationality,
        team_id: d.Constructors[0]?.constructorId.replace(/\s+/g, '_').toLowerCase(),
        team_name: d.Constructors[0]?.name,
        gap: topPts - parseFloat(d.points) > 0 ? (topPts - parseFloat(d.points)) : 0
      }));
  
      // 2. Parse Constructors
      const consList = consData.MRData.StandingsTable.StandingsLists[0]?.ConstructorStandings || [];
      const maxConPts = consList.length ? parseFloat(consList[0].points) : 1;
      const constructors = consList.map(c => ({
        id: c.Constructor.constructorId.replace(/\s+/g, '_').toLowerCase(),
        name: c.Constructor.name,
        pos: parseInt(c.position),
        pts: parseFloat(c.points),
        wins: parseInt(c.wins),
        nationality: c.Constructor.nationality,
        pct: (parseFloat(c.points) / maxConPts) * 100
      }));
  
      // 3. Parse Schedule & Find Next Race
      const races = schedData.MRData.RaceTable.Races || [];
      const now = new Date();
      const schedule = races.map(r => {
        const raceDate = new Date(`${r.date}T${r.time || '15:00:00Z'}`);
        return {
          round: parseInt(r.round),
          country: r.Circuit.Location.country,
          locality: r.Circuit.Location.locality,
          circuit: r.Circuit.circuitName,
          circuit_id: r.Circuit.circuitId,
          short_name: r.raceName.replace(' Grand Prix', ''),
          start_utc: raceDate.toISOString(),
          status: raceDate > now ? 'upcoming' : 'done'
        };
      });
      const next_race = schedule.find(r => r.status === 'upcoming') || null;
  
      // 4. Parse Last Race Details & Qualifying
      let last_race = null;
      const lastRaceResults = lastRaceData.MRData.RaceTable.Races[0];
      if (lastRaceResults) {
        const podium = lastRaceResults.Results.slice(0, 3).map(r => ({
          driver: `${r.Driver.givenName.charAt(0)}. ${r.Driver.familyName}`,
          driver_short: `${r.Driver.givenName.charAt(0)}. ${r.Driver.familyName}`,
          team_id: r.Constructor.constructorId.replace(/\s+/g, '_').toLowerCase(),
          team: r.Constructor.name,
          time: r.Time ? r.Time.time : r.status,
          number: r.number
        }));
  
        const flResult = lastRaceResults.Results.find(r => r.FastestLap && r.FastestLap.rank === "1");
        const fastest_lap = flResult ? {
          driver: `${flResult.Driver.givenName.charAt(0)}. ${flResult.Driver.familyName}`,
          time: flResult.FastestLap.Time.time,
          lap: flResult.FastestLap.lap
        } : null;
  
        // Qualifying
        let qualifying = null;
        const qualiRace = qualiData.MRData.RaceTable.Races[0];
        if (qualiRace) {
          qualifying = {
            pole: {
              driver_short: `${qualiRace.QualifyingResults[0].Driver.givenName.charAt(0)}. ${qualiRace.QualifyingResults[0].Driver.familyName}`,
              time: qualiRace.QualifyingResults[0].Q3 || qualiRace.QualifyingResults[0].Q2 || qualiRace.QualifyingResults[0].Q1
            },
            results: qualiRace.QualifyingResults.slice(0, 5).map(q => ({
              pos: parseInt(q.position),
              driver_short: `${q.Driver.givenName.charAt(0)}. ${q.Driver.familyName}`,
              team_id: q.Constructor.constructorId.replace(/\s+/g, '_').toLowerCase(),
              team: q.Constructor.name,
              q1: q.Q1, q2: q.Q2, q3: q.Q3,
              best: q.Q3 || q.Q2 || q.Q1
            }))
          };
        }
  
        last_race = {
          round: parseInt(lastRaceResults.round),
          short_name: lastRaceResults.raceName.replace(' Grand Prix', ''),
          circuit: lastRaceResults.Circuit.circuitName,
          country: lastRaceResults.Circuit.Location.country,
          podium,
          fastest_lap,
          qualifying,
          weather: null, // Requires OpenF1 mapping
          stints: null   // Requires OpenF1 mapping
        };
      }
  
      res.status(200).json({ drivers, constructors, schedule, next_race, last_race });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }