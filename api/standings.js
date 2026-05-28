export default async function handler(req, res) {
    // Set CORS headers so your frontend can read the data
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600'); // Cache for 1 hour
  
    try {
      // 1. Fetch raw data from Jolpica F1 API
      const rawStandings = await fetch('https://api.jolpi.ca/ergast/f1/current/driverStandings.json');
      const standingsData = await rawStandings.json();
      
      // 2. Format the data to match exactly what your index.html expects
      const formattedDrivers = standingsData.MRData.StandingsTable.StandingsLists[0].DriverStandings.map(d => ({
        code: d.Driver.code,
        short_name: `${d.Driver.givenName.charAt(0)}. ${d.Driver.familyName}`,
        given_name: d.Driver.givenName,
        family_name: d.Driver.familyName,
        pos: parseInt(d.position),
        pts: parseFloat(d.points),
        wins: parseInt(d.wins),
        nationality: d.Driver.nationality,
        // Normalising team IDs to match your CSS variables
        team_id: d.Constructors[0].constructorId.replace(/\s+/g, '_').toLowerCase(),
        team_name: d.Constructors[0].name
      }));
  
      // 3. Construct the final JSON payload
      const payload = {
        drivers: formattedDrivers,
        constructors: [], // You would fetch constructorStandings.json here similarly
        schedule: [],     // You would fetch /current.json for the calendar here
        next_race: null,
        last_race: null
      };
  
      // 4. Send it to the frontend
      res.status(200).json(payload);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch standings' });
    }
  }