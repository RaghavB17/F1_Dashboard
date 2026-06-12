let cachedToken = null;
let tokenExpiry = 0;

async function getOpenF1Token() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  
  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;
  
  if (!username || !password) {
    console.warn('[TELEMETRY AUTH] Missing OpenF1 credentials in Vercel Env Vars.');
    return null;
  }
  
  try {
    const params = new URLSearchParams();
    params.append("username", username);
    params.append("password", password);
    
    console.log('[TELEMETRY AUTH] Requesting new OpenF1 token...');
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
    
    console.log('[TELEMETRY AUTH] Token acquired successfully.');
    return cachedToken;
  } catch (error) {
    console.error('[TELEMETRY AUTH ERROR]', error.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at the edge for 5 seconds to absorb polling and protect OpenF1 rate limits
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
      
      console.log(`[PROXY] Fetching -> ${url}`);
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        console.error(`[PROXY ERROR] ${url} -> HTTP ${response.status}`);
        if (response.status === 401) throw new Error('AUTH_REQUIRED');
        if (response.status === 429) throw new Error('RATE_LIMITED');
        throw new Error(`OpenF1 Error: ${response.status}`);
      }
      return response.json();
    };

    // Aggregate 4 requests into 1 to save client bandwidth and adhere to limits
    if (endpoint === 'timing') {
      console.log('[PROXY] Initiating aggregated timing fetch...');
      const [pos, int, laps, stints] = await Promise.all([
        fetchOpenF1('position', queryParams),
        fetchOpenF1('intervals', queryParams),
        fetchOpenF1('laps', queryParams),
        fetchOpenF1('stints', { session_key: queryParams.session_key || 'latest' })
      ]);
      console.log('[PROXY] Timing data aggregated successfully.');
      return res.status(200).json({ pos, int, laps, stints });
    } 
    else {
      const data = await fetchOpenF1(endpoint, queryParams);
      return res.status(200).json(data);
    }
  } catch (error) {
    console.error('[PROXY CRITICAL ERROR]', error.message);
    if (error.message === 'RATE_LIMITED') return res.status(429).json({ error: 'Rate limited by OpenF1' });
    if (error.message === 'AUTH_REQUIRED') return res.status(401).json({ error: 'AUTH_REQUIRED' });
    res.status(500).json({ error: 'Internal Server Error' });
  }
}