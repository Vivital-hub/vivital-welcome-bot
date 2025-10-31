import { Client, GatewayIntentBits, Events, PermissionFlagsBits } from "discord.js";
import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";

// ===== Env =====
const token = process.env.DISCORD_BOT_TOKEN;
const verifyChannelId = process.env.VERIFY_CHANNEL_ID;
const leaderboardChannelId = process.env.LEADERBOARD_CHANNEL_ID; // optional
const welcomeMsg = process.env.WELCOME_MESSAGE
  || "👋 Welcome, <@{USER_ID}>! Head to this channel and click **Verify as Creator** below to unlock access.";
const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const API_SHARED_SECRET = process.env.API_SHARED_SECRET || "";
const XP_PER_ORDER = parseInt(process.env.XP_PER_ORDER || "10", 10);

if (!token || !verifyChannelId) {
  console.error("Missing DISCORD_BOT_TOKEN or VERIFY_CHANNEL_ID");
  process.exit(1);
}

// ===== Discord client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

async function sendWelcome(member) {
  try {
    const ch =
      member.guild.channels.cache.get(verifyChannelId) ||
      (await member.guild.channels.fetch(verifyChannelId).catch(() => null));

    if (!ch) return console.warn("Verify channel not found or not accessible");

    const me = member.guild.members.me || (await member.guild.members.fetchMe());
    const perms = ch.permissionsFor(me);
    if (
      !perms?.has(PermissionFlagsBits.ViewChannel) ||
      !perms?.has(PermissionFlagsBits.SendMessages)
    ) {
      return console.warn("Bot lacks permission to send in verify channel");
    }

    const content = welcomeMsg.replace("{USER_ID}", member.id);
    await ch.send({ content });
    console.log(`Sent welcome to ${member.user.tag}`);
  } catch (e) {
    console.error("Failed to send welcome:", e.message);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Welcome bot online as ${c.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  console.log(`Member joined: ${member.user.tag} (pending=${member.pending})`);
  await sendWelcome(member);
});

// ===== SQLite setup =====
const db = new Database("./vivital_xp.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS creators (
    email TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    username TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS xp (
    discord_id TEXT PRIMARY KEY,
    xp INTEGER DEFAULT 0,
    orders INTEGER DEFAULT 0,
    updated_at TEXT
  );
`);

const upsertCreator = db.prepare(
  `INSERT INTO creators(email, discord_id, username)
   VALUES(?, ?, ?)
   ON CONFLICT(email) DO UPDATE SET discord_id=excluded.discord_id, username=excluded.username`
);
const addXPStmt = db.prepare(
  `INSERT INTO xp(discord_id, xp, orders, updated_at)
   VALUES(?, ?, 1, datetime('now'))
   ON CONFLICT(discord_id) DO UPDATE SET
     xp = xp + excluded.xp,
     orders = orders + 1,
     updated_at = datetime('now')`
);
const topStmt = db.prepare(`SELECT discord_id, xp, orders FROM xp ORDER BY xp DESC LIMIT ?`);

// ===== Express API =====
const app = express();
app.use(express.json({ verify: rawBodySaver }));

function rawBodySaver(req, res, buf) {
  req.rawBody = buf; // for Shopify HMAC verification
}

// Simple bearer auth for internal calls (from Vercel)
function requireSecret(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!API_SHARED_SECRET || auth !== `Bearer ${API_SHARED_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Map email <-> Discord user after verification
app.post("/map-email", requireSecret, (req, res) => {
  const { email, discordId, username } = req.body || {};
  if (!email || !discordId) return res.status(400).json({ error: "email and discordId required" });
  upsertCreator.run(email.toLowerCase(), discordId, username || null);
  return res.json({ ok: true });
});

// Shopify orders/paid webhook → award XP
app.post("/webhook/orders-paid", (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send("invalid hmac");
  const order = req.body;
  const email = (order.email || "").toLowerCase();
  if (!email) return res.status(200).send("no email; ignored");

  const creator = db.prepare(`SELECT discord_id FROM creators WHERE email = ?`).get(email);
  if (!creator) {
    console.log("Order paid but no creator mapping for email", email);
    return res.status(200).send("no mapping; ignored");
  }

  addXPStmt.run(creator.discord_id, XP_PER_ORDER);
  console.log(`+${XP_PER_ORDER} XP to ${creator.discord_id} for order ${order.id}`);
  res.status(200).send("ok");
});

// Public leaderboard API
app.get("/leaderboard", (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || "10", 10)));
  const rows = topStmt.all(limit);
  return res.json({ top: rows });
});

// Optional: publish/update a pinned leaderboard message in a channel
let leaderboardMessageId = null;
app.post("/leaderboard/publish", requireSecret, async (req, res) => {
  try {
    if (!leaderboardChannelId)
      return res.status(400).json({ error: "LEADERBOARD_CHANNEL_ID not set" });
    const ch = await client.channels.fetch(leaderboardChannelId);
    const top = topStmt.all(10);

    // Resolve usernames for nicer display
    const lines = [];
    for (let i = 0; i < top.length; i++) {
      const row = top[i];
      let name = row.discord_id;
      try {
        const m = await ch.guild.members.fetch(row.discord_id);
        name = m.nickname || m.user.globalName || m.user.username;
      } catch {}
      lines.push(`${i + 1}. **${name}** — ${row.xp} XP (${row.orders} orders)`);
    }
    const content = `🏆 **Creator Leaderboard**\n${lines.join("\n") || "No data yet."}`;

    if (leaderboardMessageId) {
      try {
        await ch.messages.edit(leaderboardMessageId, { content });
      } catch {
        leaderboardMessageId = null;
      }
    }
    if (!leaderboardMessageId) {
      const msg = await ch.send({ content });
      leaderboardMessageId = msg.id;
      try {
        await msg.pin();
      } catch {}
    }

    return res.json({ ok: true, messageId: leaderboardMessageId });
  } catch (e) {
    console.error("publish leaderboard error:", e);
    return res.status(500).json({ error: e.message });
  }
});

function verifyShopifyHmac(req) {
  try {
    const h = req.headers["x-shopify-hmac-sha256"];
    if (!h) return false;
    const gen = crypto.createHmac("sha256", webhookSecret).update(req.rawBody).digest("base64");
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(gen));
  } catch {
    return false;
  }
}

// Start both Discord and HTTP server
const PORT = process.env.PORT || 3000;
client.login(token).then(() => {
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));
});
