export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=30'); // Cache for only 30 seconds during live sessions
  
    // This is a simplified proxy to OpenF1. You would expand this to map their live timing arrays.
    const payload = {
      live: false, // Set to true dynamically if OpenF1 indicates an active session
      session: { type: "Race", country: "TBD", circuit: "TBD" },
      grid: [],
      race_control: []
    };
  
    res.status(200).json(payload);
  }