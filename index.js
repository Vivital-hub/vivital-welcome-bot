// index.js — Render (Discord bot + XP engine)

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

const XP_MODE = (process.env.XP_MODE || "hybrid").toLowerCase(); // hybrid|tiered|flat|revenue (we use hybrid)
const XP_BASE = parseFloat(process.env.XP_BASE || "5");
const XP_K = parseFloat(process.env.XP_K || "2");
const XP_CAP = parseFloat(process.env.XP_CAP || "40");

const XP_NEW_CUSTOMER_BONUS = parseFloat(process.env.XP_NEW_CUSTOMER_BONUS || "5");
const XP_FIRST_VERIFIED_BONUS = parseFloat(process.env.XP_FIRST_VERIFIED_BONUS || "10");

const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID || "";
const REFRESH_MINUTES = parseInt(process.env.REFRESH_MINUTES || "0", 10);
const PORT = process.env.PORT || 10000;

// Optional gates (set if you want to ignore near-free orders)
const MIN_NET_FOR_XP = parseFloat(process.env.MIN_NET_FOR_XP || "0"); // e.g. 5
const ALLOW_ZERO_NET_XP =
  String(process.env.ALLOW_ZERO_NET_XP || "false").toLowerCase() === "true";

if (!TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

/* ================= DB (SQLite) ================= */
// For persistence on Render Disk: const db = new Database("/data/vivital-xp.db");
const db = new Database("vivital-xp.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS email_map (
  email TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  username TEXT
);
CREATE TABLE IF NOT EXISTS code_map (
  code TEXT PRIMARY KEY,      -- affiliate/discount code (lowercase)
  discord_id TEXT NOT NULL,
  email TEXT,
  username TEXT
);
CREATE TABLE IF NOT EXISTS xp (
  discord_id TEXT PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS order_xp (
  order_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  xp_awarded INTEGER NOT NULL,
  net_revenue REAL NOT NULL,
  refunded_xp INTEGER NOT NULL DEFAULT 0
);
`);

/* ================= Discord Bot ================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, (c) =>
  console.log(`Welcome bot online as ${c.user.tag}`)
);

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

/* ---- Health ---- */
app.get("/", (_req, res) => res.status(200).send("ok"));

/* ---- RAW body middleware for Shopify webhooks (must be BEFORE json()) ---- */
const shopifyRaw = express.raw({ type: "application/json" });

/* ================= Helpers ================= */
function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return false;
  const rawBody = req.body; // Buffer
  const expected = req.headers["x-shopify-hmac-sha256"] || "";
  const computed = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
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
  // Try multiple Shopify fields (exclude shipping/tax), then subtract discounts.
  const candidates = [
    order?.subtotal_price,
    order?.current_subtotal_price,
    order?.total_line_items_price,
    order?.current_total_price,
    order?.current_total_price_set?.shop_money?.amount,
    order?.current_subtotal_price_set?.shop_money?.amount,
    order?.total_price_set?.shop_money?.amount,
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
    parseFloat(order?.total_discounts ?? order?.current_total_discounts ?? 0) ||
    0;
  return Math.max(0, subtotal - discounts);
}

function estimateRefundNetFromRefund(refund) {
  // Approx: sum(line_item.price * quantity) from refund_line_items
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
  if (XP_MODE !== "hybrid") {
    // Keep simple fallback if mode accidentally changed
    return Math.min(Math.round(XP_BASE), XP_CAP || 1e9);
  }
  const raw = Math.max(0, XP_BASE) + Math.max(0, XP_K) * Math.sqrt(Math.max(0, net));
  return Math.min(Math.round(raw), XP_CAP || 1e9);
}

function collectDiscountCodesFromOrder(order) {
  const out = new Set();
  const apps = order?.discount_applications || [];
  for (const a of apps) {
    if ((a?.type || "").toLowerCase() === "discount_code" && a?.code)
      out.add(String(a.code).toLowerCase());
  }
  const legacy = order?.discount_codes || [];
  for (const d of legacy) {
    if (d?.code) out.add(String(d.code).toLowerCase());
  }
  return Array.from(out);
}

function awardXP(discordId, amount, orderId) {
  db.prepare(
    `INSERT INTO xp (discord_id, xp, orders) VALUES (?, ?, 1)
     ON CONFLICT(discord_id) DO UPDATE SET xp = xp + excluded.xp, orders = orders + 1`
  ).run(discordId, amount);
  console.log(`+${amount} XP to ${discordId} for order ${orderId || "n/a"}`);
}

/* ================= Webhooks ================= */

/* ---- ORDER PAID: award XP ---- */
app.post("/webhook/orders-paid", shopifyRaw, (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) {
      console.log("invalid hmac (orders-paid)");
      return res.status(401).send("invalid hmac");
    }
    const order = JSON.parse(req.body.toString("utf8"));

    // 1) find recipient by affiliate code (primary), fallback to email
    const codes = collectDiscountCodesFromOrder(order);
    let discordId = null;

    for (const code of codes) {
      const row = db.prepare(`SELECT discord_id FROM code_map WHERE code=?`).get(code.toLowerCase());
      if (row?.discord_id) {
        discordId = row.discord_id;
        break; // first matching code wins
      }
    }
    if (!discordId) {
      const email = (order?.email || order?.customer?.email || "")
        .toLowerCase()
        .trim();
      if (email) {
        const map = db.prepare(`SELECT discord_id FROM email_map WHERE email=?`).get(email);
        if (map?.discord_id) discordId = map.discord_id;
      }
    }
    if (!discordId) {
      console.log(
        "No mapping for order",
        order?.id,
        "codes:",
        codes.join(", ") || "none"
      );
      return res.status(200).send("ok");
    }

    // 2) compute net & gate by threshold
    const net = estimateNetRevenueFromOrder(order);
    if ((net <= 0 || net < MIN_NET_FOR_XP) && !ALLOW_ZERO_NET_XP) {
      console.log(
        `No XP (net £${net.toFixed(2)} < min £${MIN_NET_FOR_XP}) for order ${order?.id}; codes: ${codes.join(", ") || "none"}`
      );
      return res.status(200).send("ok");
    }

    // 3) base hybrid XP
    let xp = calcHybridXP(net);

    // 4) bonuses
    const ordersCount = parseNumber(order?.customer?.orders_count); // Shopify's customer total
    if (ordersCount === 1) {
      xp += Math.round(Math.max(0, XP_NEW_CUSTOMER_BONUS));
    }
    const existing = db.prepare(`SELECT orders FROM xp WHERE discord_id=?`).get(discordId);
    if (!existing || parseNumber(existing.orders) === 0) {
      xp += Math.round(Math.max(0, XP_FIRST_VERIFIED_BONUS));
    }

    // 5) write: xp tally & order ledger
    awardXP(discordId, xp, order?.id);
    db.prepare(
      `INSERT INTO order_xp (order_id, discord_id, xp_awarded, net_revenue)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(order_id) DO NOTHING`
    ).run(String(order.id), discordId, xp, net);

    return res.status(200).send("ok");
  } catch (e) {
    console.error("orders-paid error:", e);
    return res.status(500).send("error");
  }
});

/* ---- REFUNDS CREATE: claw back proportionally ---- */
app.post("/webhook/refunds-create", shopifyRaw, (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) {
      console.log("invalid hmac (refunds-create)");
      return res.status(401).send("invalid hmac");
    }
    const refund = JSON.parse(req.body.toString("utf8"));

    const orderId = String(refund?.order_id || "");
    if (!orderId) return res.status(200).send("ok");

    const ledger = db
      .prepare(
        `SELECT order_id, discord_id, xp_awarded, net_revenue, refunded_xp FROM order_xp WHERE order_id=?`
      )
      .get(orderId);
    if (!ledger) {
      console.log("refund for unknown order ledger", orderId);
      return res.status(200).send("ok");
    }
    const { discord_id, xp_awarded, net_revenue, refunded_xp } = ledger;

    const refundNet = estimateRefundNetFromRefund(refund);
    if (refundNet <= 0 || net_revenue <= 0) {
      console.log("refund has zero net, skipping", orderId);
      return res.status(200).send("ok");
    }

    const ratio = Math.min(1, refundNet / net_revenue);
    const xpToClaw = Math.round(xp_awarded * ratio);

    const remaining = Math.max(0, xp_awarded - refunded_xp);
    const delta = Math.min(remaining, xpToClaw);
    if (delta <= 0) {
      console.log("refund already fully clawed for", orderId);
      return res.status(200).send("ok");
    }

    db.prepare(`UPDATE xp SET xp = MAX(0, xp - ?) WHERE discord_id=?`).run(
      delta,
      discord_id
    );
    db.prepare(`UPDATE order_xp SET refunded_xp = refunded_xp + ? WHERE order_id=?`).run(
      delta,
      orderId
    );

    console.log(
      `- ${delta} XP clawed back from ${discord_id} for refund on order ${orderId} (ratio ${(ratio * 100).toFixed(1)}%)`
    );
    return res.status(200).send("ok");
  } catch (e) {
    console.error("refunds-create error:", e);
    return res.status(500).send("error");
  }
});

/* ---- ORDERS CANCELLED: claw back any remaining XP ---- */
app.post("/webhook/orders-cancelled", shopifyRaw, (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) {
      console.log("invalid hmac (orders-cancelled)");
      return res.status(401).send("invalid hmac");
    }
    const order = JSON.parse(req.body.toString("utf8"));
    const orderId = String(order?.id || "");
    if (!orderId) return res.status(200).send("ok");

    const ledger = db
      .prepare(
        `SELECT order_id, discord_id, xp_awarded, refunded_xp FROM order_xp WHERE order_id=?`
      )
      .get(orderId);
    if (!ledger) return res.status(200).send("ok");

    const remaining = Math.max(0, ledger.xp_awarded - ledger.refunded_xp);
    if (remaining <= 0) return res.status(200).send("ok");

    db.prepare(`UPDATE xp SET xp = MAX(0, xp - ?) WHERE discord_id=?`).run(
      remaining,
      ledger.discord_id
    );
    db.prepare(`UPDATE order_xp SET refunded_xp = refunded_xp + ? WHERE order_id=?`).run(
      remaining,
      orderId
    );

    console.log(`- ${remaining} XP clawed back for cancelled order ${orderId}`);
    return res.status(200).send("ok");
  } catch (e) {
    console.error("orders-cancelled error:", e);
    return res.status(500).send("error");
  }
});

/* ---- JSON middleware for non-webhook routes ---- */
app.use(express.json());

/* ================= API (Vercel/Manual) ================= */

/* Map email -> Discord (fallback / testing) */
app.post("/map-email", (req, res) => {
  if (!requireBearer(req, res)) return;
  const { email, discordId, username } = req.body || {};
  if (!email || !discordId)
    return res.status(400).json({ ok: false, error: "missing email/discordId" });
  db.prepare(
    `INSERT INTO email_map (email, discord_id, username) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET discord_id=excluded.discord_id, username=excluded.username`
  ).run(String(email).toLowerCase().trim(), String(discordId), username || null);
  return res.json({ ok: true });
});

/* Map affiliate code -> Discord (primary) */
app.post("/map-code", (req, res) => {
  if (!requireBearer(req, res)) return;
  const { code, discordId, email, username } = req.body || {};
  if (!code || !discordId)
    return res.status(400).json({ ok: false, error: "missing code/discordId" });
  db.prepare(
    `INSERT INTO code_map (code, discord_id, email, username) VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       discord_id=excluded.discord_id,
       email=COALESCE(excluded.email, code_map.email),
       username=COALESCE(excluded.username, code_map.username)`
  ).run(
    String(code).toLowerCase().trim(),
    String(discordId),
    email || null,
    username || null
  );
  return res.json({ ok: true });
});

/* Leaderboard JSON (for Vercel /slash) */
app.get("/leaderboard", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
  const rows = db
    .prepare(
      `SELECT discord_id, xp, orders FROM xp ORDER BY xp DESC, orders DESC LIMIT ?`
    )
    .all(limit);
  res.json({ top: rows });
});

/* Publish / refresh pinned leaderboard (manual or auto) */
app.post("/leaderboard/publish", async (req, res) => {
  if (!requireBearer(req, res)) return;
  if (!LEADERBOARD_CHANNEL_ID)
    return res
      .status(400)
      .json({ ok: false, error: "LEADERBOARD_CHANNEL_ID not set" });

  try {
    const top = db
      .prepare(
        `SELECT discord_id, xp, orders FROM xp ORDER BY xp DESC, orders DESC LIMIT 10`
      )
      .all();
    const lines = top.map(
      (r, i) => `${i + 1}. <@${r.discord_id}> — **${r.xp} XP** (${r.orders} orders)`
    );
    const content = `🏆 **Creator Leaderboard**\n${
      lines.length ? lines.join("\n") : "_No data yet_"
    }\n\n_Last update: <t:${Math.floor(Date.now() / 1000)}:R>_`;

    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.send)
      return res
        .status(400)
        .json({ ok: false, error: "channel not found or not text" });

    const pins = await ch.messages.fetchPinned().catch(() => null);
    const existing = pins?.find(
      (m) =>
        m.author?.id === client.user.id &&
        m.content?.startsWith("🏆 **Creator Leaderboard**")
    );

    if (existing) {
      await existing.edit({ content });
      console.log("Leaderboard message updated");
    } else {
      const msg = await ch.send({ content });
      try {
        await msg.pin();
      } catch {}
      if (pins) {
        const others = pins.filter(
          (m) =>
            m.id !== msg.id &&
            m.author?.id === client.user.id &&
            m.content?.startsWith("🏆 **Creator Leaderboard**")
        );
        for (const [, m] of others) {
          try {
            await m.unpin();
          } catch {}
        }
      }
      console.log("Leaderboard message posted & pinned");
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("leaderboard publish error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---- Auth helper ---- */
function requireBearer(req, res) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!API_SHARED_SECRET || token !== API_SHARED_SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

/* ---- Error handler ---- */
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).send("server error");
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

/* ---- OPTIONAL: auto-refresh pinned board ---- */
if (REFRESH_MINUTES > 0) {
  setInterval(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/leaderboard/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_SHARED_SECRET}` },
      });
      if (!r.ok) console.log("auto-refresh failed", r.status);
    } catch (e) {
      console.log("auto-refresh error", e.message);
    }
  }, REFRESH_MINUTES * 60 * 1000);
}
