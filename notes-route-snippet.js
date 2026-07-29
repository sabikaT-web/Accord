// ---------------------------------------------------------------------------
// Private notes — add this route to server.js (near the other /cases/:id routes)
// Also add a column if it does not exist yet:
//
//   ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_notes TEXT;
//   ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_notes  TEXT;
//
// Or a single private_notes per party stored against the party, depending on
// how your schema is structured. The example below stores per-role notes on
// the case row.
// ---------------------------------------------------------------------------

app.post('/cases/:id/notes', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'That case does not exist.' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).render('message', { title: 'No access', body: 'You are not a party to this case.' });

  const notes = String(req.body.notes || '').trim().slice(0, 4000);

  // Prefer role-specific columns so each party only ever sees their own notes.
  if (role === 'claim') {
    await pool.query('UPDATE cases SET claim_notes = $1 WHERE id = $2', [notes || null, c.id]);
  } else {
    await pool.query('UPDATE cases SET resp_notes = $1 WHERE id = $2', [notes || null, c.id]);
  }

  // Optional audit (do not put the note text itself in the event log)
  await db.addEvent(c.id, 'notes', (role === 'claim' ? 'Claimant' : 'Respondent') + ' updated private notes');

  res.redirect('/cases/' + c.id + '?msg=' + encodeURIComponent('Private notes saved.'));
}));

// When rendering the case page, pass the viewer's own notes:
//
//   const privateNotes = role === 'claim' ? (c.claim_notes || '') : (c.resp_notes || '');
//   res.render('case', { c, role, ..., privateNotes });
//
// And in viewerStatus / caseDetail ensure claim_notes / resp_notes are selected.
