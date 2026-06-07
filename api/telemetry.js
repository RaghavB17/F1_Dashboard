// Cache the token in serverless memory
let cachedToken = null;
let tokenExpiry = 0;

async function getOpenF1Token() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;

  if (!username || !password) return null;

  try {
    const params = new URLSearchParams();
    params.append("username", username);
    params.append("password", password);

    const response = await fetch("https://api.openf1.org/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
    });

    if (!response.ok) throw new Error(`Auth failed: ${response.status}`);

    const tokenData = await response.json();
    cachedToken = tokenData.access_token;
    const expiresInSeconds = parseInt(tokenData.expires_in) || 3600;
    tokenExpiry = Date.now() + (expiresInSeconds * 1000);

    return cachedToken;
  } catch (error) {
    console.error('Failed to retrieve OpenF1 token:', error.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache for 5 seconds at the edge to absorb frontend polling
  res.setHeader('Cache-Control', 's-maxage=5'); 

  const { endpoint, ...queryParams } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint parameter' });

  try {
    const token = await getOpenF1Token();
    const headers = { 'accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const fetchOpenF1 = async (path, qsObj = {}) => {
      const finalQs = {};
      for (const key in qsObj) {
        if (key === 'timeWindow') finalQs['date>='] = qsObj[key];
        else finalQs[key] = qsObj[key];
      }
      const qsString = new URLSearchParams(finalQs).toString();
      const url = `https://api.openf1.org/v1/${path}?${qsString}`;
      
      console.log(`[PROXY] Fetching -> ${url}`); // <-- ADDED LOG
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        console.error(`[PROXY ERROR] ${url} returned ${response.status}`); // <-- ADDED LOG
        if (response.status === 401) throw new Error('AUTH_REQUIRED');
        if (response.status === 429) throw new Error('RATE_LIMITED');
        throw new Error(`OpenF1 Error: ${response.status}`);
      }
      return response.json();
    };

    // THE FIX: Combine the 4 timing endpoints into 1 backend request to prevent 429s
    if (endpoint === 'timing') {
      const [pos, int, laps, stints] = await Promise.all([
        fetchOpenF1('position', queryParams),
        fetchOpenF1('intervals', queryParams),
        fetchOpenF1('laps', queryParams),
        fetchOpenF1('stints', { session_key: queryParams.session_key || 'latest' })
      ]);
      return res.status(200).json({ pos, int, laps, stints });
    } 
    
    // Pass through standard single requests (sessions, drivers, location)
    else {
      const data = await fetchOpenF1(endpoint, queryParams);
      return res.status(200).json(data);
    }
    
  } catch (error) {
    if (error.message === 'RATE_LIMITED') return res.status(429).json({ error: 'Rate limited by OpenF1' });
    if (error.message === 'AUTH_REQUIRED') return res.status(401).json({ error: 'AUTH_REQUIRED' });
    res.status(500).json({ error: 'Internal Server Error' });
  }
}