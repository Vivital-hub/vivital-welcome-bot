import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import { Client, GatewayIntentBits, Events, PermissionFlagsBits } from "discord.js";

/* ====== ENV ====== */
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const WELCOME_MESSAGE = process.env.WELCOME_MESSAGE || "👋 Welcome, <@{USER_ID}>! Click **Verify as Creator** to unlock access.";
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const API_SHARED_SECRET = process.env.API_SHARED_SECRET || "";
const XP_PER_ORDER = parseInt(process.env.XP_PER_ORDER || "10", 10);
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID || "";
const REFRESH_MINUTES = parseInt(process.env.REFRESH_MINUTES || "0", 10);
const PORT = process.env.PORT || 10000;

if (!TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

/* ====== DB (sqlite) ====== */
// If you add a Render Disk, change to: new Database("/data/vivital-xp.db");
const db = new Database("vivital-xp.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS email_map (
  email TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  username TEXT
);
CREATE TABLE IF NOT EXISTS xp (
  discord_id TEXT PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0
);
`);

/* ====== DISCORD BOT ====== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Welcome bot online as ${c.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (!VERIFY_CHANNEL_ID) return;
    const ch = member.guild.channels.cache.get(VERIFY_CHANNEL_ID)
      || await member.guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null);
    if (!ch) return;

    const me = member.guild.members.me || await member.guild.members.fetchMe();
    const perms = ch.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) return;

    await ch.send({ content: WELCOME_MESSAGE.replace("{USER_ID}", member.id) });
  } catch (e) {
    console.error("Failed to send welcome:", e.message);
  }
});

client.login(TOKEN);

/* ====== EXPRESS API ====== */
const app = express();
app.use(express.json({ type: "*/*" })); // default parser (except Shopify route)

// Health check
app.get("/", (_req, res) => res.status(200).send("ok"));

// Leaderboard JSON
app.get("/leaderboard", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
  const rows = db.prepare(`SELECT discord_id, xp, orders FROM xp ORDER BY xp DESC, orders DESC LIMIT ?`).all(limit);
  res.json({ top: rows });
});

// Helper to check shared secret
function requireBearer(req, res) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!API_SHARED_SECRET || token !== API_SHARED_SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// Map email -> Discord (from Vercel)
app.post("/map-email", (req, res) => {
  if (!requireBearer(req, res)) return;
  const { email, discordId, username } = req.body || {};
  if (!email || !discordId) return res.status(400).json({ ok: false, error: "missing email/discordId" });
  db.prepare(`INSERT INTO email_map (email, discord_id, username) VALUES (?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET discord_id=excluded.discord_id, username=excluded.username`)
    .run(String(email).toLowerCase().trim(), String(discordId), username || null);
  return res.json({ ok: true });
});

/* ====== SHOPIFY WEBHOOK (RAW BODY + HMAC) ====== */
const shopifyRaw = express.raw({ type: "application/json" });
app.post("/webhook/orders-paid", shopifyRaw, (req, res) => {
  try {
    if (!SHOPIFY_WEBHOOK_SECRET) return res.status(401).send("missing secret");

    // Compute HMAC over raw body bytes
    const rawBody = req.body; // Buffer
    const expected = req.headers["x-shopify-hmac-sha256"] || "";
    const computed = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("base64");

    const ok =
      expected.length === computed.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(computed));

    if (!ok) {
      console.log("invalid hmac");
      return res.status(401).send("invalid hmac");
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    const email = (payload?.email || payload?.customer?.email || "").toLowerCase().trim();
    if (!email) {
      console.log("no email; ignored");
      return res.status(200).send("ok");
    }

    const map = db.prepare(`SELECT discord_id FROM email_map WHERE email=?`).get(email);
    if (!map?.discord_id) {
      console.log(`Order paid but no creator mapping for email ${email}`);
      return res.status(200).send("ok");
    }

    db.prepare(`INSERT INTO xp (discord_id, xp, orders) VALUES (?, ?, 1)
                ON CONFLICT(discord_id) DO UPDATE SET
                  xp = xp + excluded.xp,
                  orders = orders + 1`).run(map.discord_id, XP_PER_ORDER);

    console.log(`+${XP_PER_ORDER} XP to ${map.discord_id} for order ${payload?.id || "n/a"}`);
    res.status(200).send("ok");
  } catch (e) {
    console.error("orders-paid error:", e.message);
    res.status(500).send("error");
  }
});

/* ====== PUBLISH / REFRESH LEADERBOARD ====== */
app.post("/leaderboard/publish", async (req, res) => {
  if (!requireBearer(req, res)) return;
  if (!LEADERBOARD_CHANNEL_ID) return res.status(400).json({ ok: false, error: "LEADERBOARD_CHANNEL_ID not set" });

  try {
    const top = db.prepare(`SELECT discord_id, xp, orders FROM xp ORDER BY xp DESC, orders DESC LIMIT 10`).all();
    const lines = top.map((r, i) => `${i + 1}. <@${r.discord_id}> — **${r.xp} XP** (${r.orders} orders)`);
    const content = `🏆 **Creator Leaderboard**\n${lines.length ? lines.join("\n") : "_No data yet_"}\n\n_Last update: <t:${Math.floor(Date.now()/1000)}:R>_`;

    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.send) return res.status(400).json({ ok: false, error: "channel not found or not text" });

    const pins = await ch.messages.fetchPinned().catch(() => null);
    const existing = pins?.find(m => m.author?.id === client.user.id && m.content?.startsWith("🏆 **Creator Leaderboard**"));

    if (existing) {
      await existing.edit({ content });
      console.log("Leaderboard message updated");
    } else {
      const msg = await ch.send({ content });
      try { await msg.pin(); } catch {}
      if (pins) {
        const others = pins.filter(m => m.id !== msg.id && m.author?.id === client.user.id && m.content?.startsWith("🏆 **Creator Leaderboard**"));
        for (const [,m] of others) { try { await m.unpin(); } catch {} }
      }
      console.log("Leaderboard message posted & pinned");
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("leaderboard publish error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Fallback error handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).send("server error");
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

/* ====== OPTIONAL AUTO-REFRESH ====== */
if (REFRESH_MINUTES > 0) {
  setInterval(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/leaderboard/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_SHARED_SECRET}` }
      });
      if (!r.ok) console.log("auto-refresh failed", r.status);
    } catch (e) {
      console.log("auto-refresh error", e.message);
    }
  }, REFRESH_MINUTES * 60 * 1000);
}
