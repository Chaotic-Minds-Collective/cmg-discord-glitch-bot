const {
  ChannelType, PermissionFlagsBits, MessageFlags, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle,
} = require('discord.js');
const config = require('../config');
const { canCloseTicket, replyEphemeral, ticketOwnerId } = require('../security/permissions');

const ticketOperations = new Map();
function withTicketLock(key, operation) {
  const previous = ticketOperations.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  ticketOperations.set(key, current);
  return current.finally(() => {
    if (ticketOperations.get(key) === current) ticketOperations.delete(key);
  });
}

async function archiveTicket(channel, { ownerId, actorId, reason = 'Closed through support controls' }) {
  return withTicketLock(`close:${channel.id}`, async () => {
    const current = typeof channel.fetch === 'function' ? await channel.fetch(true) : channel;
    if (String(current.name).startsWith('closed-')) return { alreadyClosed: true };
    if (!/^\d{17,20}$/.test(String(ownerId))) throw new Error('A valid ticket owner is required before archiving.');
    if (!current.permissionOverwrites?.edit || !current.send || !current.setName) throw new Error('This channel cannot be safely archived.');
    await current.permissionOverwrites.edit(ownerId, {
      ViewChannel: false, SendMessages: false, SendMessagesInThreads: false,
      CreatePublicThreads: false, CreatePrivateThreads: false, AddReactions: false,
    }, 'Archive a closed support ticket for staff');
    await current.send({
      content: `Ticket archived by user ${String(actorId)} at ${new Date().toISOString()}. Reason: ${String(reason).slice(0, 500)}. Support history is retained for staff.`,
      allowedMentions: { parse: [] },
    });
    await current.setName(`closed-${current.name}`.slice(0, 100), 'Preserve closed ticket history');
    return { alreadyClosed: false };
  });
}

function ticketChannelName(user) {
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 35);
  return `ticket-${safeName || 'member'}-${user.id.slice(-4)}`.slice(0, 90);
}

async function findExistingTicket(guild, userId) {
  const channels = await guild.channels.fetch();
  return channels.find((channel) => channel?.type === ChannelType.GuildText
    && !String(channel.name).startsWith('closed-') && ticketOwnerId(channel) === userId) || null;
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
        const overwrites = [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        ];
        for (const roleId of [config.roles.staff, config.roles.moderator].filter(Boolean)) {
          overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory] });
        }
        const channel = await interaction.guild.channels.create({
          name: ticketChannelName(interaction.user), type: ChannelType.GuildText,
          parent: config.channels.tickets || undefined, topic: `ticket-owner:${interaction.user.id}`,
          permissionOverwrites: overwrites, reason: `Support ticket opened by ${interaction.user.tag}`,
        });
        const embed = new EmbedBuilder().setColor(config.colors.primary).setTitle('SUPPORT TICKET')
          .setDescription(`Opened by ${interaction.user}\n\n**Issue:** ${reason}`).setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
        );
        await channel.send({
          content: config.roles.staff ? `<@${interaction.user.id}> <@&${config.roles.staff}>` : `<@${interaction.user.id}>`,
          embeds: [embed], components: [row],
          allowedMentions: { users: [interaction.user.id], roles: config.roles.staff ? [config.roles.staff] : [] },
        });
        return finish(interaction, `Your private ticket is ready: ${channel}`);
      });
    } catch (error) {
      console.error('Ticket creation failed:', error);
      return finish(interaction, 'The ticket could not be opened. Please retry or contact staff.');
    }
  }
  if (interaction.isButton() && interaction.customId === 'ticket_close') {
    if (!canCloseTicket(interaction, interaction.channel)) {
      return replyEphemeral(interaction, 'Only the ticket owner or authorized staff can close this ticket.');
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await archiveTicket(interaction.channel, {
        ownerId: ticketOwnerId(interaction.channel), actorId: interaction.user.id,
      });
      return finish(interaction, result.alreadyClosed ? 'This ticket is already archived.' : 'Ticket archived. Support history is retained for staff.');
    } catch (error) {
      console.error('Ticket archive failed:', error);
      return finish(interaction, 'The ticket could not be fully archived. No channel was deleted; please contact staff.');
    }
  }
}

module.exports = { handleTicket, withTicketLock, archiveTicket };
