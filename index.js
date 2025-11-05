import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import { Client, GatewayIntentBits, Events, PermissionFlagsBits } from "discord.js";

/* ================= ENV ================= */
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const WELCOME_MESSAGE =
  process.env.WELCOME_MESSAGE ||
  "👋 Welcome, <@{USER_ID}>! Click **Verify as Creator** to unlock access.";

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const API_SHARED_SECRET = process.env.API_SHARED_SECRET || "";

const XP_MODE = (process.env.XP_MODE || "hybrid").toLowerCase();
const XP_BASE = parseFloat(process.env.XP_BASE || "5");
const XP_K = parseFloat(process.env.XP_K || "2");
const XP_CAP = parseFloat(process.env.XP_CAP || "40");
const XP_NEW_CUSTOMER_BONUS = parseFloat(process.env.XP_NEW_CUSTOMER_BONUS || "5");
const XP_FIRST_VERIFIED_BONUS = parseFloat(process.env.XP_FIRST_VERIFIED_BONUS || "10");

const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID || "";
const REFRESH_MINUTES = parseInt(process.env.REFRESH_MINUTES || "0", 10);
const PORT = process.env.PORT || 10000;

// test toggles
const MIN_NET_FOR_XP = parseFloat(process.env.MIN_NET_FOR_XP || "0");
const ALLOW_ZERO_NET_XP =
  String(process.env.ALLOW_ZERO_NET_XP || "false").toLowerCase() === "true";

if (!TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

/* ================= DB ================= */
// For persistence, mount a Render Disk and use /data/vivital-xp.db
const db = new Database("vivital-xp.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS email_map (email TEXT PRIMARY KEY, discord_id TEXT NOT NULL, username TEXT);
CREATE TABLE IF NOT EXISTS code_map (code TEXT PRIMARY KEY, discord_id TEXT NOT NULL, email TEXT, username TEXT);
CREATE TABLE IF NOT EXISTS xp (discord_id TEXT PRIMARY KEY, xp INTEGER NOT NULL DEFAULT 0, orders INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS order_xp (order_id TEXT PRIMARY KEY, discord_id TEXT NOT NULL, xp_awarded INTEGER NOT NULL, net_revenue REAL NOT NULL, refunded_xp INTEGER NOT NULL DEFAULT 0);
`);

/* ================= Discord Bot ================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, (c) => console.log(`Welcome bot online as ${c.user.tag}`));

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (!VERIFY_CHANNEL_ID) return;
    const ch =
      member.guild.channels.cache.get(VERIFY_CHANNEL_ID) ||
      (await member.guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null));
    if (!ch) return;
    const me = member.guild.members.me || (await member.guild.members.fetchMe());
    const perms = ch.permissionsFor(me);
    if (
      !perms?.has(PermissionFlagsBits.ViewChannel) ||
      !perms?.has(PermissionFlagsBits.SendMessages)
    )
      return;
    await ch.send({ content: WELCOME_MESSAGE.replace("{USER_ID}", member.id) });
  } catch (e) {
    console.error("Failed to send welcome:", e.message);
  }
});
client.login(TOKEN);

/* ================= Express App ================= */
const app = express();
app.get("/", (_req, res) => res.status(200).send("ok"));
const shopifyRaw = express.raw({ type: "application/json" });

/* helpers */
function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return false;
  const expected = req.headers["x-shopify-hmac-sha256"] || "";
  const computed = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("base64");
  return (
    expected.length === computed.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(computed))
  );
}
function parseNumber(x) {
  const n = typeof x === "number" ? x : parseFloat(String(x ?? "0"));
  return Number.isFinite(n) ? n : 0;
}
function estimateNetRevenueFromOrder(order) {
  const candidates = [
    order?.subtotal_price,
    order?.current_subtotal_price,
    order?.total_line_items_price,
    order?.current_total_price_set?.shop_money?.amount,
  ];
  let subtotal = 0;
  for (const c of candidates) {
    const v = parseFloat(c);
    if (Number.isFinite(v) && v > 0) {
      subtotal = v;
      break;
    }
  }
  const discounts =
    parseFloat(order?.total_discounts ?? order?.current_total_discounts ?? 0) || 0;
  return Math.max(0, subtotal - discounts);
}
function estimateRefundNetFromRefund(refund) {
  let sum = 0;
  const items = refund?.refund_line_items || [];
  for (const rli of items) {
    const price = parseNumber(rli?.line_item?.price);
    const qty = parseNumber(rli?.quantity);
    sum += price * qty;
  }
  return Math.max(0, sum);
}
function calcHybridXP(net) {
  if (XP_MODE !== "hybrid")
    return Math.min(Math.round(XP_BASE), XP_CAP || 1e9);
  const raw = XP_BASE + XP_K * Math.sqrt(Math.max(0, net));
  return Math.min(Math.round(raw), XP_CAP || 1e9);
}
function collectDiscountCodesFromOrder(order) {
  const out = new Set();
  const apps = order?.discount_applications || [];
  for (const a of apps)
    if ((a?.type || "").toLowerCase() === "discount_code" && a?.code)
      out.add(String(a.code).toLowerCase());
  const legacy = order?.discount_codes || [];
  for (const d of legacy) if (d?.code) out.add(String(d.code).toLowerCase());
  return Array.from(out);
}
function awardXP(discordId, amount, orderId) {
  db.prepare(
    `INSERT INTO xp (discord_id, xp, orders) VALUES (?, ?, 1)
     ON CONFLICT(discord_id) DO UPDATE SET xp = xp + excluded.xp, orders = orders + 1`
  ).run(discordId, amount);
  console.log(`+${amount} XP to ${discordId} for order ${orderId}`);
}

/* ---- ORDER PAID ---- */
app.post("/webhook/orders-paid", shopifyRaw, (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) return res.status(401).send("invalid hmac");
    const order = JSON.parse(req.body.toString("utf8"));

    const codes = collectDiscountCodesFromOrder(order);
    let discordId = null;
    for (const code of codes) {
      const row = db.prepare(`SELECT discord_id FROM code_map WHERE code=?`).get(code.toLowerCase());
      if (row?.discord_id) { discordId = row.discord_id; break; }
    }
    if (!discordId) {
      const email = (order?.email || order?.customer?.email || "").toLowerCase().trim();
      if (email) {
        const map = db.prepare(`SELECT discord_id FROM email_map WHERE email=?`).get(email);
        if (map?.discord_id) discordId = map.discord_id;
      }
    }
    if (!discordId) { console.log("No mapping for order", order?.id); return res.status(200).send("ok"); }

    const net = estimateNetRevenueFromOrder(order);

    // allow £0 tests to count when ALLOW_ZERO_NET_XP=true
    if (net <= 0 || net < MIN_NET_FOR_XP) {
      if (ALLOW_ZERO_NET_XP) {
        let xp = Math.round(Math.max(0, XP_BASE));
        const ordersCount = parseNumber(order?.customer?.orders_count);
        if (ordersCount === 1) xp += Math.round(Math.max(0, XP_NEW_CUSTOMER_BONUS));
        const existing = db.prepare(`SELECT orders FROM xp WHERE discord_id=?`).get(discordId);
        if (!existing || parseNumber(existing.orders) === 0)
          xp += Math.round(Math.max(0, XP_FIRST_VERIFIED_BONUS));

        awardXP(discordId, xp, order?.id);
        db.prepare(`INSERT INTO order_xp (order_id, discord_id, xp_awarded, net_revenue)
                    VALUES (?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING`)
          .run(String(order.id), discordId, xp, net);
        console.log(`+${xp} XP (allowed for £0 test) to ${discordId}`);
        return res.status(200).send("ok");
      } else {
        console.log(`No XP for low net (£${net}) order ${order?.id}`);
        return res.status(200).send("ok");
      }
    }

    let xp = calcHybridXP(net);
    const ordersCount = parseNumber(order?.customer?.orders_count);
    if (ordersCount === 1) xp += Math.round(Math.max(0, XP_NEW_CUSTOMER_BONUS));
    const existing = db.prepare(`SELECT orders FROM xp WHERE discord_id=?`).get(discordId);
    if (!existing || parseNumber(existing.orders) === 0)
      xp += Math.round(Math.max(0, XP_FIRST_VERIFIED_BONUS));

    awardXP(discordId, xp, order?.id);
    db.prepare(`INSERT INTO order_xp (order_id, discord_id, xp_awarded, net_revenue)
                VALUES (?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING`)
      .run(String(order.id), discordId, xp, net);

    return res.status(200).send("ok");
  } catch (e) { console.error("orders-paid error:", e); return res.status(500).send("error"); }
});

/* ---- REFUND / CANCEL webhooks ---- */
app.post("/webhook/refunds-create", shopifyRaw, (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) return res.status(401).send("invalid hmac");
    const refund = JSON.parse(req.body.toString("utf8"));
    const orderId = String(refund?.order_id || "");
    if (!orderId) return res.status(200).send("ok");
    const ledger = db.prepare(`SELECT order_id, discord_id, xp_awarded, net_revenue, refunded_xp FROM order_xp WHERE order_id=?`).get(orderId);
    if (!ledger) return res.status(200).send("ok");
    const refundNet = estimateRefundNetFromRefund(refund);
    if (refundNet <= 0 || ledger.net_revenue <= 0) return res.status(200).send("ok");
    const ratio = Math.min(1, refundNet / ledger.net_revenue);
    const xpToClaw = Math.round(ledger.xp_awarded * ratio);
    const remaining = Math.max(0, ledger.xp_awarded - ledger.refunded_xp);
    const delta = Math.min(remaining, xpToClaw);
    if (delta <= 0) return res.status(200).send("ok");
    db.prepare(`UPDATE xp SET xp = MAX(0, xp - ?) WHERE discord_id=?`).run(delta, ledger.discord_id);
    db.prepare(`UPDATE order_xp SET refunded_xp = refunded_xp + ? WHERE order_id=?`).run(delta, orderId);
    console.log(`-${delta} XP clawed back for refund ${orderId}`);
    res.status(200).send("ok");
  } catch (e) { console.error("refund error:", e); res.status(500).send("error"); }
});
app.post("/webhook/orders-cancelled", shopifyRaw, (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) return res.status(401).send("invalid hmac");
    const order = JSON.parse(req.body.toString("utf8"));
    const orderId = String(order?.id || "");
    if (!orderId) return res.status(200).send("ok");
    const ledger = db.prepare(`SELECT order_id, discord_id, xp_awarded, refunded_xp FROM order_xp WHERE order_id=?`).get(orderId);
    if (!ledger) return res.status(200).send("ok");
    const remaining = Math.max(0, ledger.xp_awarded - ledger.refunded_xp);
    if (remaining <= 0) return res.status(200).send("ok");
    db.prepare(`UPDATE xp SET xp = MAX(0, xp - ?) WHERE discord_id=?`).run(remaining, ledger.discord_id);
    db.prepare(`UPDATE order_xp SET refunded_xp = refunded_xp + ? WHERE order_id=?`).run(remaining, orderId);
    console.log(`-${remaining} XP clawed back for cancelled order ${orderId}`);
    res.status(200).send("ok");
  } catch (e) { console.error("cancel error:", e); res.status(500).send("error"); }
});

/* ---- other endpoints (map, leaderboard) ---- */
app.use(express.json());
function requireBearer(req, res) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!API_SHARED_SECRET || token !== API_SHARED_SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}
app.post("/map-code", (req, res) => {
  if (!requireBearer(req, res)) return;
  const { code, discordId, email, username } = req.body || {};
  if (!code || !discordId) return res.status(400).json({ ok: false });
  db.prepare(
    `INSERT INTO code_map (code, discord_id, email, username) VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET discord_id=excluded.discord_id`
  ).run(String(code).toLowerCase().trim(), String(discordId), email || null, username || null);
  res.json({ ok: true });
});
app.get("/leaderboard", (req, res) => {
  const rows = db.prepare(`SELECT discord_id, xp, orders FROM xp ORDER BY xp DESC, orders DESC LIMIT 10`).all();
  res.json({ top: rows });
});
app.post("/leaderboard/publish", async (req, res) => {
  if (!requireBearer(req, res)) return;
  if (!LEADERBOARD_CHANNEL_ID) return res.status(400).json({ ok: false });
  const top = db.prepare(`SELECT discord_id, xp, orders FROM xp ORDER BY xp DESC, orders DESC LIMIT 10`).all();
  const lines = top.map((r, i) => `${i + 1}. <@${r.discord_id}> — **${r.xp} XP** (${r.orders} orders)`);
  const content = `🏆 **Creator Leaderboard**\n${lines.length ? lines.join("\n") : "_No data yet_"}\n\n_Last update: <t:${Math.floor(Date.now()/1000)}:R>_`;
  try {
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    const pins = await ch.messages.fetchPinned();
    const existing = pins.find(m => m.author?.id === client.user.id && m.content?.startsWith("🏆 **Creator Leaderboard**"));
    if (existing) await existing.edit({ content });
    else { const msg = await ch.send({ content }); await msg.pin(); }
    console.log("Leaderboard updated");
    res.json({ ok: true });
  } catch (e) { console.error("leaderboard error:", e.message); res.status(500).json({ ok: false }); }
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

if (REFRESH_MINUTES > 0) {
  setInterval(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/leaderboard/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_SHARED_SECRET}` },
      });
      if (!r.ok) console.log("auto-refresh failed", r.status);
    } catch (e) { console.log("auto-refresh error", e.message); }
  }, REFRESH_MINUTES * 60 * 1000);
}
