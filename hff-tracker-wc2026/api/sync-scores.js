// api/sync-scores.js
// Vercel Serverless Function — fetches live World Cup scores from ESPN
// and writes win/draw/loss results into Firestore.
//
// SETUP REQUIRED:
// 1. npm install firebase-admin  (add to package.json)
// 2. In Vercel dashboard → Settings → Environment Variables, add:
//      FIREBASE_SERVICE_ACCOUNT  =  (paste the entire contents of your
//      downloaded service account JSON file as one line)
//
// This endpoint is called by the "Sync Live Scores" button in the admin panel.

import admin from 'firebase-admin';

// Initialize Firebase Admin SDK once (reused across warm invocations)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// Maps ESPN's team display names to the exact team names used in your Firestore "teams" collection.
// Add entries here if ESPN's naming differs (e.g. "Korea Republic" vs "South Korea").
const NAME_MAP = {
  'United States': 'USA',
  'Korea Republic': 'South Korea',
  'South Korea': 'South Korea',
  'Côte d\'Ivoire': 'Ivory Coast',
  'Ivory Coast': 'Ivory Coast',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'DR Congo': 'DR Congo',
  'Czech Republic': 'Czechia',
};

function normalizeName(espnName) {
  return NAME_MAP[espnName] || espnName;
}

// Your 40 tracked teams — used to filter ESPN results down to only what matters
const TRACKED_TEAMS = [
  'Norway','Colombia','Bosnia & Herz.','Egypt','England','Mexico','Senegal','Uzbekistan',
  'Argentina','Japan','Canada','Australia','France','Austria','Turkey','Haiti',
  'Spain','Ecuador','Sweden','Panama','Brazil','Croatia','Ivory Coast','Cape Verde',
  'Portugal','Switzerland','Scotland','Tunisia','Germany','Morocco','Paraguay','Iran',
  'Netherlands','USA','Algeria','Czechia','Belgium','Uruguay','Ghana','South Korea'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    // Pull the full World Cup date range — group stage through final
    const espnRes = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=200&dates=20260611-20260719'
    );

    if (!espnRes.ok) {
      return res.status(502).json({ error: 'ESPN API unreachable', status: espnRes.status });
    }

    const data = await espnRes.json();
    const events = data.events || [];

    // Track results per team: { teamName: ['W','L',...] } only for completed matches
    const teamResults = {};
    TRACKED_TEAMS.forEach(t => { teamResults[t] = []; });

    let matchesProcessed = 0;

    for (const event of events) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const completed = comp.status?.type?.completed;
      if (!completed) continue; // skip in-progress or scheduled matches

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

      let resultA, resultB;
      if (scoreA > scoreB) { resultA = 'W'; resultB = 'L'; }
      else if (scoreA < scoreB) { resultA = 'L'; resultB = 'W'; }
      else { resultA = 'D'; resultB = 'D'; }

      if (aTracked) teamResults[nameA].push(resultA);
      if (bTracked) teamResults[nameB].push(resultB);
      matchesProcessed++;
    }

    // Write updated results arrays into Firestore for any team with new data
    const teamsSnap = await db.collection('teams').get();
    const batch = db.batch();
    let teamsUpdated = 0;

    teamsSnap.forEach(docSnap => {
      const team = docSnap.data();
      const espnResults = teamResults[team.name];
      if (espnResults && espnResults.length > 0) {
        // Only overwrite if ESPN shows more completed matches than we currently have
        const currentCompleted = team.results.filter(r => r !== '?').length;
        if (espnResults.length >= currentCompleted) {
          // Pad to 3 results, preserving '?' for unplayed matches
          const padded = [...espnResults];
          while (padded.length < 3) padded.push('?');
          batch.update(docSnap.ref, { results: padded });
          teamsUpdated++;
        }
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
}