const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const config = {
  ownerId: null,
  roles: {
    staff: 'staff-role',
    moderator: 'moderator-role',
  },
};

function loadPermissions() {
  const filename = path.join(__dirname, '../src/security/permissions.js');
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const discord = {
    MessageFlags: { Ephemeral: 64 },
    PermissionFlagsBits: { Administrator: 8 },
  };

  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === 'discord.js') return discord;
      if (specifier === '../config') return config;
      throw new Error(`Unexpected dependency: ${specifier}`);
    },
  }, { filename });

  return module.exports;
}

const { canCloseTicket } = loadPermissions();
const ownerId = '123456789012345678';
const staffId = '223456789012345678';
const ticketChannel = { topic: `ticket-owner:${ownerId}` };

test('configured staff can close a ticket owned by another user', () => {
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
