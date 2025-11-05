/* ---- ORDER PAID: award XP ---- */
app.post("/webhook/orders-paid", shopifyRaw, (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) {
      console.log("invalid hmac (orders-paid)");
      return res.status(401).send("invalid hmac");
    }

    const order = JSON.parse(req.body.toString("utf8"));

    // 1️⃣ find recipient by affiliate code (primary), fallback to email
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
      const email = (order?.email || order?.customer?.email || "").toLowerCase().trim();
      if (email) {
        const map = db.prepare(`SELECT discord_id FROM email_map WHERE email=?`).get(email);
        if (map?.discord_id) discordId = map.discord_id;
      }
    }

    if (!discordId) {
      console.log("No mapping for order", order?.id, "codes:", codes.join(", ") || "none");
      return res.status(200).send("ok");
    }

    // 2️⃣ compute net & gate by threshold
    const net = estimateNetRevenueFromOrder(order);

    // --- Gate: allow £0 tests to earn XP (when ALLOW_ZERO_NET_XP=true)
    if (net <= 0 || net < MIN_NET_FOR_XP) {
      if (ALLOW_ZERO_NET_XP) {
        // Award normal base + bonuses (no flat override)
        let xp = Math.round(Math.max(0, XP_BASE));

        // bonuses
        const ordersCount = parseNumber(order?.customer?.orders_count);
        if (ordersCount === 1) xp += Math.round(Math.max(0, XP_NEW_CUSTOMER_BONUS));
        const existing = db.prepare(`SELECT orders FROM xp WHERE discord_id=?`).get(discordId);
        if (!existing || parseNumber(existing.orders) === 0)
          xp += Math.round(Math.max(0, XP_FIRST_VERIFIED_BONUS));

        awardXP(discordId, xp, order?.id);
        db.prepare(
          `INSERT INTO order_xp (order_id, discord_id, xp_awarded, net_revenue)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(order_id) DO NOTHING`
        ).run(String(order.id), discordId, xp, net);

        console.log(`+${xp} XP (allowed for £0 test) to ${discordId} for order ${order?.id}`);
        return res.status(200).send("ok");
      } else {
        console.log(
          `No XP (net £${net.toFixed(2)} < min £${MIN_NET_FOR_XP}) for order ${order?.id}; codes: ${codes.join(", ") || "none"}`
        );
        return res.status(200).send("ok");
      }
    }

    // 3️⃣ base hybrid XP (normal path)
    let xp = calcHybridXP(net);

    // 4️⃣ bonuses
    const ordersCount = parseNumber(order?.customer?.orders_count);
    if (ordersCount === 1)
      xp += Math.round(Math.max(0, XP_NEW_CUSTOMER_BONUS));
    const existing = db.prepare(`SELECT orders FROM xp WHERE discord_id=?`).get(discordId);
    if (!existing || parseNumber(existing.orders) === 0)
      xp += Math.round(Math.max(0, XP_FIRST_VERIFIED_BONUS));

    // 5️⃣ write XP tally & order ledger
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
