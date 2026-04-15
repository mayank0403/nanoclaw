import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  Message,
  ModalBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Channel ID owned by Pincer's LeaderClaw proxy. Messages here are forwarded
  // to Pincer instead of the normal nanoclaw agent pipeline.
  leaderChannelId?: string;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private leaderChannelId: string | null = null;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    this.leaderChannelId = opts.leaderChannelId ?? null;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Leader channel (and threads under it): owned entirely by Pincer — forward to proxy,
      // skip nanoclaw routing. Threads created via REST API may not be in the Discord.js
      // channel cache yet, so parentId can be null; fetch the channel to populate it.
      const isLeaderChannel =
        this.leaderChannelId && channelId === this.leaderChannelId;
      let isLeaderThread = false;
      if (this.leaderChannelId && message.channel.isThread()) {
        let parentId = message.channel.parentId;
        if (!parentId) {
          try {
            const fetched = await message.channel.fetch();
            parentId = fetched.parentId;
          } catch {
            // fetch failed — treat as non-leader thread
          }
        }
        isLeaderThread = parentId === this.leaderChannelId;
      }
      if (isLeaderChannel || isLeaderThread) {
        try {
          await fetch('http://localhost:8080/proxy/user_message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel_id: channelId,
              message_id: msgId,
              sender_id: sender,
              sender_name: senderName,
              content,
            }),
          });
          logger.info(
            { channelId, sender: senderName },
            'Leader channel message forwarded to Pincer',
          );
        } catch (err) {
          logger.error(
            { channelId, err },
            'Failed to forward leader message to Pincer',
          );
        }
        return; // Pincer owns this channel; do NOT call onMessage or store chat metadata
      }

      // Store chat metadata for discovery (non-leader channels only)
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Forward Pincer interactions (buttons, select menus, modals) to Pincer proxy
    this.client.on(
      Events.InteractionCreate,
      async (interaction: Interaction) => {
        // --- Modal submissions (pincer_modal_submit_*) ---
        if (interaction.isModalSubmit()) {
          if (!interaction.customId.startsWith('pincer_modal_submit_')) return;
          try {
            await interaction.deferUpdate();
          } catch (ackErr) {
            logger.error({ ackErr }, 'Failed to acknowledge modal submission');
          }
          try {
            const customText =
              interaction.fields.getTextInputValue('custom_text');
            await fetch('http://localhost:8080/proxy/interaction', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                custom_id: interaction.customId,
                user_id: interaction.user.id,
                message_id: '',
                channel_id: interaction.channelId,
                modal_values: { custom_text: customText },
              }),
            });
          } catch (fwdErr) {
            logger.error(
              { fwdErr },
              'Failed to forward modal submission to Pincer',
            );
          }
          return;
        }

        // --- String select menus (pincer_interview_select_*) ---
        if (interaction.isStringSelectMenu()) {
          if (!interaction.customId.startsWith('pincer_interview_select_'))
            return;
          try {
            await interaction.deferUpdate();
          } catch (ackErr) {
            logger.error(
              { ackErr },
              'Failed to acknowledge select interaction',
            );
          }
          try {
            await fetch('http://localhost:8080/proxy/interaction', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                custom_id: interaction.customId,
                user_id: interaction.user.id,
                message_id: interaction.message.id,
                channel_id: interaction.channelId,
                values: interaction.values,
              }),
            });
          } catch (fwdErr) {
            logger.error(
              { fwdErr },
              'Failed to forward select interaction to Pincer',
            );
          }
          return;
        }

        // --- Button interactions ---
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('pincer_')) return;

        // Modal trigger buttons: respond with a modal instead of forwarding
        if (interaction.customId.startsWith('pincer_interview_modal_')) {
          const modalCustomId = interaction.customId.replace(
            'interview_modal_',
            'modal_submit_',
          );
          try {
            const modal = new ModalBuilder()
              .setCustomId(modalCustomId)
              .setTitle('Add custom explanation')
              .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                  new TextInputBuilder()
                    .setCustomId('custom_text')
                    .setLabel('Your explanation')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setPlaceholder('Explain your reasoning...')
                    .setMaxLength(500),
                ),
              );
            await interaction.showModal(modal);
          } catch (err) {
            logger.error({ err }, 'Failed to open modal');
          }
          return;
        }

        // Skip buttons: acknowledge only, no forwarding
        if (interaction.customId.startsWith('pincer_interview_skip_')) {
          try {
            await interaction.deferUpdate();
          } catch (ackErr) {
            logger.error({ ackErr }, 'Failed to acknowledge skip button');
          }
          // Also forward to Pincer so it can clean up _pending_interviews
          try {
            await fetch('http://localhost:8080/proxy/interaction', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                custom_id: interaction.customId,
                user_id: interaction.user.id,
                message_id: interaction.message.id,
                channel_id: interaction.channelId,
              }),
            });
          } catch (fwdErr) {
            logger.error(
              { fwdErr },
              'Failed to forward skip interaction to Pincer',
            );
          }
          return;
        }

        // All other pincer_ buttons: acknowledge + forward (existing behavior)
        try {
          await interaction.deferUpdate();
        } catch (ackErr) {
          logger.error({ ackErr }, 'Failed to acknowledge Discord interaction');
        }
        try {
          await fetch('http://localhost:8080/proxy/interaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              custom_id: interaction.customId,
              user_id: interaction.user.id,
              message_id: interaction.message.id,
              channel_id: interaction.channelId,
            }),
          });
          logger.info(
            { customId: interaction.customId, userId: interaction.user.id },
            'Pincer interaction forwarded',
          );
        } catch (fwdErr) {
          logger.error({ fwdErr }, 'Failed to forward interaction to Pincer');
        }
      },
    );

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'DISCORD_BOT_TOKEN',
    'PINCER_LEADER_CHANNEL_ID',
  ]);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  const leaderChannelId =
    process.env.PINCER_LEADER_CHANNEL_ID ||
    envVars.PINCER_LEADER_CHANNEL_ID ||
    '';
  if (!leaderChannelId) {
    logger.error(
      'PINCER_LEADER_CHANNEL_ID is not set — LeaderClaw Discord proxy will not work',
    );
  }
  return new DiscordChannel(token, {
    ...opts,
    leaderChannelId: leaderChannelId || undefined,
  });
});
