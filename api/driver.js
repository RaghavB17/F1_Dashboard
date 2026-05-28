export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600');
    
    const code = (req.query.code || '').toUpperCase();
    if (!code) return res.status(200).json({ career: {}, season_results: [] });
  
    try {
      // 1. Find the specific Driver ID using their 3-letter code
      const drvRes = await fetch(`https://api.jolpi.ca/ergast/f1/drivers.json?limit=1000`);
      const drvData = await drvRes.json();
      const driver = drvData.MRData.DriverTable.Drivers.find(d => d.code === code);
      
      if (!driver) return res.status(404).json({ error: 'Driver not found' });
      const driverId = driver.driverId;
  
      // 2. Fetch their all-time stats and current season results
      const [winsRes, polesRes, resultsRes] = await Promise.all([
        fetch(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/results/1.json?limit=1`),
        fetch(`https://api.jolpi.ca/ergast/f1/drivers/${driverId}/qualifying/1.json?limit=1`),
        fetch(`https://api.jolpi.ca/ergast/f1/current/drivers/${driverId}/results.json`)
      ]);
  
      const winsData = await winsRes.json();
      const polesData = await polesRes.json();
      const resultsData = await resultsRes.json();
  
      const career = {
        wins: parseInt(winsData.MRData.total || 0),
        poles: parseInt(polesData.MRData.total || 0)
      };
  
      // Grab the last 5 races
      const season_results = (resultsData.MRData.RaceTable.Races || []).map(r => ({
        pos: parseInt(r.Results[0].position),
        status: r.Results[0].status,
        short_name: r.raceName.replace(' Grand Prix', ''),
        points: parseFloat(r.Results[0].points)
      })).reverse().slice(0, 5); 
  
      res.status(200).json({ career, season_results });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }