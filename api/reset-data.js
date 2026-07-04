// api/reset-data.js
// Wipes all team documents in Firestore and reseeds with clean group stage data.
// Call this from the admin panel any time you need a fresh start.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const SEED_DATA = [
  { id:'norway',      player:'Brett',  name:'Norway',         results:['W','W','L'], advanced:['R32'], eliminated:false },
  { id:'colombia',    player:'Brett',  name:'Colombia',       results:['W','D','W'], advanced:['R32'], eliminated:false },
  { id:'bosnia',      player:'Brett',  name:'Bosnia & Herz.', results:['D','L','W'], advanced:['R32'], eliminated:false },
  { id:'egypt',       player:'Brett',  name:'Egypt',          results:['D','W','D'], advanced:['R32'], eliminated:false },
  { id:'england',     player:'Rami',   name:'England',        results:['W','D','W'], advanced:['R32'], eliminated:false },
  { id:'mexico',      player:'Rami',   name:'Mexico',         results:['W','W','W'], advanced:['R32'], eliminated:false },
  { id:'senegal',     player:'Rami',   name:'Senegal',        results:['L','L','W'], advanced:['R32'], eliminated:false },
  { id:'uzbekistan',  player:'Rami',   name:'Uzbekistan',     results:['L','L','L'], advanced:[],      eliminated:true  },
  { id:'argentina',   player:'Van',    name:'Argentina',      results:['W','W','W'], advanced:['R32'], eliminated:false },
  { id:'japan',       player:'Van',    name:'Japan',          results:['D','W','D'], advanced:['R32'], eliminated:false },
  { id:'canada',      player:'Van',    name:'Canada',         results:['D','W','L'], advanced:['R32'], eliminated:false },
  { id:'australia',   player:'Van',    name:'Australia',      results:['L','L','D'], advanced:[],      eliminated:true  },
  { id:'france',      player:'Tyler',  name:'France',         results:['W','W','W'], advanced:['R32'], eliminated:false },
  { id:'austria',     player:'Tyler',  name:'Austria',        results:['W','L','D'], advanced:['R32'], eliminated:false },
  { id:'turkey',      player:'Tyler',  name:'Turkey',         results:['W','L','W'], advanced:[],      eliminated:true  },
  { id:'haiti',       player:'Tyler',  name:'Haiti',          results:['L','L','L'], advanced:[],      eliminated:true  },
  { id:'spain',       player:'Erich',  name:'Spain',          results:['D','W','W'], advanced:['R32'], eliminated:false },
  { id:'ecuador',     player:'Erich',  name:'Ecuador',        results:['L','D','W'], advanced:['R32'], eliminated:false },
  { id:'sweden',      player:'Erich',  name:'Sweden',         results:['W','L','D'], advanced:['R32'], eliminated:false },
  { id:'panama',      player:'Erich',  name:'Panama',         results:['D','L','L'], advanced:[],      eliminated:true  },
  { id:'brazil',      player:'Burk',   name:'Brazil',         results:['D','W','W'], advanced:['R32'], eliminated:false },
  { id:'croatia',     player:'Burk',   name:'Croatia',        results:['L','W','W'], advanced:['R32'], eliminated:false },
  { id:'ivorycoast',  player:'Burk',   name:'Ivory Coast',    results:['W','L','W'], advanced:['R32'], eliminated:false },
  { id:'capeverde',   player:'Burk',   name:'Cape Verde',     results:['D','D','D'], advanced:['R32'], eliminated:false },
  { id:'portugal',    player:'Zack',   name:'Portugal',       results:['D','W','D'], advanced:['R32'], eliminated:false },
  { id:'switzerland', player:'Zack',   name:'Switzerland',    results:['W','W','W'], advanced:['R32'], eliminated:false },
  { id:'scotland',    player:'Zack',   name:'Scotland',       results:['W','L','L'], advanced:[],      eliminated:true  },
  { id:'tunisia',     player:'Zack',   name:'Tunisia',        results:['L','L','L'], advanced:[],      eliminated:true  },
  { id:'germany',     player:'JR',     name:'Germany',        results:['W','W','L'], advanced:['R32'], eliminated:false },
  { id:'morocco',     player:'JR',     name:'Morocco',        results:['D','W','W'], advanced:['R32'], eliminated:false },
  { id:'paraguay',    player:'JR',     name:'Paraguay',       results:['L','W','D'], advanced:['R32'], eliminated:false },
  { id:'iran',        player:'JR',     name:'Iran',           results:['D','D','D'], advanced:[],      eliminated:true  },
  { id:'netherlands', player:'Kyle',   name:'Netherlands',    results:['D','W','W'], advanced:['R32'], eliminated:false },
  { id:'usa',         player:'Kyle',   name:'USA',            results:['W','W','L'], advanced:['R32'], eliminated:false },
  { id:'algeria',     player:'Kyle',   name:'Algeria',        results:['L','W','D'], advanced:['R32'], eliminated:false },
  { id:'czechia',     player:'Kyle',   name:'Czechia',        results:['L','D','L'], advanced:[],      eliminated:true  },
  { id:'belgium',     player:'Austin', name:'Belgium',        results:['D','D','W'], advanced:['R32'], eliminated:false },
  { id:'uruguay',     player:'Austin', name:'Uruguay',        results:['D','D','L'], advanced:[],      eliminated:true  },
  { id:'ghana',       player:'Austin', name:'Ghana',          results:['W','D','L'], advanced:['R32'], eliminated:false },
  { id:'southkorea',  player:'Austin', name:'South Korea',    results:['W','L','L'], advanced:[],      eliminated:true  },
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    // Delete all existing team documents
    const existing = await db.collection('teams').get();
    const deleteBatch = db.batch();
    existing.forEach(doc => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();

    // Reseed with clean data
    const seedBatch = db.batch();
    SEED_DATA.forEach(t => {
      seedBatch.set(doc(db, 'teams', t.id), {
        player: t.player,
        name: t.name,
        results: t.results,
        advanced: t.advanced,
        eliminated: t.eliminated,
      });
    });
    await seedBatch.commit();

    return res.status(200).json({
      success: true,
      message: `Deleted ${existing.size} documents, reseeded ${SEED_DATA.length} teams.`,
    });

  } catch (err) {
    console.error('Reset error:', err);
    return res.status(500).json({ error: err.message });
  }
};
