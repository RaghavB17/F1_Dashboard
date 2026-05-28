export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=30');
  
    // Returns a clean, stable fallback so the frontend gracefully defaults
    // to the standard "paddock laps" non-live view without throwing errors.
    res.status(200).json({
      live: false,
      session: {},
      grid: [],
      race_control: []
    });
  }