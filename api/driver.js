export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600');
    
    const code = (req.query.code || '').toUpperCase();
    if (!code) {
      return res.status(200).json({ career: { wins: 0, poles: 0 }, season_results: [], championships: [] });
    }
  
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
  
      // 1. Get driverId quickly
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
          return res.status(200).json({ career: { wins: 0, poles: 0 }, season_results: [], championships: [] });
      }
  
      // 2. Fetch career stats, recent form, AND World Championships concurrently
      const [winsData, polesData, resultsData, champsData] = await Promise.all([
        fetchJson(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/results/1.json?limit=1`),
        fetchJson(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/qualifying/1.json?limit=1`),
        fetchJson(`https://api.jolpi.ca/ergast/f1/current/drivers/${driverId}/results.json`),
        // BUG FIX: Fetch ALL historical standings instead of filtering via URL
        fetchJson(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/driverStandings.json?limit=100`) 
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
  
      // 4. BULLETPROOF CHAMPIONSHIP PROCESSING
      const champLists = champsData?.MRData?.StandingsTable?.StandingsLists || [];
      const currentYear = new Date().getFullYear().toString();
      
      // Filter the standings manually in javascript
      const championships = champLists
        .filter(list => {
          // Verify they finished in Position 1
          const isFirst = list.DriverStandings && list.DriverStandings[0] && list.DriverStandings[0].position === "1";
          // Ignore the current ongoing season
          const isPastSeason = list.season !== currentYear;
          return isFirst && isPastSeason;
        })
        .map(list => list.season);
  
      res.status(200).json({ career, season_results, championships });
    } catch (error) {
      res.status(200).json({ career: { wins: 0, poles: 0 }, season_results: [], championships: [] });
    }
  }