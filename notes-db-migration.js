// Add to db.js init() migrations (safe if already present):
await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_notes TEXT;`);
await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_notes  TEXT;`);

// Notes route is already in server.js (POST /cases/:id/notes).
// privateNotes is already passed when rendering the case page.
