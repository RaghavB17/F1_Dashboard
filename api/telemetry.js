// Cache the token in serverless memory to prevent spamming the OpenF1 auth server
let cachedToken = null;
let tokenExpiry = 0;

async function getOpenF1Token() {
  // Reuse the token if it exists and hasn't expired (with a 60-second safety buffer)
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;

  if (!username || !password) {
    console.error('OpenF1 credentials missing from Vercel Environment Variables.');
    return null;
  }

  try {
    const tokenUrl = "https://api.openf1.org/token";
    
    // OpenF1 strictly requires application/x-www-form-urlencoded
    const params = new URLSearchParams();
    params.append("username", username);
    params.append("password", password);

    const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
    });

    if (!response.ok) {
        throw new Error(`Auth failed: ${response.status} ${await response.text()}`);
    }

    const tokenData = await response.json();
    
    // Save the token and calculate expiry time
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
  res.setHeader('Cache-Control', 's-maxage=2'); // Micro-cache to prevent frontend spam

  const { endpoint, ...queryParams } = req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint parameter' });
  }

  const qs = new URLSearchParams(queryParams).toString();
  const targetUrl = `https://api.openf1.org/v1/${endpoint}?${qs}`;

  try {
    // 1. Authenticate
    const token = await getOpenF1Token();
    
    const headers = { 'accept': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // 2. Fetch the live telemetry data from OpenF1
    const response = await fetch(targetUrl, { headers });
    
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(401).json({ error: 'AUTH_REQUIRED' });
      }
      return res.status(response.status).json({ error: `OpenF1 Error: ${response.status}` });
    }

    const data = await response.json();
    res.status(200).json(data);
    
  } catch (error) {
    console.error('Telemetry Proxy Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}