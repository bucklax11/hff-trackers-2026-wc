// api/sync-scores.js
// Vercel Serverless Function — fetches live World Cup scores from ESPN
// and writes win/draw/loss results and advancement into Firestore.

const admin = require('firebase-admin');

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
  'Cabo Verde': 'Cape Verde',
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

// Maps ESPN slug to the advancement stage the WINNER earns
const SLUG_TO_ADV = {
  'round-of-32':    'R16',
  'round-of-16':    'QF',
  'quarterfinals':  'SF',
  'semifinals':     'F',
  'final':          'W',
};

// Maps ESPN slug to the advancement stage that was needed to GET to this match
// i.e. both participants in a round-of-32 match have already advanced to R32
const SLUG_TO_CURRENT = {
  'round-of-32':    'R32',
  'round-of-16':    'R16',
  'quarterfinals':  'QF',
  'semifinals':     'SF',
  'final':          'F',
};

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

    // Sort by date so group stage always processed before knockout rounds
    const events = (data.events || []).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Track group stage results per team (max 3)
    const teamResults = {};
    TRACKED_TEAMS.forEach(t => { teamResults[t] = []; });

    // Track which advancement badges each team has earned
    // key: team name, value: Set of stage strings e.g. {'R32','R16'}
    const teamAdvanced = {};
    TRACKED_TEAMS.forEach(t => { teamAdvanced[t] = new Set(); });

    // Track eliminations
    const eliminated = new Set();

    let matchesProcessed = 0;

    for (const event of events) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      if (!comp.status?.type?.completed) continue;

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

      const slug = event.season?.slug || event.slug || event.type?.slug || '';
      const matchedSlug = Object.keys(SLUG_TO_ADV).find(s => slug.includes(s));
      const isKnockoutBySlug = !!matchedSlug;
      const isKnockoutByCount = teamResults[nameA]?.length >= 3 || teamResults[nameB]?.length >= 3;
      const isKnockout = isKnockoutBySlug || isKnockoutByCount;

      // Determine winner — handle penalty shootout (ESPN marks winner with homeAway='winner')
      let winnerName = null;
      let loserName = null;
      if (scoreA > scoreB) {
        winnerName = nameA; loserName = nameB;
      } else if (scoreB > scoreA) {
        winnerName = nameB; loserName = nameA;
      } else {
        // Scores level — check for penalty winner via ESPN's winner flag
        const aWinner = a.winner === true;
        const bWinner = b.winner === true;
        if (aWinner) { winnerName = nameA; loserName = nameB; }
        else if (bWinner) { winnerName = nameB; loserName = nameA; }
      }

      if (!isKnockout) {
        // Group stage — record W/D/L (max 3 per team)
        let resultA, resultB;
        if (scoreA > scoreB)      { resultA = 'W'; resultB = 'L'; }
        else if (scoreA < scoreB) { resultA = 'L'; resultB = 'W'; }
        else                      { resultA = 'D'; resultB = 'D'; }

        if (aTracked && teamResults[nameA].length < 3) teamResults[nameA].push(resultA);
        if (bTracked && teamResults[nameB].length < 3) teamResults[nameB].push(resultB);
      } else {
        // Knockout round
        const advStage = matchedSlug ? SLUG_TO_ADV[matchedSlug] : null;
        const currentStage = matchedSlug ? SLUG_TO_CURRENT[matchedSlug] : null;

        // Both participants earned the current stage badge just by playing in this match
        if (currentStage) {
          if (aTracked) teamAdvanced[nameA].add(currentStage);
          if (bTracked) teamAdvanced[nameB].add(currentStage);
        }

        // Winner earns the next stage badge
        if (advStage && winnerName && TRACKED_TEAMS.includes(winnerName)) {
          teamAdvanced[winnerName].add(advStage);
        }

        // Loser is eliminated
        if (loserName && TRACKED_TEAMS.includes(loserName)) {
          eliminated.add(loserName);
        }
      }

      matchesProcessed++;
    }

    // Write all updates to Firestore
    const teamsSnap = await db.collection('teams').get();
    const batch = db.batch();
    let teamsUpdated = 0;

    teamsSnap.forEach(docSnap => {
      const team = docSnap.data();
      const updates = {};

      // Update group stage results
      const espnResults = teamResults[team.name];
      if (espnResults && espnResults.length > 0) {
        const padded = [...espnResults];
        while (padded.length < 3) padded.push('?');
        updates.results = padded;
      }

      // Update advanced array — merge ESPN data with existing Firestore data
      // so manually set advancements are never lost
      const espnAdv = teamAdvanced[team.name];
      if (espnAdv && espnAdv.size > 0) {
        const existing = new Set(team.advanced || []);
        espnAdv.forEach(s => existing.add(s));
        updates.advanced = Array.from(existing);
      }

      // Update eliminated — only set to true, never un-eliminate
      if (eliminated.has(team.name) && !team.eliminated) {
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
