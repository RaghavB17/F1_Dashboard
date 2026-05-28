export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Extract the driver code from the URL (e.g., ?code=VER)
    // Note: Vercel routes /api/driver/VER to this file if set up with path parameters, 
    // but for simplicity in a basic setup, you can read it from the query string.
    const driverCode = req.query.code || 'UNKNOWN';
  
    const payload = {
      career: { wins: 0, poles: 0 },
      season_results: []
    };
  
    res.status(200).json(payload);
  }