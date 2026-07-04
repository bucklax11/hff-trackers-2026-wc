// api/sync-scores.js
// Vercel Serverless Function — fetches live World Cup scores from ESPN
// and writes win/draw/loss results into Firestore.
//
// SETUP REQUIRED:
// 1. npm install firebase-admin  (add to package.json)
// 2. In Vercel dashboard → Settings → Environment Variables, add:
//      FIREBASE_SERVICE_ACCOUNT  =  (paste the entire contents of your
//      downloaded service account JSON file as one line)

const admin = require('firebase-admin');

// Initialize Firebase Admin SDK once (reused across warm invocations)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const NAME_MAP = {
  'United States': 'USA',
  'Korea Republic': 'South Korea',
  'South Korea': 'South Korea',
  "Côte d'Ivoire": 'Ivory Coast',
  'Ivory Coast': 'Ivory Coast',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'DR Congo': 'DR Congo',
  'Czech Republic': 'Czechia',
};

function normalizeName(espnName) {
  return NAME_MAP[espnName] || espnName;
}

const TRACKED_TEAMS = [
  'Norway','Colombia','Bosnia & Herz.','Egypt','England','Mexico','Senegal','Uzbekistan',
  'Argentina','Japan','Canada','Australia','France','Austria','Turkey','Haiti',
  'Spain','Ecuador','Sweden','Panama','Brazil','Croatia','Ivory Coast','Cape Verde',
  'Portugal','Switzerland','Scotland','Tunisia','Germany','Morocco','Paraguay','Iran',
  'Netherlands','USA','Algeria','Czechia','Belgium','Uruguay','Ghana','South Korea'
];

const KNOCKOUT_SLUGS = ['round-of-32','round-of-16','quarterfinals','semifinals','third-place','final'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    const espnRes = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=200&dates=20260611-20260719'
    );

    if (!espnRes.ok) {
      return res.status(502).json({ error: 'ESPN API unreachable', status: espnRes.status });
    }

    const data = await espnRes.json();
    const events = (data.events || []).sort((a, b) => {
      return new Date(a.date) - new Date(b.date);
    });

    const teamResults = {};
    TRACKED_TEAMS.forEach(t => { teamResults[t] = []; });

    const knockoutEliminated = new Set();
    let matchesProcessed = 0;

    for (const event of events) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const completed = comp.status?.type?.completed;
      if (!completed) continue;

      const competitors = comp.competitors || [];
      if (competitors.length !== 2) continue;

      const [a, b] = competitors;
      const nameA = normalizeName(a.team.displayName);
      const nameB = normalizeName(b.team.displayName);
      const scoreA = parseInt(a.score, 10);
      const scoreB = parseInt(b.score, 10);

      const aTracked = TRACKED_TEAMS.includes(nameA);
      const bTracked = TRACKED_TEAMS.includes(nameB);
      if (!aTracked && !bTracked) continue;

      // Log every match involving a tracked team so we can debug
      console.log(`MATCH: ${nameA} vs ${nameB} | ${scoreA}-${scoreB} | date: ${event.date} | slug: ${event.season?.slug || event.slug || 'none'} | resultsA so far: ${teamResults[nameA]?.length} | resultsB so far: ${teamResults[nameB]?.length}`);

      // Use both slug AND result count to detect knockout rounds.
      // Group stage = max 3 matches per team. Anything beyond 3 is knockout.
      const slug = event.season?.slug || event.slug || event.type?.slug || '';
      const isKnockoutBySlug = KNOCKOUT_SLUGS.some(s => slug.includes(s));
      const isKnockoutByCount = teamResults[nameA]?.length >= 3 || teamResults[nameB]?.length >= 3;
      const isKnockout = isKnockoutBySlug || isKnockoutByCount;

      let resultA, resultB;
      if (scoreA > scoreB)      { resultA = 'W'; resultB = 'L'; }
      else if (scoreA < scoreB) { resultA = 'L'; resultB = 'W'; }
      else                      { resultA = 'D'; resultB = 'D'; }

      // Only add to group stage results if not a knockout match
      // and team hasn't already accumulated 3 group results
      if (!isKnockout) {
        if (aTracked && teamResults[nameA].length < 3) teamResults[nameA].push(resultA);
        if (bTracked && teamResults[nameB].length < 3) teamResults[nameB].push(resultB);
      }

      if (isKnockout) {
        if (aTracked && resultA === 'L') knockoutEliminated.add(nameA);
        if (bTracked && resultB === 'L') knockoutEliminated.add(nameB);
      }

      matchesProcessed++;
    }

    const teamsSnap = await db.collection('teams').get();
    const batch = db.batch();
    let teamsUpdated = 0;

    teamsSnap.forEach(docSnap => {
      const team = docSnap.data();
      const espnResults = teamResults[team.name];
      const updates = {};

      if (espnResults && espnResults.length > 0) {
        const currentCompleted = team.results.filter(r => r !== '?').length;
        if (espnResults.length >= currentCompleted) {
          const padded = [...espnResults];
          while (padded.length < 3) padded.push('?');
          updates.results = padded;
        }
      }

      if (knockoutEliminated.has(team.name) && !team.eliminated) {
        updates.eliminated = true;
      }

      if (Object.keys(updates).length > 0) {
        batch.update(docSnap.ref, updates);
        teamsUpdated++;
      }
    });

    await batch.commit();

    return res.status(200).json({
      success: true,
      matchesProcessed,
      teamsUpdated,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
};
