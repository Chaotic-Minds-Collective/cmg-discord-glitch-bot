const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const OWNER_ID = '12345678901234567';
const ACTOR_ID = '23456789012345678';
const BOT_ID = '34567890123456789';
const MODLOG_ID = '45678901234567890';
const TICKET_AUDIT_ID = '56789012345678901';

function permissionsForTests() {
  return {
    canCloseTicket: () => true,
    replyEphemeral: async () => {},
    ticketOwnerId(channel) {
      const match = String(channel?.topic || '').match(/(?:^|\s)ticket-owner:(\d{17,20})(?:\s|$)/);
      return match ? match[1] : null;
    },
  };
}

function load() {
  const module = { exports: {} };
  const discord = {
    ChannelType: { GuildText: 'GUILD_TEXT' },
    PermissionFlagsBits: {
      ViewChannel: 'VIEW_CHANNEL', SendMessages: 'SEND_MESSAGES', ReadMessageHistory: 'READ_HISTORY',
      AttachFiles: 'ATTACH_FILES', EmbedLinks: 'EMBED_LINKS', SendMessagesInThreads: 'SEND_THREADS',
      CreatePublicThreads: 'CREATE_PUBLIC_THREADS', CreatePrivateThreads: 'CREATE_PRIVATE_THREADS', AddReactions: 'ADD_REACTIONS',
    },
    MessageFlags: { Ephemeral: 64 },
  };
  const config = {
    channels: { tickets: 'ticket-category', modLog: 'mod-log' },
    roles: { staff: 'staff-role', moderator: 'moderator-role' },
    colors: { primary: 0x00ffff },
  };
  const permissions = permissionsForTests();
  vm.runInNewContext(fs.readFileSync('src/features/tickets.js', 'utf8'), {
    module,
    console: { error: () => {} },
    require: (name) => name === 'discord.js' ? discord : name === '../config' ? config : name === '../security/permissions' ? permissions : {},
  });
  return module.exports;
}

function environment(options = {}) {
  const calls = [];
  const ticketMessages = [];
  const modLogMessages = [];
  const makeMessage = (id, payload) => ({ id, content: String(payload?.content || '') });
  const modLog = {
    id: 'mod-log',
    guildId: 'guild',
    send: async (payload) => {
      calls.push(['modlog-send', payload]);
      if (options.failModLog) throw new Error('mod-log failure');
      const message = makeMessage(MODLOG_ID, payload);
      modLogMessages.push(message);
      return message;
    },
    messages: {
      fetch: async (query) => typeof query === 'string'
        ? modLogMessages.find((message) => message.id === query) || null
        : new Map(modLogMessages.map((message) => [message.id, message])),
    },
  };
  const guild = {
    id: 'guild',
    roles: { everyone: { id: 'everyone' } },
    channels: {
      fetch: async (id) => id ? (id === 'mod-log' ? modLog : null) : [c],
    },
  };
  const c = {
    id: 'ticket-channel-id',
    name: 'ticket-member-1234',
    topic: `ticket-owner:${OWNER_ID}`,
    type: 'GUILD_TEXT',
    parentId: 'ticket-category',
    guildId: 'guild',
    guild,
    fetch: async () => c,
    permissionOverwrites: {
      edit: async (id, flags) => {
        calls.push(['permissions', id, flags]);
        if (options.failPermissions) throw new Error('permission failure');
      },
    },
    send: async (payload) => {
      calls.push(['ticket-send', payload]);
      if (options.failAudit) throw new Error('audit failure');
      const message = makeMessage(TICKET_AUDIT_ID, payload);
      ticketMessages.push(message);
      return message;
    },
    messages: {
      fetch: async (query) => typeof query === 'string'
        ? ticketMessages.find((message) => message.id === query) || null
        : new Map(ticketMessages.map((message) => [message.id, message])),
    },
    setTopic: async (topic) => {
      calls.push(['checkpoint', topic]);
      if (options.failTopic) throw new Error('topic failure');
      c.topic = topic;
    },
    setName: async (name) => {
      calls.push(['rename', name]);
      if (options.failRename) throw new Error('rename failure');
      c.name = name;
    },
    delete: async () => {
      calls.push(['DELETE']);
      if (options.failDelete) throw new Error('delete failure');
    },
  };
  return { c, calls, guild, modLog, modLogMessages, ticketMessages, options };
}

const meta = { ownerId: OWNER_ID, actorId: ACTOR_ID, reason: 'Account access help' };

test('overlapping opens for the same user serialize and create only once', async () => {
  const { withTicketLock } = load();
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  let created = false;
  let count = 0;
  const first = withTicketLock('same-user', async () => { await gate; if (!created) { created = true; count++; } });
  const second = withTicketLock('same-user', async () => { if (!created) { created = true; count++; } });
  unblock();
  await Promise.all([first, second]);
  assert.equal(count, 1);
});

test('a failed operation releases its guard for a retry', async () => {
  const { withTicketLock } = load();
  await assert.rejects(withTicketLock('user', async () => { throw new Error('failure'); }), /failure/);
  assert.equal(await withTicketLock('user', async () => 'retried'), 'retried');
});

test('ticket identity requires a ticket name, owner metadata, text channel, and configured category', async () => {
  const { isTicketChannel } = load();
  const valid = { type: 'GUILD_TEXT', name: 'ticket-member-1234', parentId: 'ticket-category', topic: `ticket-owner:${OWNER_ID}` };
  assert.equal(isTicketChannel(valid), true);
  assert.equal(isTicketChannel({ ...valid, parentId: 'other-category' }), false);
  assert.equal(isTicketChannel({ ...valid, name: 'general' }), false);
  assert.equal(isTicketChannel({ ...valid, type: 'GUILD_VOICE' }), false);
  assert.equal(isTicketChannel({ ...valid, topic: 'ordinary channel' }), false);
});

test('existing-ticket recovery finds only open ticket channels from channel metadata', async () => {
  const { findExistingTicket } = load();
  const open = { type: 'GUILD_TEXT', name: 'ticket-member-1234', parentId: 'ticket-category', topic: `ticket-owner:${OWNER_ID}` };
  const closing = { ...open, topic: `${open.topic}\nticket-closure:{}` };
  const closed = { ...open, name: 'closed-ticket-member-1234' };
  const orphan = { ...open, name: 'orphan-ticket-member-1234', topic: `ticket-orphaned:${OWNER_ID}` };
  const wrongCategory = { ...open, parentId: 'other-category' };
  const guild = { channels: { fetch: async () => [closed, closing, orphan, wrongCategory, open] } };
  assert.equal(await findExistingTicket(guild, OWNER_ID), open);
});

test('ticket creation explicitly grants the bot minimum channel access', () => {
  const { buildTicketOverwrites } = load();
  const overwrites = buildTicketOverwrites({ roles: { everyone: { id: 'everyone' } } }, OWNER_ID, BOT_ID);
  const botOverwrite = overwrites.find((overwrite) => overwrite.id === BOT_ID);
  assert.ok(botOverwrite);
  assert.deepEqual([...botOverwrite.allow], ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_HISTORY', 'EMBED_LINKS']);
  assert.deepEqual([...overwrites.find((overwrite) => overwrite.id === OWNER_ID).allow],
    ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_HISTORY', 'ATTACH_FILES']);
});

test('failed initial ticket message deletes the incomplete channel', async () => {
  const { createTicketChannel } = load();
  let createdOptions;
  let deleted = false;
  const channel = {
    id: 'ticket-channel-id',
    name: 'ticket-member-1234',
    send: async () => { throw new Error('initial message failure'); },
    delete: async () => { deleted = true; },
  };
  const guild = {
    roles: { everyone: { id: 'everyone' } },
    channels: { create: async (options) => { createdOptions = options; return channel; } },
  };
  await assert.rejects(createTicketChannel({ guild, user: { id: OWNER_ID, username: 'member' }, botUserId: BOT_ID, openingPayload: {} }), /initial message failure/);
  assert.equal(deleted, true);
  assert.ok(createdOptions.permissionOverwrites.some((overwrite) => overwrite.id === BOT_ID));
});

test('failed deletion marks the incomplete channel orphaned and records it in mod-log', async () => {
  const { createTicketChannel } = load();
  const env = environment();
  let options;
  const channel = {
    id: 'orphan-channel-id',
    name: 'ticket-member-1234',
    guild: env.guild,
    permissionOverwrites: { edit: async () => {} },
    send: async () => { throw new Error('initial message failure'); },
    delete: async () => { throw new Error('delete failure'); },
    setTopic: async (topic) => { channel.topic = topic; },
    setName: async (name) => { channel.name = name; },
  };
  const guild = {
    id: 'guild',
    roles: { everyone: { id: 'everyone' } },
    channels: {
      create: async (createOptions) => { options = createOptions; return channel; },
      fetch: async (id) => id === 'mod-log' ? env.modLog : null,
    },
  };
  channel.guild = guild;
  await assert.rejects(createTicketChannel({ guild, user: { id: OWNER_ID, username: 'member' }, botUserId: BOT_ID, openingPayload: {} }), /initial message failure/);
  assert.match(channel.name, /^orphan-/);
  assert.equal(channel.topic, `ticket-orphaned:${OWNER_ID}`);
  assert.ok(env.modLogMessages.some((message) => message.content.includes('ticket-setup-failed:orphan-channel-id')));
  assert.ok(options.permissionOverwrites.some((overwrite) => overwrite.id === BOT_ID));
});

test('archive restricts the owner, records closure in staff mod-log, and preserves the channel', async () => {
  const { archiveTicket } = load();
  const env = environment();
  const result = await archiveTicket(env.c, meta);
  assert.equal(result.alreadyClosed, false);
  assert.equal(env.calls.some(([kind]) => kind === 'DELETE'), false);
  assert.ok(env.calls.some(([kind, id, flags]) => kind === 'permissions' && id === OWNER_ID && flags.ViewChannel === false));
  assert.ok(env.calls.some(([kind, payload]) => kind === 'ticket-send' && payload.content.includes(ACTOR_ID)));
  assert.equal(env.modLogMessages.length, 1);
  assert.match(env.modLogMessages[0].content, new RegExp(env.c.id));
  assert.match(env.modLogMessages[0].content, new RegExp(OWNER_ID));
  assert.match(env.modLogMessages[0].content, new RegExp(ACTOR_ID));
  assert.match(env.modLogMessages[0].content, /Account access help/);
  assert.equal(env.calls.at(-1)[0], 'rename');
  assert.match(env.c.name, /^closed-ticket-/);
  const checkpoint = JSON.parse(env.c.topic.split('\nticket-closure:')[1]);
  assert.equal(checkpoint.ownerId, OWNER_ID);
  assert.equal(checkpoint.modLogMessageId, MODLOG_ID);
  assert.equal(checkpoint.auditMessageId, TICKET_AUDIT_ID);
});

test('repeated close is idempotent and does not duplicate audit or permission changes', async () => {
  const { archiveTicket } = load();
  const env = environment();
  await archiveTicket(env.c, meta);
  const count = env.calls.length;
  assert.equal((await archiveTicket(env.c, meta)).alreadyClosed, true);
  assert.equal(env.calls.length, count);
  assert.equal(env.modLogMessages.length, 1);
  assert.equal(env.ticketMessages.length, 1);
});

test('permission failure does not send audit messages or rename the channel', async () => {
  const { archiveTicket } = load();
  const env = environment({ failPermissions: true });
  await assert.rejects(archiveTicket(env.c, meta), /permission failure/);
  assert.equal(env.calls.some(([kind]) => kind === 'ticket-send' || kind === 'modlog-send' || kind === 'rename' || kind === 'DELETE'), false);
  assert.equal(env.c.name, 'ticket-member-1234');
});

test('ticket audit failure leaves the channel in a resumable closing state', async () => {
  const { archiveTicket, findExistingTicket } = load();
  const env = environment({ failAudit: true });
  await assert.rejects(archiveTicket(env.c, meta), /audit failure/);
  assert.equal(env.calls.some(([kind]) => kind === 'modlog-send' || kind === 'rename' || kind === 'DELETE'), false);
  assert.equal(await findExistingTicket(env.guild, OWNER_ID), null);
  assert.ok(env.c.topic.includes('ticket-closure:'));
});

test('mod-log failure is resumable without duplicating the ticket audit', async () => {
  const { archiveTicket } = load();
  const env = environment({ failModLog: true });
  await assert.rejects(archiveTicket(env.c, meta), /mod-log failure/);
  assert.equal(env.ticketMessages.length, 1);
  assert.equal(env.modLogMessages.length, 0);
  env.options.failModLog = false;
  const retry = load();
  await retry.archiveTicket(env.c, meta);
  assert.equal(env.ticketMessages.length, 1);
  assert.equal(env.modLogMessages.length, 1);
  assert.match(env.c.name, /^closed-/);
});

test('retry after rename failure reuses persisted ticket and mod-log audit records after restart', async () => {
  const env = environment({ failRename: true });
  await assert.rejects(load().archiveTicket(env.c, meta), /rename failure/);
  const checkpoint = JSON.parse(env.c.topic.split('\nticket-closure:')[1]);
  assert.equal(checkpoint.ownerId, OWNER_ID);
  assert.equal(checkpoint.auditMessageId, TICKET_AUDIT_ID);
  assert.equal(checkpoint.modLogMessageId, MODLOG_ID);
  env.c.name = 'ticket-member-1234';
  env.options.failRename = false;
  const { archiveTicket } = load();
  await archiveTicket(env.c, { ownerId: OWNER_ID, actorId: '67890123456789012', reason: 'Retrying archive' });
  assert.equal(env.c.name, 'closed-ticket-member-1234');
  assert.equal(env.ticketMessages.length, 1);
  assert.equal(env.modLogMessages.length, 1);
  const count = env.calls.length;
  assert.equal((await archiveTicket(env.c, meta)).alreadyClosed, true);
  assert.equal(env.calls.length, count);
});

test('legacy closure checkpoint is completed using its original audit metadata', async () => {
  const { archiveTicket } = load();
  const env = environment();
  const oldAudit = { id: TICKET_AUDIT_ID, content: `Ticket archived by user ${ACTOR_ID} at 2026-11-10T10:00:00.000Z. Reason: Legacy reason. Support history is retained for staff.` };
  env.ticketMessages.push(oldAudit);
  const legacy = { ownerId: OWNER_ID, auditMessageId: TICKET_AUDIT_ID, closedName: 'closed-ticket-member-1234' };
  env.c.topic = `ticket-owner:${OWNER_ID}\nticket-closure:${JSON.stringify(legacy)}`;
  await archiveTicket(env.c, { ownerId: OWNER_ID, actorId: '67890123456789012', reason: 'Retry reason' });
  assert.match(env.modLogMessages[0].content, new RegExp(ACTOR_ID));
  assert.match(env.modLogMessages[0].content, /2026-11-10T10:00:00.000Z/);
  assert.match(env.modLogMessages[0].content, /Legacy reason/);
});

test('wrong owner and non-ticket channel cannot be archived', async () => {
  const { archiveTicket } = load();
  const env = environment();
  await assert.rejects(archiveTicket(env.c, { ownerId: '67890123456789012', actorId: ACTOR_ID }), /valid ticket owner/);
  const nonTicket = { ...env.c, name: 'general' };
  nonTicket.fetch = async () => nonTicket;
  await assert.rejects(archiveTicket(nonTicket, meta), /not a valid support ticket/);
  const uncheckpointedClosed = { ...env.c, name: 'closed-ticket-member-1234' };
  uncheckpointedClosed.fetch = async () => uncheckpointedClosed;
  await assert.rejects(archiveTicket(uncheckpointedClosed, meta), /missing its closure checkpoint/);
  assert.equal(env.calls.length, 0);
});

test('a topic without checkpoint capacity fails before any mutations', async () => {
  const { archiveTicket } = load();
  const env = environment();
  env.c.topic = `ticket-owner:${OWNER_ID}\n${'x'.repeat(1000)}`;
  await assert.rejects(archiveTicket(env.c, meta), /no room/);
  assert.equal(env.calls.length, 0);
});
