const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync('src/features/tickets.js', 'utf8'), {
    module, console, require: () => ({}),
  });
  return module.exports;
}
function channel(options = {}) {
  const calls = [];
  const c = { id: 'channel', name: 'ticket-member-1234',
    fetch: async () => c,
    permissionOverwrites: { edit: async (id, flags) => { calls.push(['permissions', id, flags]); if (options.failPermissions) throw new Error('permission failure'); } },
    send: async (payload) => { calls.push(['audit', payload]); if (options.failAudit) throw new Error('audit failure'); },
    setName: async (name) => { calls.push(['rename', name]); c.name = name; },
    delete: async () => { calls.push(['DELETE']); },
  };
  return { c, calls };
}
const meta = { ownerId: '12345678901234567', actorId: '23456789012345678' };
test('overlapping opens for the same user serialize and create only once', async () => {
  const { withTicketLock } = load(); let unblock; const gate = new Promise((r) => { unblock = r; });
  let created = false, count = 0;
  const first = withTicketLock('same-user', async () => { await gate; if (!created) { created = true; count++; } });
  const second = withTicketLock('same-user', async () => { if (!created) { created = true; count++; } });
  unblock(); await Promise.all([first, second]); assert.equal(count, 1);
});
test('a failed operation releases its guard for a retry', async () => {
  const { withTicketLock } = load();
  await assert.rejects(withTicketLock('user', async () => { throw new Error('failure'); }), /failure/);
  assert.equal(await withTicketLock('user', async () => 'retried'), 'retried');
});
test('archive restricts the owner, records closure and preserves the channel', async () => {
  const { archiveTicket } = load(); const { c, calls } = channel();
  await archiveTicket(c, meta);
  assert.equal(calls[0][0], 'permissions'); assert.equal(calls[0][2].ViewChannel, false);
  assert.equal(calls[0][2].SendMessagesInThreads, false);
  assert.equal(calls[1][0], 'audit'); assert.match(calls[1][1].content, /23456789012345678/);
  assert.equal(calls[1][1].allowedMentions.parse.length, 0);
  assert.equal(calls[2][0], 'rename'); assert.match(c.name, /^closed-/);
  assert.equal(calls.some((c) => c[0] === 'DELETE'), false);
});
test('repeated close is idempotent and keeps the existing history', async () => {
  const { archiveTicket } = load(); const { c, calls } = channel();
  await archiveTicket(c, meta); const count = calls.length;
  assert.equal((await archiveTicket(c, meta)).alreadyClosed, true);
  assert.equal(calls.length, count);
});
test('permission failure does not delete, audit or rename the channel', async () => {
  const { archiveTicket } = load(); const { c, calls } = channel({ failPermissions: true });
  await assert.rejects(archiveTicket(c, meta), /permission failure/);
  assert.equal(calls.length, 1); assert.equal(c.name, 'ticket-member-1234');
});
test('audit failure retains the channel and does not falsely mark it closed', async () => {
  const { archiveTicket } = load(); const { c, calls } = channel({ failAudit: true });
  await assert.rejects(archiveTicket(c, meta), /audit failure/);
  assert.equal(calls.some((c) => c[0] === 'DELETE' || c[0] === 'rename'), false);
});
test('missing ticket ownership fails before any mutations', async () => {
  const { archiveTicket } = load(); const { c, calls } = channel();
  await assert.rejects(archiveTicket(c, { actorId: meta.actorId }), /valid ticket owner/);
  assert.equal(calls.length, 0);
});
