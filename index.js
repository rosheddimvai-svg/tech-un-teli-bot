"use strict";

/**
 * FB Business Manager Helper Bot (Expanded, Fast, English-only)
 * --------------------------------------------------------------------
 * Highlights:
 *  - English-only, emoji + bold UI copy (no mixed languages)
 *  - Cookie-gated flow: press "🏢 Create FB-BM" → ask for cookies (bold title)
 *  - Auto-create up to 5 BMs with names "Tech Underworld ####"
 *  - Each BM shows Name + BM ID + inline button "📧 Invite People"
 *  - Invite flow uses your provided endpoints/shape:
 *      * (optional) email check (kept light for speed)
 *      * GraphQL mutation doc_id: 31295717360015609
 *  - Invite confirmation prints: BM Name + BM ID + Email
 *  - PERFORMANCE: shared browser, block heavy resources, short timeouts, minimal waits
 *
 * Safe defaults:
 *  - We still wait for DTSGInitialData to avoid token issues (fast but safe)
 *  - Small delay between attempts (700–900ms) to reduce rate failures
 *
 * Author: you + assistant
 */

/* =========================
 * Imports
 * ========================= */
const TelegramBot = require("node-telegram-bot-api");
const puppeteer = require("puppeteer");

/* =========================
 * Config
 * ========================= */
const BOT_TOKEN = "8336:AAGFMei05q6BTfU71fJiwS0C-HpiM8OB6Ng";

// How many BMs to attempt per run
const MAX_BM_ATTEMPTS = 5;

// Brand prefix (your request)
const BRAND_PREFIX = "Tech Underworld";

// Menu labels (centralized to keep consistency)
const MENU_CREATE = "🏢 Create FB-BM";
const MENU_STATUS = "📊 My Status";
const MENU_RULES  = "📜 Rules";
const MENU_ADMIN  = "👨‍💻 Contact Admin";

// Inline button label for invites (your request)
const BTN_INVITE = "📧 Invite People";

// Developer & Channel (customize as needed)
const DEV_HANDLE = "@Rs_Rezaul_99";
const CHANNEL_URL = "https://t.me/+QeJUwONgZp05ZDVl";

/* =========================
 * Telegram: init
 * ========================= */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/**
 * Session object:
 * chatId -> {
 *   state: 'idle' | 'awaiting_cookies' | 'awaiting_email',
 *   cookies?: string,
 *   userId?: string,              // from c_user
 *   bms: Array<{ brand: string, id: string }>,
 *   pendingBmId?: string,         // for invite flow
 * }
 */
const sessions = Object.create(null);

/* =========================
 * Browser Pool (shared)
 * ========================= */
let sharedBrowser = null;

/**
 * Get or create a shared Puppeteer browser (fast!)
 * - Helps keep the experience "storm-fast" without re-launch overhead.
 */
async function getBrowser() {
  if (sharedBrowser && sharedBrowser.process()) return sharedBrowser;
  sharedBrowser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  return sharedBrowser;
}

/**
 * Create a new optimized page:
 * - Blocks images, fonts, stylesheets, media
 * - Short timeouts
 */
async function newOptimizedPage(browser) {
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "stylesheet" || type === "media") {
      return req.abort();
    }
    req.continue();
  });

  // Snappy timeouts (tuned for speed while staying reliable)
  page.setDefaultTimeout(22000);
  page.setDefaultNavigationTimeout(22000);

  return page;
}

/* =========================
 * UI Helpers
 * ========================= */
function ensureSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { state: "idle", bms: [] };
  return sessions[chatId];
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [MENU_CREATE],
        [MENU_STATUS, MENU_RULES],
        [MENU_ADMIN],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
    parse_mode: "HTML",
  };
}

/** Inline keyboard for a single BM row (with invite button) */
function bmRowMarkup(bm) {
  return {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: BTN_INVITE, callback_data: `invite_${bm.id}` }],
      ],
    },
    disable_web_page_preview: true,
  };
}

/* =========================
 * Generic Utilities
 * ========================= */

/** Parse a cookie by name from a raw cookie string */
function getCookieValue(cookieString, name) {
  try {
    const m = cookieString
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="));
    return m ? decodeURIComponent(m.split("=")[1]) : null;
  } catch {
    return null;
  }
}

/** Keep only the cookies FB needs (reduce size/noise) */
function filterCookies(cookieString) {
  const allowed = ["c_user", "xs", "fr", "datr"];
  return cookieString
    .split(";")
    .map((pair) => {
      const [name, ...rest] = pair.split("=");
      return { name: name.trim(), value: rest.join("=").trim(), domain: ".facebook.com" };
    })
    .filter((c) => allowed.includes(c.name));
}

/** FB sometimes prefixes JSON with `for (;;);` — strip it and parse */
function safeParseFb(body) {
  try {
    const cleaned = (body || "").replace(/^for\s*\(;;\);\s*/, "");
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/* =========================
 * Cookie Validation
 * ========================= */

/**
 * Quick cookie validation:
 * - Loads facebook.com and checks for "Log in" in the title
 * - Not bulletproof, but fast & sufficient to catch bad cookies
 */
async function checkFacebookLogin(cookieString) {
  try {
    const browser = await getBrowser();
    const page = await newOptimizedPage(browser);
    await page.setCookie(...filterCookies(cookieString));
    await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded" });
    const title = await page.title();
    await page.close();
    return !/log in/i.test(title);
  } catch (err) {
    console.log("Cookie validation error:", err?.message);
    return false;
  }
}

/* =========================
 * BM Creation
 * ========================= */

/** Wait for DTSG token to be available (fast but safe) */
async function waitForDtsg(page) {
  await page.waitForFunction(
    () => {
      try {
        return typeof require === "function" && !!require("DTSGInitialData");
      } catch {
        return false;
      }
    },
    { timeout: 17000 }
  );
}

/** One BM creation inside page context */
async function createSingleBM(page) {
  return await page.evaluate(async (BRAND_PREFIX) => {
    const fb_dtsg = require("DTSGInitialData").token;
    const brand = `${BRAND_PREFIX} ${Math.floor(Math.random() * 10000)}`;
    const res = await fetch("https://business.facebook.com/business/create_account", {
      method: "POST",
      body:
        `brand_name=${encodeURIComponent(brand)}&first_name=bot&last_name=user` +
        `&email=test${Date.now()}@mail.com&timezone_id=17&business_category=OTHER&is_b2b=false&__a=1&fb_dtsg=${encodeURIComponent(fb_dtsg)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      credentials: "include",
    });
    const text = await res.text();
    return { brand, body: text };
  }, BRAND_PREFIX);
}

/**
 * Create up to MAX_BM_ATTEMPTS BMs quickly but safely.
 * - Reuses same page (fewer navigations)
 * - Small delay between attempts to avoid server-side throttling
 */
async function createBusinessManagers(session, chatId) {
  const browser = await getBrowser();
  const page = await newOptimizedPage(browser);

  const success = [];
  let fails = 0;

  try {
    // Initialize session with cookies
    await page.setCookie(...filterCookies(session.cookies));

    // Go to BM tools (tokens live here)
    await page.goto("https://business.facebook.com/business-tools", {
      waitUntil: "domcontentloaded",
    });

    // Token wait (fast)
    await waitForDtsg(page);

    // Attempts
    for (let i = 1; i <= MAX_BM_ATTEMPTS; i++) {
      await bot.sendMessage(chatId, `🔄 <b>Attempt ${i}/${MAX_BM_ATTEMPTS}</b>`, { parse_mode: "HTML" });

      const result = await createSingleBM(page);

      // Extract business_id from response body
      const match = result.body.match(/business_id=(\d+)/);
      if (match) {
        const bm = { brand: result.brand, id: match[1] };
        session.bms.push(bm);
        success.push(bm);

        await bot.sendMessage(
          chatId,
          `✅ <b>${bm.brand}</b>\n🆔 <b>BM ID:</b> <code>${bm.id}</code>`,
          bmRowMarkup(bm)
        );
      } else {
        fails++;
        await bot.sendMessage(chatId, `❌ <b>Failed on attempt ${i}</b>`, { parse_mode: "HTML" });
      }

      // Tiny delay to prevent burst errors, but still "storm-fast"
      await new Promise((r) => setTimeout(r, 750));
    }
  } catch (err) {
    console.error("BM creation error:", err);
    try { await page.close(); } catch {}
    return `<b>🚨 Error during BM creation.</b>`;
  }

  try { await page.close(); } catch {}

  // Summary message
  const lines = [];
  lines.push(`📊 <b>BM Creation Report</b>`);
  lines.push(``);
  lines.push(`✅ <b>Successfully created:</b> <b>${success.length}</b>`);
  lines.push(`❌ <b>Failed attempts:</b> <b>${fails}</b>`);
  lines.push(``);
  if (success.length) {
    lines.push(`<b>Created BM(s):</b>`);
    success.forEach((bm, i) =>
      lines.push(`✨ <b>${i + 1}. ${bm.brand}</b> <b>(ID:</b> <code>${bm.id}</code><b>)</b>`)
    );
  } else {
    lines.push(`<b>No BM created in this run.</b>`);
  }
  return lines.join("\n");
}

/* =========================
 * Invite Flow
 * ========================= */

/** Get tokens & timezone from page */
async function collectTokens(page) {
  return await page.evaluate(() => {
    let dtsg = null, dtsgAsync = null, tz = "UTC";
    try { dtsg = require("DTSGInitialData").token; } catch {}
    try { dtsgAsync = require("DTSG_ASYNC").token; } catch {}
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch {}
    return { dtsg, dtsgAsync, tz };
  });
}

/** Optional: email check (you provided; kept light to avoid extra latency) */
async function fbEmailCheck(page, { bmId, email, dtsgAsync }) {
  return await page.evaluate(async ({ bmId, email, dtsgAsync }) => {
    const url =
      "https://business.facebook.com/business/invite_users_email_check/?" +
      `business_id=${encodeURIComponent(bmId)}` +
      `&user_emails[0]=${encodeURIComponent(email)}` +
      `&fb_dtsg_ag=${encodeURIComponent(dtsgAsync || "")}` +
      `&__a=1`;
    const res = await fetch(url, { method: "GET", credentials: "include" });
    const text = await res.text();
    return { status: res.status, body: text };
  }, { bmId, email, dtsgAsync });
}

/** Finalize invite via GraphQL mutation */
async function fbInviteFinalize(page, { bmId, email, viewerId, fb_dtsg, tz }) {
  return await page.evaluate(async ({ bmId, email, viewerId, fb_dtsg, tz }) => {
    // Task IDs from your payload; kept stable as of your logs
    const BUSINESS_TASK_IDS = [
      "926381894526285","603931664885191","1327662214465567","862159105082613",
      "6161001899617846786","1633404653754086","967306614466178","2848818871965443",
      "245181923290198","388517145453246"
    ];

    const variables = {
      input: {
        client_mutation_id: String(Date.now() % 1e9),
        actor_id: String(viewerId),
        business_id: String(bmId),
        business_emails: [email],
        business_account_task_ids: BUSINESS_TASK_IDS,
        invite_origin_surface: "MBS_INVITE_USER_FLOW",
        assets: [],
        use_detailed_coded_exception: true,
        expiry_time: 0,
        is_spark_permission: false,
        client_timezone_id: tz || "Asia/Dhaka",
      },
    };

    const body = new URLSearchParams();
    body.append("fb_dtsg", fb_dtsg);
    body.append("doc_id", "31295717360015609"); // BizKitSettingsInvitePeopleModalMutation
    body.append("server_timestamps", "true");
    body.append("variables", JSON.stringify(variables));

    const res = await fetch("https://business.facebook.com/api/graphql/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      credentials: "include",
      body,
    });
    const text = await res.text();
    return { status: res.status, body: text };
  }, { bmId, email, viewerId, fb_dtsg, tz });
}

/** High-level invite orchestration (fast, token-safe) */
async function sendInviteFullFlow({ bmId, cookies, viewerId, email }) {
  const browser = await getBrowser();
  const page = await newOptimizedPage(browser);

  try {
    // Open a BM settings page to init session/tokens
    await page.setCookie(...filterCookies(cookies));
    await page.goto(
      `https://business.facebook.com/latest/settings/business_users?business_id=${bmId}`,
      { waitUntil: "domcontentloaded" }
    );

    const tokens = await collectTokens(page);
    if (!tokens.dtsg) {
      await page.close();
      return { ok: false, reason: "fb_dtsg token not found (login/cookies issue)." };
    }

    // Optional: quick email_check (kept but not over-validated to save time)
    const check = await fbEmailCheck(page, {
      bmId,
      email,
      dtsgAsync: tokens.dtsgAsync,
    });

    if (check.status !== 200) {
      await page.close();
      return { ok: false, reason: `email_check HTTP ${check.status}` };
    }

    const parsedCheck = safeParseFb(check.body);
    if (parsedCheck?.payload?.errors?.length) {
      const reason = parsedCheck.payload.errors[0]?.summary || "email_check error";
      await page.close();
      return { ok: false, reason };
    }
    // If already member or has pending invites, we still try finalize (idempotent-ish)
    // Continue…

    // Finalize invite via GraphQL
    const finalize = await fbInviteFinalize(page, {
      bmId,
      email,
      viewerId,
      fb_dtsg: tokens.dtsg,
      tz: tokens.tz,
    });

    await page.close();

    if (finalize.status !== 200) {
      return { ok: false, reason: `finalize HTTP ${finalize.status}` };
    }

    const parsedFinalize = safeParseFb(finalize.body);
    const hasErr = parsedFinalize?.payload?.errors?.length || parsedFinalize?.errors?.length;
    if (hasErr) {
      const reason =
        parsedFinalize?.payload?.errors?.[0]?.summary ||
        parsedFinalize?.errors?.[0]?.message ||
        "finalize error";
      return { ok: false, reason };
    }

    return { ok: true };
  } catch (e) {
    try { await page.close(); } catch {}
    return { ok: false, reason: e.message };
  }
}

/* =========================
 * Telegram Handlers
 * ========================= */

/** /start → Welcome + menu */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  ensureSession(chatId);

  const welcome = `
🔗 <b>Join our Channel:</b> 👉 <a href="${CHANNEL_URL}"><b>Click here</b></a>

👋 <b>Welcome ${msg.from.first_name || ""}!</b>
🚀 Create up to <b>${MAX_BM_ATTEMPTS} ${BRAND_PREFIX} BMs</b> automatically.

<b>Steps</b>  
1️⃣ Tap <b>${MENU_CREATE}</b>  
2️⃣ Paste your Facebook cookies (<code>c_user, xs, fr, datr</code>)  
3️⃣ Watch the bot create BMs at top speed  
4️⃣ Tap <b>${BTN_INVITE}</b> to add members

👨‍💻 <b>Developer:</b> <b>${DEV_HANDLE}</b>
`.trim();

  bot.sendMessage(chatId, welcome, { parse_mode: "HTML", ...mainMenu() });
});

/**
 * Single message handler (state machine)
 * - Keeps logic predictable, avoids duplicate triggers
 */
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const sess = ensureSession(chatId);

  // Ignore bot's own secondaries
  if (msg?.via_bot) return;

  /* ----------------
   * Menu Actions
   * ---------------- */
  if (text === MENU_CREATE) {
    sess.state = "awaiting_cookies";
    const ask = `
<b>🎯 Send Your Facebook Cookie</b>

📌 <b>Please paste your FB cookies below</b> (must include: <code>c_user, xs, fr, datr</code>).
`.trim();
    return bot.sendMessage(chatId, ask, { parse_mode: "HTML" });
  }

  if (text === MENU_STATUS) {
    if (!sess.bms.length) {
      return bot.sendMessage(chatId, `ℹ️ <b>No BM created yet.</b>`, { parse_mode: "HTML", ...mainMenu() });
    }
    // Summary + per-BM inline rows
    let out = `📊 <b>Your Created BMs:</b>\n`;
    out += sess.bms.map((bm, i) => `✨ <b>${i + 1}. ${bm.brand}</b> (ID: <code>${bm.id}</code>)`).join("\n");
    await bot.sendMessage(chatId, out, { parse_mode: "HTML" });

    for (const bm of sess.bms) {
      await bot.sendMessage(chatId, `🏢 <b>${bm.brand}</b>\n🆔 <code>${bm.id}</code>`, bmRowMarkup(bm));
    }
    return;
  }

  if (text === MENU_RULES) {
    const rules = `
📜 <b>Bot Rules</b>
✅ Always use fresh cookies before creation
🔁 Max <b>${MAX_BM_ATTEMPTS}</b> attempts per run
⚡ Fast mode is enabled—please don't spam buttons
⏳ If a step takes a few seconds, let it finish
🚫 Don't misuse or violate platform policies
📢 Join channel for tips & updates
`.trim();
    return bot.sendMessage(chatId, rules, { parse_mode: "HTML", ...mainMenu() });
  }

  if (text === MENU_ADMIN) {
    return bot.sendMessage(chatId, `📞 <b>Admin:</b> <b>${DEV_HANDLE}</b>`, { parse_mode: "HTML", ...mainMenu() });
  }

  /* ----------------
   * State: Awaiting Cookies
   * ---------------- */
  if (sess.state === "awaiting_cookies") {
    // Must at least contain c_user + xs
    if (!text.includes("c_user") || !text.includes("xs")) {
      return bot.sendMessage(
        chatId,
        `⚠️ <b>Invalid cookies.</b> Paste cookies that include at least <code>c_user</code> and <code>xs</code>.`,
        { parse_mode: "HTML" }
      );
    }

    await bot.sendMessage(chatId, `🔎 <b>Validating your cookies...</b>`, { parse_mode: "HTML" });
    const isValid = await checkFacebookLogin(text);
    if (!isValid) {
      return bot.sendMessage(chatId, `❌ <b>Invalid cookies. Please try again.</b>`, {
        parse_mode: "HTML",
        ...mainMenu(),
      });
    }

    // Save session details
    sess.cookies = text;
    sess.userId = getCookieValue(text, "c_user");
    sess.state = "idle";

    await bot.sendMessage(chatId, `✅ <b>Cookies accepted!</b> 🚀 <b>Creating BMs...</b>`, { parse_mode: "HTML" });
    const result = await createBusinessManagers(sess, chatId);
    return bot.sendMessage(chatId, result, { parse_mode: "HTML", ...mainMenu() });
  }

  /* ----------------
   * State: Awaiting Email (Invite flow)
   * ---------------- */
  if (sess.state === "awaiting_email" && sess.pendingBmId) {
    const email = text;
    const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    if (!ok) {
      return bot.sendMessage(
        chatId,
        `⚠️ <b>Invalid email format.</b> Example: <code>user@gmail.com</code>`,
        { parse_mode: "HTML" }
      );
    }

    const bmId = sess.pendingBmId;
    const bm = sess.bms.find((b) => b.id === bmId);
    sess.state = "idle";
    sess.pendingBmId = null;

    await bot.sendMessage(
      chatId,
      `📨 <b>Sending invite for</b> <b>${bm.brand}</b> <b>(ID:</b> <code>${bm.id}</code><b>) →</b> <b>${email}</b>`,
      { parse_mode: "HTML" }
    );

    const res = await sendInviteFullFlow({
      bmId,
      cookies: sess.cookies,
      viewerId: sess.userId,
      email,
    });

    if (res.ok) {
      return bot.sendMessage(chatId, `✅ <b>Invite sent!</b> 📧 <b>${email}</b>`, { parse_mode: "HTML" });
    } else {
      return bot.sendMessage(chatId, `❌ <b>Failed:</b> <b>${res.reason || "Unknown error"}</b>`, { parse_mode: "HTML" });
    }
  }

  /* ----------------
   * If cookies pasted without pressing Create first
   * ---------------- */
  if (text.includes("c_user") && text.includes("xs") && sess.state !== "awaiting_cookies") {
    return bot.sendMessage(
      chatId,
      `<b>Please tap "${MENU_CREATE}" first, then paste your cookies.</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  }
});

/** Inline callback handler for Invite buttons */
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || "";
  const sess = ensureSession(chatId);

  if (data.startsWith("invite_")) {
    const bmId = data.replace("invite_", "");
    const bm = sess.bms.find((b) => b.id === bmId);
    if (!bm) return bot.answerCallbackQuery(query.id, { text: "BM not found in your session." });

    sess.state = "awaiting_email";
    sess.pendingBmId = bmId;

    return bot.sendMessage(
      chatId,
      `✍️ <b>Enter the invitee email for</b> <b>${bm.brand}</b> <b>(ID:</b> <code>${bm.id}</code><b>)</b>`,
      { parse_mode: "HTML" }
    );
  }
});

