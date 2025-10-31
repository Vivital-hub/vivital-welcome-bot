import { Client, GatewayIntentBits, Events } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;       // same bot as your interactions app
const verifyChannelId = process.env.VERIFY_CHANNEL_ID; // #verify channel ID
const welcomeMsg = process.env.WELCOME_MESSAGE
  || "👋 Welcome, <@{USER_ID}>! Hit the **Verify as Creator** button to unlock access.";

if (!token || !verifyChannelId) {
  console.error("Missing DISCORD_BOT_TOKEN or VERIFY_CHANNEL_ID");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Welcome bot online as ${c.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const ch = member.guild.channels.cache.get(verifyChannelId)
      || await member.guild.channels.fetch(verifyChannelId).catch(() => null);

    if (!ch) {
      console.warn("Verify channel not found or not accessible");
      return;
    }
    const content = welcomeMsg.replace("{USER_ID}", member.id);
    await ch.send({ content });
  } catch (e) {
    console.error("Failed to send welcome:", e.message);
  }
});

client.login(token);
