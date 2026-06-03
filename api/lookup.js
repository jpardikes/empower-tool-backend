// ============================================================================
// Empower Field Engineer — Lookup Backend  (api/lookup.js)
// One serverless function, three jobs:
//   action:"property"  -> RentCast public-records lookup by address
//   action:"nameplate" -> Claude vision read of equipment nameplate photos
//   action:"rebates"   -> Claude + web search for current incentive programs
//   action:"ping"      -> health check (reports which keys are configured)
//
// Deploy on Vercel. Set these Environment Variables in the project:
//   ANTHROPIC_API_KEY   (required for nameplate + rebates)
//   RENTCAST_API_KEY    (required for property)
//   APP_TOKEN           (optional shared secret; if set, requests must send it)
// ============================================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RENTCAST_KEY  = process.env.RENTCAST_API_KEY;
const APP_TOKEN     = process.env.APP_TOKEN || '';

const NOW_YEAR = new Date().getFullYear();

function setCors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-token');
}

export default async function handler(req, res){
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'POST only' }); return; }

  // optional shared-secret gate
  if (APP_TOKEN && req.headers['x-app-token'] !== APP_TOKEN) {
    res.status(401).json({ error: 'Bad or missing app token' }); return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const action = body.action || '';

  try {
    if (action === 'ping')      { res.status(200).json({ ok: true, has: { anthropic: !!ANTHROPIC_KEY, rentcast: !!RENTCAST_KEY }, tokenRequired: !!APP_TOKEN }); return; }
    if (action === 'property')  { res.status(200).json(await getProperty(body));  return; }
    if (action === 'nameplate') { res.status(200).json(await getNameplate(body)); return; }
    if (action === 'rebates')   { res.status(200).json(await getRebates(body));   return; }
    res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------- PROPERTY
async function getProperty(body){
  if (!RENTCAST_KEY) throw new Error('RENTCAST_API_KEY not set on server');
  const address = (body.address || '').trim();
  if (!address) throw new Error('address required');

  const url = 'https://api.rentcast.io/v1/properties?address=' + encodeURIComponent(address);
  const r = await fetch(url, { headers: { 'X-Api-Key': RENTCAST_KEY, 'Accept': 'application/json' } });
  if (!r.ok) { const t = await r.text(); throw new Error('RentCast ' + r.status + ': ' + t.slice(0, 160)); }

  const data = await r.json();
  const rec = Array.isArray(data) ? data[0] : (data && data.id ? data : null);
  if (!rec) return { found: false, confidence: 'low', source: 'RentCast', notes: 'No public record found for that address.' };

  const sqft = rec.squareFootage || null;
  const yearBuilt = rec.yearBuilt || null;
  let stories = null;
  const fc = rec.features && (rec.features.floorCount || rec.features.stories);
  if (fc) stories = fc >= 3 ? '3+' : String(fc);

  return {
    found: true,
    sqft,
    yearBuilt,
    stories,
    propertyType: rec.propertyType || null,
    utilityProvider: null, // RentCast doesn't provide this; the rebate step infers it
    confidence: (sqft || yearBuilt) ? 'high' : 'low',
    source: 'RentCast public / tax-assessor records',
    notes: 'From county records. Verify square footage before sizing.'
  };
}

// ---------------------------------------------------------------- NAMEPLATE
const NAMEPLATE_PROMPT =
'You are reading the data/nameplate label or serial sticker of an HVAC unit from one or more photos. Extract ONLY what is actually visible. Respond with a single JSON object and nothing else — no markdown, no code fences, no commentary. Keys: ' +
'{"brand":string|null,"model":string|null,"serial":string|null,"sysTypeGuess":one of ["Central AC","Gas Furnace","AC + Furnace","Heat Pump","Boiler","Package Unit","Mini-Split"] or null,"tonnageGuess":string|null,"fuelGuess":one of ["Natural Gas","Electric","Propane","Oil","None"] or null,"mfgYearGuess":number|null,"ageYearsGuess":number|null,"dateReasoning":string,"confidence":"high"|"medium"|"low","readNotes":string}. ' +
'Serial-number date encoding differs by manufacturer and is often ambiguous. If you are not confident about the manufacture date, set mfgYearGuess and ageYearsGuess to null and explain why in dateReasoning. Never invent values you cannot read. The current year is ' + NOW_YEAR + '.';

async function getNameplate(body){
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set on server');
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) throw new Error('no images provided');

  const content = images.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: p.mediaType || 'image/jpeg', data: p.base64 }
  }));
  content.push({ type: 'text', text: NAMEPLATE_PROMPT });

  const text = await anthropic({ max_tokens: 1024, messages: [{ role: 'user', content }] });
  return parseJSON(text);
}

// ---------------------------------------------------------------- REBATES
async function getRebates(body){
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set on server');
  const address = (body.address || '').trim();
  if (!address) throw new Error('address required');
  const utility = body.utility || '';
  const types = body.systemTypes || 'HVAC system replacement';

  const prompt =
    'Find CURRENT (as of ' + NOW_YEAR + ') HVAC and heat-pump rebates, incentives, and tax credits available to a homeowner at this US location. ' +
    'Address: "' + address + '". ' + (utility ? 'Electric utility: "' + utility + '". ' : '') +
    'Equipment being considered: ' + types + '. Search federal, state, city/county, and utility programs, and verify they are active now (note that the federal 25C tax credit expired at the end of 2025). ' +
    'Respond with ONLY a JSON array (no markdown) of up to 6 of the most relevant ACTIVE programs. Each item: ' +
    '{"program":string,"level":"Federal"|"State"|"Utility"|"Local","covers":string,"estAmount":string,"eligibility":string,"url":string}. ' +
    'Keep each field to one short factual sentence. estAmount may be a range, or "Varies" if unknown. Only include programs you found real evidence for; do not invent.';

  const text = await anthropic({
    max_tokens: 1500,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  });

  let arr = parseJSON(text);
  if (!Array.isArray(arr)) arr = (arr && Array.isArray(arr.programs)) ? arr.programs : [];
  return { programs: arr };
}

// ---------------------------------------------------------------- HELPERS
async function anthropic(payload){
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(Object.assign({ model: 'claude-sonnet-4-20250514' }, payload))
  });
  const raw = await r.text();
  let data; try { data = JSON.parse(raw); } catch (e) { throw new Error('Anthropic non-JSON (' + r.status + '): ' + raw.slice(0, 160)); }
  if (!r.ok || data.error) throw new Error((data.error && data.error.message) || ('Anthropic HTTP ' + r.status));
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function parseJSON(text){
  let t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const oA = t.indexOf('{'), oB = t.lastIndexOf('}'), aA = t.indexOf('['), aB = t.lastIndexOf(']');
  if (aA >= 0 && (oA < 0 || aA < oA)) { try { return JSON.parse(t.slice(aA, aB + 1)); } catch (e) {} }
  if (oA >= 0) { try { return JSON.parse(t.slice(oA, oB + 1)); } catch (e) {} }
  throw new Error('Could not parse model output');
}
