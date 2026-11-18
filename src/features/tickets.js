const {
  ChannelType, PermissionFlagsBits, MessageFlags, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle,
} = require('discord.js');
const config = require('../config');
const { canCloseTicket, replyEphemeral, ticketOwnerId } = require('../security/permissions');

const ticketOperations = new Map();
const CHECKPOINT_MARKER = '\nticket-closure:';
const DISCORD_ID_PATTERN = /^\d{17,20}$/;

function withTicketLock(key, operation) {
  const previous = ticketOperations.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  ticketOperations.set(key, current);
  return current.finally(() => {
    if (ticketOperations.get(key) === current) ticketOperations.delete(key);
  });
}

function isTicketChannel(channel) {
  const name = String(channel?.name || '');
  const ticketName = name.startsWith('ticket-') || name.startsWith('closed-ticket-');
  return Boolean(channel
    && channel.type === ChannelType.GuildText
    && ticketName
    && ticketOwnerId(channel)
    && (!config.channels?.tickets || channel.parentId === config.channels.tickets));
}

function hasClosureCheckpoint(channel) {
  return String(channel?.topic || '').includes('ticket-closure:');
}

function buildTicketOverwrites(guild, userId, botUserId) {
  if (!DISCORD_ID_PATTERN.test(String(userId)) || !DISCORD_ID_PATTERN.test(String(botUserId))) {
    throw new Error('Valid ticket owner and bot user IDs are required.');
  }
  const view = PermissionFlagsBits.ViewChannel;
  const send = PermissionFlagsBits.SendMessages;
  const history = PermissionFlagsBits.ReadMessageHistory;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [view] },
    { id: userId, allow: [view, send, history, PermissionFlagsBits.AttachFiles] },
    { id: botUserId, allow: [view, send, history, PermissionFlagsBits.EmbedLinks] },
  ];
  for (const roleId of [config.roles?.staff, config.roles?.moderator].filter(Boolean)) {
    overwrites.push({ id: roleId, allow: [view, send, history] });
  }
  return overwrites;
}

async function findRecentMessageByMarker(channel, marker) {
  if (!channel?.messages?.fetch) throw new Error('Message history access is required for idempotent ticket auditing.');
  const recent = await channel.messages.fetch({ limit: 100 });
  const messages = recent?.values ? Array.from(recent.values()) : Array.isArray(recent) ? recent : [];
  return messages.find((message) => String(message.content || '').includes(marker)) || null;
}

async function fetchMessage(channel, messageId) {
  if (!messageId || !channel?.messages?.fetch) return null;
  try { return await channel.messages.fetch(messageId); } catch { return null; }
}

async function getModLogChannel(guild) {
  if (!config.channels?.modLog) throw new Error('Ticket archiving requires CHANNEL_MOD_LOG to be configured.');
  const channel = await guild.channels.fetch(config.channels.modLog);
  if (!channel || channel.guildId !== guild.id || typeof channel.send !== 'function'
    || typeof channel.messages?.fetch !== 'function') {
    throw new Error('The configured mod-log channel must be an accessible guild text channel with read-history and send access.');
  }
  return channel;
}

async function writeCheckpoint(channel, baseTopic, checkpoint) {
  const nextTopic = `${baseTopic}${CHECKPOINT_MARKER}${JSON.stringify(checkpoint)}`;
  if (nextTopic.length > 1024) throw new Error('There is no room for a ticket closure checkpoint.');
  await channel.setTopic(nextTopic, 'Checkpoint ticket closure');
}

function recoverLegacyClosureMetadata(checkpoint, auditMessage, actorId, reason) {
  if (checkpoint.actorId && checkpoint.closedAt && typeof checkpoint.reason === 'string') return checkpoint;
  const content = String(auditMessage?.content || '');
  const match = content.match(/^Ticket archived by user (\d{17,20}) at (\S+)\. Reason: ([\s\S]*?)\. Support history is retained for staff\./);
  checkpoint.actorId = checkpoint.actorId || match?.[1] || actorId;
  checkpoint.closedAt = checkpoint.closedAt || match?.[2] || new Date().toISOString();
  checkpoint.reason = typeof checkpoint.reason === 'string' ? checkpoint.reason : (match?.[3] || String(reason).slice(0, 300));
  return checkpoint;
}

async function archiveTicket(channel, { ownerId, actorId, reason = 'Closed through support controls' }) {
  return withTicketLock(`close:${channel.id}`, async () => {
    const current = typeof channel.fetch === 'function' ? await channel.fetch(true) : channel;
    if (!isTicketChannel(current)) throw new Error('This channel is not a valid support ticket.');
    const actualOwnerId = ticketOwnerId(current);
    if (!DISCORD_ID_PATTERN.test(String(ownerId)) || actualOwnerId !== ownerId) {
      throw new Error('A valid ticket owner is required before archiving.');
    }
    if (!DISCORD_ID_PATTERN.test(String(actorId))) throw new Error('A valid closure actor is required before archiving.');
    if (!current.permissionOverwrites?.edit || !current.send || !current.setName || !current.setTopic
      || !current.messages?.fetch || !current.guild) {
      throw new Error('This channel cannot be safely archived.');
    }
    const topic = String(current.topic || '');
    const checkpointIndex = topic.lastIndexOf(CHECKPOINT_MARKER);
    if (String(current.name).startsWith('closed-') && checkpointIndex === -1) {
      throw new Error('Closed ticket is missing its closure checkpoint.');
    }
    const baseTopic = checkpointIndex === -1 ? topic : topic.slice(0, checkpointIndex);
    let checkpoint;

    if (checkpointIndex !== -1) {
      checkpoint = JSON.parse(topic.slice(checkpointIndex + CHECKPOINT_MARKER.length));
      if (checkpoint.ownerId !== ownerId
        || !/^closed-/.test(String(checkpoint.closedName || ''))
        || checkpoint.closedName.length > 100
        || (checkpoint.auditMessageId !== null && checkpoint.auditMessageId !== undefined
          && !DISCORD_ID_PATTERN.test(String(checkpoint.auditMessageId)))
        || (checkpoint.modLogMessageId !== null && checkpoint.modLogMessageId !== undefined
          && !DISCORD_ID_PATTERN.test(String(checkpoint.modLogMessageId)))) {
        throw new Error('Invalid ticket closure checkpoint.');
      }
      const previousAudit = await fetchMessage(current, checkpoint.auditMessageId);
      recoverLegacyClosureMetadata(checkpoint, previousAudit, actorId, reason);
      if (!Object.hasOwn(checkpoint, 'modLogMessageId')) checkpoint.modLogMessageId = null;
      if (!DISCORD_ID_PATTERN.test(String(checkpoint.actorId))
        || !Number.isFinite(Date.parse(checkpoint.closedAt))
        || typeof checkpoint.reason !== 'string') {
        throw new Error('Invalid ticket closure metadata.');
      }
      if (String(current.name).startsWith('closed-') && checkpoint.auditMessageId && checkpoint.modLogMessageId) {
        return { alreadyClosed: true, auditMessageId: checkpoint.auditMessageId, modLogMessageId: checkpoint.modLogMessageId };
      }
    }

    const modLogChannel = await getModLogChannel(current.guild);
    if (checkpointIndex === -1) {
      checkpoint = {
        ownerId,
        actorId,
        closedAt: new Date().toISOString(),
        reason: String(reason).slice(0, 300),
        auditMessageId: null,
        modLogMessageId: null,
        closedName: `closed-${current.name}`.slice(0, 100),
      };
      await writeCheckpoint(current, baseTopic, checkpoint);
    }

    await current.permissionOverwrites.edit(ownerId, {
      ViewChannel: false, SendMessages: false, SendMessagesInThreads: false,
      CreatePublicThreads: false, CreatePrivateThreads: false, AddReactions: false,
    }, 'Archive a closed support ticket for staff');

    const ticketMarker = `ticket-archive:${current.id}`;
    let ticketAudit = await fetchMessage(current, checkpoint.auditMessageId);
    if (!ticketAudit) ticketAudit = await findRecentMessageByMarker(current, ticketMarker);
    if (!ticketAudit) {
      ticketAudit = await current.send({
        content: `Ticket archived. Ticket: #${checkpoint.closedName} (${current.id}). Owner: ${ownerId}. Closed by: ${checkpoint.actorId} at ${checkpoint.closedAt}. Reason: ${checkpoint.reason}. Support history is retained for staff. ${ticketMarker}`,
        allowedMentions: { parse: [] },
      });
    }
    if (checkpoint.auditMessageId !== ticketAudit.id) {
      checkpoint.auditMessageId = ticketAudit.id;
      await writeCheckpoint(current, baseTopic, checkpoint);
    }

    const modLogMarker = `ticket-archive-log:${current.id}`;
    let modLogAudit = await fetchMessage(modLogChannel, checkpoint.modLogMessageId);
    if (!modLogAudit) modLogAudit = await findRecentMessageByMarker(modLogChannel, modLogMarker);
    if (!modLogAudit) {
      modLogAudit = await modLogChannel.send({
        content: `**Support ticket archived**\nTicket: #${checkpoint.closedName} (${current.id})\nOwner: ${ownerId}\nClosed by: ${checkpoint.actorId}\nClosed at: ${checkpoint.closedAt}\nReason: ${checkpoint.reason}\nHistory remains in the archived ticket channel. ${modLogMarker}`,
        allowedMentions: { parse: [] },
      });
    }
    if (checkpoint.modLogMessageId !== modLogAudit.id) {
      checkpoint.modLogMessageId = modLogAudit.id;
      await writeCheckpoint(current, baseTopic, checkpoint);
    }

    const alreadyClosed = String(current.name).startsWith('closed-');
    if (!alreadyClosed) await current.setName(checkpoint.closedName, 'Preserve closed ticket history');
    return { alreadyClosed, auditMessageId: checkpoint.auditMessageId, modLogMessageId: checkpoint.modLogMessageId };
  });
}

function ticketChannelName(user) {
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 35);
  return `ticket-${safeName || 'member'}-${user.id.slice(-4)}`.slice(0, 90);
}

async function findExistingTicket(guild, userId) {
  const channels = await guild.channels.fetch();
  return channels.find((channel) => isTicketChannel(channel)
    && !String(channel.name).startsWith('closed-')
    && !hasClosureCheckpoint(channel)
    && ticketOwnerId(channel) === userId) || null;
}

async function rollbackTicketChannel(channel, ownerId, setupError) {
  try {
    await channel.delete('Ticket setup failed; remove incomplete ticket channel');
    return { deleted: true, orphaned: false };
  } catch (deleteError) {
    const cleanup = [];
    if (channel.permissionOverwrites?.edit) cleanup.push(channel.permissionOverwrites.edit(ownerId, {
      ViewChannel: false, SendMessages: false, ReadMessageHistory: false,
    }, 'Hide incomplete ticket after setup failure'));
    if (channel.setTopic) cleanup.push(channel.setTopic(`ticket-orphaned:${ownerId}`, 'Mark incomplete ticket for staff cleanup'));
    if (channel.setName) cleanup.push(channel.setName(`orphan-${channel.name}`.slice(0, 100), 'Mark incomplete ticket for staff cleanup'));
    await Promise.allSettled(cleanup);
    try {
      const modLog = await getModLogChannel(channel.guild);
      const marker = `ticket-setup-failed:${channel.id}`;
      const existing = await findRecentMessageByMarker(modLog, marker);
      if (!existing) await modLog.send({
        content: `**Ticket setup cleanup failed**\nChannel: ${channel.name} (${channel.id})\nOwner: ${ownerId}\nThe incomplete channel was marked orphaned for staff cleanup. Setup error: ${String(setupError?.code || 'UNKNOWN')}. Cleanup error: ${String(deleteError?.code || 'UNKNOWN')}. ${marker}`,
        allowedMentions: { parse: [] },
      });
    } catch (logError) {
      console.error('Unable to record orphaned ticket cleanup in mod-log:', logError);
    }
    console.error('Unable to delete incomplete ticket channel; marked for staff cleanup:', deleteError);
    return { deleted: false, orphaned: true };
  }
}

async function createTicketChannel({ guild, user, botUserId, openingPayload }) {
  const permissionOverwrites = buildTicketOverwrites(guild, user.id, botUserId);
  const channel = await guild.channels.create({
    name: ticketChannelName(user),
    type: ChannelType.GuildText,
    parent: config.channels.tickets || undefined,
    topic: `ticket-owner:${user.id}`,
    permissionOverwrites,
    reason: `Support ticket opened by ${user.tag || user.username}`,
  });
  try {
    await channel.send(openingPayload);
  } catch (error) {
    await rollbackTicketChannel(channel, user.id, error);
    throw error;
  }
  return channel;
}

async function finish(interaction, content) {
  if (interaction.deferred) return interaction.editReply({ content });
  return replyEphemeral(interaction, content);
}

async function handleTicket(interaction) {
  if (!interaction.inGuild()) return replyEphemeral(interaction, 'Tickets can only be used inside the Chaotic Gaming server.');
  if (interaction.isButton() && interaction.customId === 'ticket_open') {
    const existing = await findExistingTicket(interaction.guild, interaction.user.id);
    if (existing) return replyEphemeral(interaction, `You already have an open ticket: ${existing}`);
    const modal = new ModalBuilder().setCustomId('ticket_reason').setTitle('Open a ticket')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('What do you need help with?')
          .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)
      ));
    return interaction.showModal(modal);
  }
  if (interaction.isModalSubmit() && interaction.customId === 'ticket_reason') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      return await withTicketLock(`open:${interaction.guild.id}:${interaction.user.id}`, async () => {
        const existing = await findExistingTicket(interaction.guild, interaction.user.id);
        if (existing) return finish(interaction, `You already have an open ticket: ${existing}`);
        const reason = interaction.fields.getTextInputValue('reason').trim().slice(0, 1000);
        if (!reason) return finish(interaction, 'Please provide a short description before opening a ticket.');
        const embed = new EmbedBuilder().setColor(config.colors.primary).setTitle('SUPPORT TICKET')
          .setDescription(`Opened by ${interaction.user}\n\n**Issue:** ${reason}`).setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
        );
        const channel = await createTicketChannel({
          guild: interaction.guild,
          user: interaction.user,
          botUserId: interaction.client.user.id,
          openingPayload: {
            content: config.roles.staff ? `<@${interaction.user.id}> <@&${config.roles.staff}>` : `<@${interaction.user.id}>`,
            embeds: [embed],
            components: [row],
            allowedMentions: { users: [interaction.user.id], roles: config.roles.staff ? [config.roles.staff] : [] },
          },
        });
        return finish(interaction, `Your private ticket is ready: ${channel}`);
      });
    } catch (error) {
      console.error('Ticket creation failed:', error);
      return finish(interaction, 'The ticket could not be opened. Please retry or contact staff.');
    }
  }
  if (interaction.isButton() && interaction.customId === 'ticket_close') {
    if (!isTicketChannel(interaction.channel)) {
      return replyEphemeral(interaction, 'This is not a valid support ticket channel.');
    }
    if (!canCloseTicket(interaction, interaction.channel)) {
      return replyEphemeral(interaction, 'Only the ticket owner or authorized staff can close this ticket.');
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await archiveTicket(interaction.channel, {
        ownerId: ticketOwnerId(interaction.channel), actorId: interaction.user.id,
      });
      return finish(interaction, result.alreadyClosed
        ? 'This ticket is already archived and recorded in the staff mod-log.'
        : 'Ticket archived. Support history is retained for staff and recorded in the staff mod-log.');
    } catch (error) {
      console.error('Ticket archive failed:', error);
      return finish(interaction, 'The ticket could not be fully archived. No channel was deleted; please contact staff.');
    }
  }
}

module.exports = {
  handleTicket,
  withTicketLock,
  archiveTicket,
  isTicketChannel,
  findExistingTicket,
  buildTicketOverwrites,
  createTicketChannel,
};
