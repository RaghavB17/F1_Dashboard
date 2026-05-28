export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600');
    
    const code = (req.query.code || '').toUpperCase();
    if (!code) return res.status(200).json({ career: {}, season_results: [] });
  
    try {
      const drvRes = await fetch(`https://api.jolpi.ca/ergast/f1/drivers.json?limit=1000`);
      if (!drvRes.ok) throw new Error('Driver fetch failed');
      const drvData = await drvRes.json();
      const driver = drvData?.MRData?.DriverTable?.Drivers?.find(d => d.code === code);
      
      // Soft fail instead of crashing if driver isn't found
      if (!driver) return res.status(200).json({ career: {}, season_results: [] }); 
      const driverId = driver.driverId;
  
      const [winsRes, polesRes, resultsRes] = await Promise.all([
        fetch(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/results/1.json?limit=1`).then(r => r.json()).catch(() => ({})),
        fetch(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/qualifying/1.json?limit=1`).then(r => r.json()).catch(() => ({})),
        fetch(`https://api.jolpi.ca/ergast/f1/current/drivers/${driverId}/results.json`).then(r => r.json()).catch(() => ({}))
      ]);
  
      const career = {
        wins: parseInt(winsRes?.MRData?.total || 0),
        poles: parseInt(polesRes?.MRData?.total || 0)
      };
  
      const races = resultsRes?.MRData?.RaceTable?.Races || [];
      const season_results = races.map(r => ({
        pos: parseInt(r.Results?.[0]?.position || 0),
        status: r.Results?.[0]?.status || '',
        short_name: (r.raceName || '').replace(' Grand Prix', ''),
        points: parseFloat(r.Results?.[0]?.points || 0)
      })).reverse().slice(0, 5); 
  
      res.status(200).json({ career, season_results });
    } catch (error) {
      // Return empty payload so it doesn't crash the frontend UI
      res.status(200).json({ career: { wins: 0, poles: 0 }, season_results: [] });
    }
  }