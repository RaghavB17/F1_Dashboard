export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600');
    
    const code = (req.query.code || '').toUpperCase();
    if (!code) {
      return res.status(200).json({ career: { wins: 0, poles: 0 }, season_results: [], championships: [] });
    }
  
    // Hardcoded active World Champions for lightning-fast lookups. 
    // This completely bypasses the Jolpica "season_year" API limitation.
    const WORLD_CHAMPIONS = {
      'HAM': ['2008', '2014', '2015', '2017', '2018', '2019', '2020'],
      'VER': ['2021', '2022', '2023', '2024'], 
      'ALO': ['2005', '2006'],
      'NOR': ['2025']
    };
  
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
  
      // 1. Get driverId quickly from the current standings
      const drvData = await fetchJson('https://api.jolpi.ca/ergast/f1/current/driverStandings.json');
      const driverList = drvData?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
      
      let driverId = null;
      const driverMatch = driverList.find(d => d.Driver?.code === code);
      
      if (driverMatch) {
          driverId = driverMatch.Driver.driverId;
      } else {
          const allDrvData = await fetchJson('https://api.jolpi.ca/ergast/f1/drivers.json?limit=1000');
          const allDrivers = allDrvData?.MRData?.DriverTable?.Drivers || [];
          const fallbackMatch = allDrivers.find(d => d.code === code);
          if (fallbackMatch) driverId = fallbackMatch.driverId;
      }
      
      if (!driverId) {
          return res.status(200).json({ 
              career: { wins: 0, poles: 0 }, 
              season_results: [], 
              championships: WORLD_CHAMPIONS[code] || [] 
          });
      }
  
      // 2. Fetch career stats and recent form concurrently
      const [winsData, polesData, resultsData] = await Promise.all([
        fetchJson(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/results/1.json?limit=1`),
        fetchJson(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/qualifying/1.json?limit=1`),
        fetchJson(`https://api.jolpi.ca/ergast/f1/current/drivers/${driverId}/results.json`)
      ]);
  
      const career = {
        wins: parseInt(winsData?.MRData?.total || 0),
        poles: parseInt(polesData?.MRData?.total || 0)
      };
  
      // 3. Process recent form
      const races = resultsData?.MRData?.RaceTable?.Races || [];
      let season_results = races.map(r => {
        const resObj = r.Results?.[0] || {};
        return {
          pos: parseInt(resObj.position || 0),
          status: resObj.status || '',
          short_name: (r.raceName || '').replace(' Grand Prix', ''),
          points: parseFloat(resObj.points || 0)
        };
      }).reverse().slice(0, 5); 
  
      // Fallback: If current season has no races yet, fetch last year's results
      if (season_results.length === 0) {
         const lastYearData = await fetchJson(`https://api.jolpi.ca/ergast/f1/2025/drivers/${driverId}/results.json`);
         const lastYearRaces = lastYearData?.MRData?.RaceTable?.Races || [];
         season_results = lastYearRaces.map(r => {
           const resObj = r.Results?.[0] || {};
           return {
             pos: parseInt(resObj.position || 0),
             status: resObj.status || '',
             short_name: (r.raceName || '').replace(' Grand Prix', ''),
             points: parseFloat(resObj.points || 0)
           };
         }).reverse().slice(0, 5);
      }
  
      // 4. Instant Championship Lookup
      const championships = WORLD_CHAMPIONS[code] || [];
  
      res.status(200).json({ career, season_results, championships });
    } catch (error) {
      // Return safe fallback so the UI never crashes
      res.status(200).json({ 
          career: { wins: 0, poles: 0 }, 
          season_results: [], 
          championships: WORLD_CHAMPIONS[code] || [] 
      });
    }
  }