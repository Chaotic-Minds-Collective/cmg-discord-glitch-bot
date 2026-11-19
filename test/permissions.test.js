const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../src/config');
const { canCloseTicket } = require('../src/security/permissions');

const ownerId = '123456789012345678';
const staffId = '223456789012345678';
const ticketChannel = { topic: `ticket-owner:${ownerId}` };

test('configured staff can close a ticket owned by another user', () => {
  assert.ok(config.roles.staff, 'a staff role must be configured for this test');

  const interaction = {
    user: { id: staffId },
    member: {
      roles: {
        cache: new Map([[config.roles.staff, {}]]),
      },
    },
  };

  assert.equal(canCloseTicket(interaction, ticketChannel), true);
});

test('users without the ticket-owner identity or a configured staff role cannot close a ticket', () => {
  const interaction = {
    user: { id: staffId },
    member: { roles: { cache: new Map() } },
  };

  assert.equal(canCloseTicket(interaction, ticketChannel), false);
});
