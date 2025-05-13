const express = require('express');
const axios = require('axios');
const redis = require('redis');
const rateLimit = require('express-rate-limit');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

console.log('Starting app...');
console.log('REDIS_URL:', process.env.REDIS_URL ? 'Set' : 'Missing');
console.log('HOSTAWAY_ACCOUNT_ID:', process.env.HOSTAWAY_ACCOUNT_ID ? 'Set' : 'Missing');
console.log('HOSTAWAY_API_KEY:', process.env.HOSTAWAY_API_KEY ? 'Set' : 'Missing');

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(err => {
  console.error('Redis connection error:', err.message, err.stack);
  process.exit(1); // Exit to ensure crash is logged
});

const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY = process.env.HOSTAWAY_API_KEY;
const LISTING_IDS = {
  "Cantwell Lodge": 124502,
  "3BR Bungalow": 297337,
  "2BR Bungalow 1": 182391,
  "2BR Bungalow 2": 182427,
  "2BR Bungalow 3": 182428,
  "Bungalow Buyout": 182431
};

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100
});
app.use(limiter);

async function getAccessToken() {
  const cacheKey = 'hostaway:token';
  try {
    const cachedToken = await redisClient.get(cacheKey);
    if (cachedToken) {
      console.log('Using cached Hostaway token');
      return cachedToken;
    }

    console.log('Fetching new Hostaway token...');
    const response = await axios.post('https://api.hostaway.com/v1/accessTokens', {
      grant_type: 'client_credentials',
      client_id: HOSTAWAY_ACCOUNT_ID,
      client_secret: HOSTAWAY_API_KEY,
      scope: 'general'
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const token = response.data.access_token;
    await redisClient.setEx(cacheKey, 3600 * 24 * 30, token);
    console.log('New Hostaway token fetched and cached');
    return token;
  } catch (e) {
    console.error('Error getting access token:', e.response?.data || e.message, e.stack);
    throw e;
  }
}

async function getUnavailableDates(listingId) {
  const cacheKey = `availability:${listingId}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log(`Using cached availability for listing ${listingId}`);
      return JSON.parse(cached);
    }

    console.log(`Fetching availability for listing ${listingId}...`);
    const token = await getAccessToken();
    const response = await axios.get(`https://api.hostaway.com/v1/reservations?listingId=${listingId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const reservations = response.data.data || [];
    const unavailable = new Set();
    reservations.forEach(res => {
      let d = new Date(res.arrivalDate);
      const end = new Date(res.departureDate);
      while (d < end) {
        unavailable.add(d.toISOString().split("T")[0]);
        d.setDate(d.getDate() + 1);
      }
    });
    const result = Array.from(unavailable);
    await redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
    console.log(`Availability for listing ${listingId} fetched and cached`);
    return result;
  } catch (e) {
    console.error('Error fetching reservations:', e.response?.data || e.message, e.stack);
    return [];
  }
}

app.get('/availability/:dwelling', async (req, res) => {
  const dwelling = req.params.dwelling;
  const listingId = LISTING_IDS[dwelling];
  if (!listingId) {
    console.error(`Invalid dwelling: ${dwelling}`);
    return res.status(400).json({ error: 'Invalid dwelling' });
  }

  try {
    console.log(`Handling availability request for ${dwelling} (listing ${listingId})`);
    const unavailable = await getUnavailableDates(listingId);
    res.json({ unavailable });
  } catch (e) {
    console.error('Error in availability endpoint:', e.message, e.stack);
    res.json({ unavailable: [] });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
