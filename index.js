/**
 * eIPL Official Bot
 * Pure Node.js & CommonJS Telegram Bot Engine
 * Framework: grammY
 * Standard: Node.js / NPM (Zero Bun / Frozen Lockfile dependencies)
 */

const { Bot, InlineKeyboard, Keyboard, InputFile } = require("grammy");
const http = require("http");
require("dotenv").config();

const {
  initFirebase,
  getDb,
  isFirebaseReady,
  normalizeUserRecord,
  getUser,
  saveUser,
  updateUser,
  updateUserPoints,
  getAllUsers,
  seedUsersIfEmpty,
  subscribeToUsers,
  getAllPromoCodes,
  seedPromoCodesIfEmpty,
  savePromoCode,
  recordPromoCodeRedemption,
  subscribeToPromoCodes,
  savePayoutRequest,
  updatePayoutRequest,
  getAllPayoutRequests,
  subscribeToPayoutRequests,
  updateUserReferralCash,
  DEFAULT_PROMO_CODES,
  SEED_USERS,
  DATABASE_URL
} = require("./firebaseConfig");

// ==========================================
// 1. CONFIGURATION & SECRETS
// ==========================================
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const ADMIN_ID_1 = (process.env.ADMIN_ID_1 || "1234567890").trim();
const ADMIN_ID_2 = (process.env.ADMIN_ID_2 || "9876543210").trim();
const RAW_SUPPORT_LINK = (process.env.SUPPORT_LINK || "https://t.me/eIPL_Support").trim();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Global state for dynamic admin controls
let withdrawalsEnabled = true;

// Helper: Normalize any Telegram link or username into a valid https:// URL
function formatTelegramUrl(link, fallback = "https://t.me/eIPL_Support") {
  if (!link || typeof link !== "string") return fallback;
  const trimmed = link.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("@")) {
    return `https://t.me/${trimmed.slice(1)}`;
  }
  if (trimmed.startsWith("t.me/")) {
    return `https://${trimmed}`;
  }
  return `https://t.me/${trimmed}`;
}

const SUPPORT_URL = formatTelegramUrl(RAW_SUPPORT_LINK);

// Helper: Escape HTML special characters for safe Telegram HTML formatting
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Helper: Ensure valid UTF-8 string and prevent lone surrogates from crashing Telegram API
function cleanUtf8(str) {
  if (!str) return "";
  return String(str).toWellFormed().replace(/\uFFFD/g, "");
}

// Helper: Safely get the first grapheme/character without splitting Unicode surrogate pairs
function getInitial(str) {
  if (!str) return "";
  const chars = Array.from(String(str).trim());
  return chars.length > 0 ? chars[0] : "";
}

// ==========================================
// 2. IN-MEMORY STORAGE & FIREBASE RTDB SYNC
// ==========================================
// userId -> { id, firstName, lastName, username, points, referrerId, isVerified, joinedAt, joinedTimestamp, lastCheckin, lastSpin, referralsCount }
const users = new Map();
const verifiedUsers = new Set(); // Persistent cache of verified user IDs
const payoutRequests = new Map(); // requestId -> { requestId, userId, userName, amount, refersCount, paymentDetails, status, timestamp }

// Immediately preload all 31 restored user records into memory to prevent memory wipe issues
for (const [uid, record] of Object.entries(SEED_USERS)) {
  const norm = normalizeUserRecord(uid, record);
  users.set(String(uid), norm);
  if (norm.isVerified || norm.verified) {
    verifiedUsers.add(String(uid));
  }
}
console.log(`[Storage] Initialized with ${users.size} verified user records from CSV seed.`);

// Bootstrap Firebase Realtime Database asynchronously
(async () => {
  try {
    initFirebase();
    if (isFirebaseReady()) {
      // 1. Automatic CSV data seeding to Firebase if empty or missing records
      const seedResult = await seedUsersIfEmpty(SEED_USERS);
      console.log(`[Firebase RTDB Boot] Seed status: ${seedResult.seeded} restored, ${seedResult.existing} existing.`);

      // 2. Hydrate in-memory cache with all users from Firebase
      const allDbUsers = await getAllUsers();
      if (allDbUsers) {
        for (const [uid, record] of Object.entries(allDbUsers)) {
          users.set(String(uid), record);
          if (record.isVerified || record.verified) {
            verifiedUsers.add(String(uid));
          }
        }
        console.log(`[Firebase RTDB Boot] Local cache synced with ${users.size} total Firebase users.`);
      }

      // 3. Attach real-time listener to keep memory state synchronized live
      subscribeToUsers((updatedUsersMap) => {
        if (!updatedUsersMap) return;
        for (const [uid, record] of updatedUsersMap.entries()) {
          users.set(uid, record);
          if (record.isVerified || record.verified) {
            verifiedUsers.add(uid);
          }
        }
      });

      // 4. Seed and sync active promo codes with Firebase RTDB (/promo_codes)
      const promoSeedRes = await seedPromoCodesIfEmpty(DEFAULT_PROMO_CODES);
      console.log(`[Firebase RTDB Boot] Promo codes status: ${promoSeedRes.seeded} seeded, ${promoSeedRes.existing} existing.`);

      const allDbCodes = await getAllPromoCodes();
      if (allDbCodes) {
        for (const [codeKey, cData] of Object.entries(allDbCodes)) {
          if (!cData) continue;
          const cleanKey = codeKey.toUpperCase();
          const usedSet = new Set(Object.keys(cData.usedBy || {}));
          redeemCodes.set(cleanKey, {
            code: cleanKey,
            points: Number(cData.points) || 5,
            maxUses: Number(cData.maxUses) || 1000,
            active: cData.active !== false,
            usedBy: usedSet,
            description: cData.description || "",
            createdAt: cData.createdAt || new Date().toISOString()
          });
        }
        console.log(`[Firebase RTDB Boot] Synced ${redeemCodes.size} promo codes from database.`);
      }

      // 5. Attach real-time listener for promo codes
      subscribeToPromoCodes((codesData) => {
        if (!codesData) return;
        for (const [codeKey, cData] of Object.entries(codesData)) {
          if (!cData) continue;
          const cleanKey = codeKey.toUpperCase();
          const usedSet = new Set(Object.keys(cData.usedBy || {}));
          const existing = redeemCodes.get(cleanKey);
          redeemCodes.set(cleanKey, {
            code: cleanKey,
            points: Number(cData.points) || existing?.points || 5,
            maxUses: Number(cData.maxUses) || existing?.maxUses || 1000,
            active: cData.active !== false,
            usedBy: usedSet,
            description: cData.description || existing?.description || "",
            createdAt: cData.createdAt || existing?.createdAt || new Date().toISOString()
          });
        }
      });

      // 6. Hydrate and sync payout requests from Firebase RTDB (/payout_requests)
      const allDbPayouts = await getAllPayoutRequests();
      if (allDbPayouts) {
        for (const [reqId, pData] of Object.entries(allDbPayouts)) {
          if (pData) {
            payoutRequests.set(String(reqId), pData);
          }
        }
        console.log(`[Firebase RTDB Boot] Synced ${payoutRequests.size} payout requests from database.`);
      }

      // 7. Attach real-time listener for payout requests
      subscribeToPayoutRequests((pDataObj) => {
        if (!pDataObj) return;
        for (const [reqId, pData] of Object.entries(pDataObj)) {
          if (pData) {
            payoutRequests.set(String(reqId), pData);
          }
        }
      });
    }
  } catch (err) {
    console.error("[Firebase RTDB Boot Error]:", err.message);
  }
})();

// Default mandatory channels configuration
const dynamicChannels = [
  {
    name: "Pritam Looters",
    id: "@saurabh_editz",
    link: "https://t.me/saurabh_editz"
  },
  {
    name: "Redeem & Gift Loot-2",
    id: "@smartmoneyboost2",
    link: "https://t.me/smartmoneyboost2"
  }
];

// Pre-loaded 5 Active Unique Promo Codes (Points: 2 to 10 points)
const redeemCodes = new Map([
  [
    "EIPLBONUS",
    {
      code: "EIPLBONUS",
      points: 9,
      maxUses: 1000,
      active: true,
      usedBy: new Set(),
      description: "eIPL Special VIP Bonus Drop",
      createdAt: new Date().toISOString()
    }
  ],
  [
    "LUCKY7",
    {
      code: "LUCKY7",
      points: 7,
      maxUses: 500,
      active: true,
      usedBy: new Set(),
      description: "Lucky 7 Exclusive Gift Code",
      createdAt: new Date().toISOString()
    }
  ],
  [
    "WELCOME5",
    {
      code: "WELCOME5",
      points: 5,
      maxUses: 2000,
      active: true,
      usedBy: new Set(),
      description: "Welcome Free Starter Points",
      createdAt: new Date().toISOString()
    }
  ],
  [
    "SPINWIN3",
    {
      code: "SPINWIN3",
      points: 3,
      maxUses: 1000,
      active: true,
      usedBy: new Set(),
      description: "Spin & Win Extra Points Drop",
      createdAt: new Date().toISOString()
    }
  ],
  [
    "SUPER10",
    {
      code: "SUPER10",
      points: 10,
      maxUses: 500,
      active: true,
      usedBy: new Set(),
      description: "Super 10 Mega VIP Drop",
      createdAt: new Date().toISOString()
    }
  ],
  [
    "EIPLFREE120",
    {
      code: "EIPLFREE120",
      points: 10,
      maxUses: 10000,
      active: true,
      usedBy: new Set(),
      description: "Demo Free Gift Code",
      createdAt: new Date().toISOString()
    }
  ]
]);

const admins = new Set([ADMIN_ID_1, ADMIN_ID_2].filter(Boolean));
const userStates = new Map(); // userId -> { action: string, data?: any }
const activityLogs = [];

function logActivity(type, text) {
  const logItem = { time: new Date().toISOString(), type, text };
  activityLogs.push(logItem);
  if (activityLogs.length > 100) activityLogs.shift();
  console.log(`[${type.toUpperCase()}] ${text}`);
}

function isAdmin(userId) {
  if (!userId) return false;
  const numId = Number(userId);
  const strId = String(userId).trim();
  const a1Num = Number(ADMIN_ID_1);
  const a2Num = Number(ADMIN_ID_2);
  const a1Str = String(ADMIN_ID_1).trim();
  const a2Str = String(ADMIN_ID_2).trim();

  return (
    (a1Num && numId === a1Num) ||
    (a2Num && numId === a2Num) ||
    strId === a1Str ||
    strId === a2Str ||
    admins.has(strId) ||
    admins.has(numId)
  );
}

function getOrCreateUser(from, referrerId = null) {
  const userId = String(from.id);
  let user = users.get(userId);

  if (!user) {
    const newUser = normalizeUserRecord(userId, {
      id: userId,
      firstName: from.first_name || "User",
      lastName: from.last_name || "",
      username: from.username ? (from.username.startsWith("@") ? from.username : `@${from.username}`) : "",
      points: 0,
      referrerId: referrerId && String(referrerId) !== userId ? String(referrerId) : null,
      referrals: 0,
      referralsCount: 0,
      isVerified: false,
      verified: false,
      joinedAt: new Date().toISOString(),
      joinedDate: new Date().toISOString(),
      joinedTimestamp: Date.now(),
      lastCheckin: 0,
      lastSpin: 0
    });
    users.set(userId, newUser);
    logActivity("user_registered", `User ${newUser.firstName} (ID: ${userId}) registered.`);
    saveUser(userId, newUser).catch(() => {});
    return newUser;
  }

  let modified = false;
  if (from.first_name && user.firstName !== from.first_name) {
    user.firstName = from.first_name;
    modified = true;
  }
  if (from.last_name && user.lastName !== from.last_name) {
    user.lastName = from.last_name;
    modified = true;
  }
  const uname = from.username ? (from.username.startsWith("@") ? from.username : `@${from.username}`) : "";
  if (uname && user.username !== uname) {
    user.username = uname;
    modified = true;
  }
  if (!user.joinedTimestamp) {
    user.joinedTimestamp = user.joinedAt ? new Date(user.joinedAt).getTime() : Date.now();
  }
  if (user.isVerified || user.verified) {
    user.isVerified = true;
    user.verified = true;
    verifiedUsers.add(userId);
  }
  if (modified) {
    updateUser(userId, {
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username
    }).catch(() => {});
  }
  return user;
}

/**
 * Calculates realtime Cash Referral & Payout stats for a user
 */
function getUserCashStats(userId) {
  const strId = String(userId);
  const user = users.get(strId);
  const totalRefers = user ? Number(user.referralsCount || user.referrals || 0) : 0;

  let pendingCash = 0;
  let paidCash = 0;
  let usedPendingRefers = 0;
  let usedPaidRefers = 0;
  let pendingRequest = null;

  for (const req of payoutRequests.values()) {
    if (String(req.userId) === strId) {
      if (req.status === "PENDING") {
        pendingCash += Number(req.amount || 0);
        usedPendingRefers += Number(req.refersCount || 0);
        if (!pendingRequest) pendingRequest = req;
      } else if (req.status === "PAID" || req.status === "Completed") {
        paidCash += Number(req.amount || 0);
        usedPaidRefers += Number(req.refersCount || 0);
      }
    }
  }

  // Available refers is total verified refers minus pending & paid refers
  const availableRefers = Math.max(0, totalRefers - usedPendingRefers - usedPaidRefers);
  // Rule: Minimum payout ₹10 (10 refers). If 50+ refers, calculate ₹100 flat bonus.
  const availableCash = availableRefers >= 50 ? 100 : availableRefers;

  return {
    totalRefers,
    availableRefers,
    availableCash,
    pendingCash,
    paidCash,
    usedPendingRefers,
    usedPaidRefers,
    hasPending: Boolean(pendingRequest),
    pendingRequest
  };
}

// ==========================================
// 3. VIBRANT COLORFUL KEYBOARDS & UI BUILDERS
// ==========================================

/**
 * Main User Reply Keyboard with Telegram's Native Color Styles:
 * - primary (Blue)
 * - success (Green)
 * - danger (Red)
 */
function getMainReplyKeyboard(userId) {
  const kb = new Keyboard();

  // ROW 1 (Green / Success - Prominent!): "👥 Refer & Earn (₹ Cash)"
  kb.text("👥 Refer & Earn (₹ Cash)").success().row();

  // ROW 2 (Blue / Primary): "🎰 Spin & Win" | "⏰ Roz ka Check-in"
  kb.text("🎰 Spin & Win").primary().text("⏰ Roz ka Check-in").primary().row();

  // ROW 3 (Green / Success): "💰 Earn Money (Invite)" | "🔥 Hot Offers"
  kb.text("💰 Earn Money (Invite)").success().text("🔥 Hot Offers").success().row();

  // ROW 4 (Blue / Primary): "💎 Point Balance" | "🏆 Leaderboard"
  kb.text("💎 Point Balance").primary().text("🏆 Leaderboard").primary().row();

  // ROW 5 (Green / Success): "🎯 Redeem Points" | "🎁 Secret Gift Code"
  kb.text("🎯 Redeem Points").success().text("🎁 Secret Gift Code").success().row();

  // ROW 6 (Blue / Primary): "📞 Customer Support"
  kb.text("📞 Customer Support").primary().row();

  // ROW 7 (Red / Danger): "⚙️ Admin Panel" (Admin Only)
  if (userId && isAdmin(userId)) {
    kb.text("⚙️ Admin Panel").danger().row();
  }

  // ROW 8 (Red / Danger): "❌ Close Menu"
  kb.text("❌ Close Menu").danger();

  return kb.resized();
}

/**
 * Dedicated Sub-Menu Keyboard for Cash Refer & Payout
 */
function getCashReferInlineKeyboard() {
  return new InlineKeyboard()
    .text("🔗 My Referral Link", "cash_ref_link")
    .text("📊 My Refers List", "cash_ref_list").row()
    .text("💸 Request Payout", "cash_ref_request")
    .text("📜 Payout History", "cash_ref_history").row()
    .text("🔙 Back to Main Menu", "cash_ref_back");
}

function getCashReferReplyKeyboard() {
  return new Keyboard()
    .text("🔗 My Referral Link").primary().text("📊 My Refers List").primary().row()
    .text("💸 Request Payout").success().text("📜 Payout History").success().row()
    .text("🔙 Back to Main Menu").danger()
    .resized();
}

/**
 * Full Admin Reply Keyboard with Native Color Styles:
 */
function getAdminReplyKeyboard() {
  return new Keyboard()
    .text("💳 Manage Payouts").success().text("👥 View Users List").primary().row()
    .text("➕ Add Force Channel").primary().text("📋 View/Remove Channels").primary().row()
    .text("🎟 Create Redeem Code").success().text("👤 Add Admin").success().row()
    .text("💳 Manage Points").success().text("🔘 Toggle Withdrawals").danger().row()
    .text("📊 Bot Stats").primary().text("📢 Broadcast Msg").primary().row()
    .text("🔙 Back to User Menu").danger()
    .resized();
}

function getForceJoinKeyboard() {
  const kb = new InlineKeyboard();
  if (dynamicChannels.length > 0) {
    dynamicChannels.forEach((ch) => {
      const validUrl = formatTelegramUrl(ch.link || ch.id);
      kb.url(`📢 Join ${ch.name}`, validUrl).row();
    });
  }
  kb.text("✅ Verify Membership 🔓", "verify_channels_action");
  return kb;
}

function getForceJoinMessage() {
  const channelsList = dynamicChannels
    .map((c, i) => `<b>${i + 1}.</b> <a href="${formatTelegramUrl(c.link || c.id)}">${escapeHtml(c.name)}</a>`)
    .join("\n");

  return (
    `🏏 ━━━━━━━━━━━━━━━━━━\n` +
    `✨ <b>WELCOME TO eIPL OFFICIAL BOT</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Kripya bot ke saare exclusive features, Spin & Win, daily rewards aur cash bonuses unlock karne ke liye <b>dono official channels</b> join karein:\n\n` +
    channelsList + `\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👇 <i>Dono channels join karne ke baad "Verify Membership" button dabayein:</i>`
  );
}

// ==========================================
// 4. TELEGRAM BOT ENGINE
// ==========================================
let bot = null;
let botStatus = {
  isPolling: false,
  username: null,
  error: null
};

if (BOT_TOKEN && BOT_TOKEN.length > 10 && !BOT_TOKEN.includes("MY_BOT_TOKEN")) {
  try {
    bot = new Bot(BOT_TOKEN);

    // Transformer: Sanitize all outgoing text and caption payloads to ensure valid UTF-8,
    // and gracefully handle 403 Forbidden errors when a user has blocked the bot
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (payload && typeof payload === "object") {
        for (const key of ["text", "caption"]) {
          if (typeof payload[key] === "string") {
            payload[key] = cleanUtf8(payload[key]);
          }
        }
      }
      try {
        return await prev(method, payload, signal);
      } catch (err) {
        const isBlocked =
          err?.error_code === 403 ||
          String(err?.message || err?.description || "").toLowerCase().includes("blocked by the user");
        if (isBlocked) {
          console.warn(`[Telegram API] Call to '${method}' skipped (403: Bot blocked by user). Chat ID: ${payload?.chat_id}`);
          return { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
        }
        throw err;
      }
    });

    // Global Error Handler so the bot never crashes the process
    bot.catch((err) => {
      const errObj = err.error || err;
      const isBlocked =
        errObj?.error_code === 403 ||
        String(errObj?.message || errObj?.description || "").toLowerCase().includes("blocked by the user");
      if (isBlocked) {
        console.warn(`[Telegram Bot] Update ${err.ctx?.update?.update_id}: User blocked the bot (403 Forbidden). Handled gracefully.`);
        return;
      }
      console.error(`[Telegram Bot Error] Error in update ${err.ctx?.update?.update_id}:`, err.error);
      botStatus.error = errObj?.message || "Telegram API error";
    });

    // Middleware: Force Channel Join Check with persistent Cache
    bot.use(async (ctx, next) => {
      const from = ctx.from;
      if (!from) return next();

      const userId = String(from.id);
      const text = ctx.message?.text || "";

      // 1. If already verified in memory cache, instantly allow without checking channels again
      if (verifiedUsers.has(userId)) {
        return next();
      }

      // 2. Allow /start, /admin, /cancel, or callback queries to proceed
      if (text.startsWith("/start") || text.startsWith("/admin") || text.startsWith("/cancel") || ctx.callbackQuery) {
        return next();
      }

      // 3. If user is in an active interactive prompt, allow through
      if (userStates.has(userId)) {
        return next();
      }

      const user = getOrCreateUser(from);
      if (user.isVerified) {
        verifiedUsers.add(userId);
        return next();
      }

      if (dynamicChannels.length > 0) {
        return ctx.reply(
          getForceJoinMessage(),
          { parse_mode: "HTML", reply_markup: getForceJoinKeyboard(), link_preview_options: { is_disabled: true } }
        );
      }

      return next();
    });

    // Command: /start
    bot.command("start", async (ctx) => {
      const from = ctx.from;
      const userId = String(from.id);
      const text = ctx.message.text || "";
      const parts = text.split(" ");
      const refId = parts.length > 1 && parts[1].trim() ? parts[1].trim() : null;

      const user = getOrCreateUser(from, refId);

      if (verifiedUsers.has(userId) || user.isVerified || dynamicChannels.length === 0) {
        user.isVerified = true;
        verifiedUsers.add(userId);
        return ctx.reply(
          `🏏 ━━━━━━━━━━━━━━━━━━\n` +
          `🏆 <b>eIPL OFFICIAL DASHBOARD</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Namaste <b>${escapeHtml(from.first_name)}</b>! Swagat hai eIPL Official Rewards Bot mein.\n\n` +
          `💎 <b>Available Balance:</b> <code>${user.points} Points</code>\n` +
          `👥 <b>Your Referrals:</b> <code>${user.referralsCount} Users</code>\n` +
          `🛡 <b>Account Status:</b> <code>Active & Verified ✅</code>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👇 <i>Neeche diye gaye vibrant menu se option chunein:</i>`,
          { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(from.id) }
        );
      }

      const refNote = user.referrerId
        ? `\n🎁 <b>Invite Link Detected!</b> Verify hone par aapke inviter ko <b>+2 Points</b> milenge.\n`
        : "";

      await ctx.reply(
        getForceJoinMessage() + (refNote ? `\n${refNote}` : ""),
        {
          parse_mode: "HTML",
          reply_markup: getForceJoinKeyboard(),
          link_preview_options: { is_disabled: true }
        }
      );
    });

    // Verification Action Handler
    async function handleVerifyChannels(ctx) {
      const from = ctx.from;
      if (!from) return;
      const userId = String(from.id);
      const user = getOrCreateUser(from);

      let allJoined = true;

      if (dynamicChannels.length > 0) {
        for (const ch of dynamicChannels) {
          let isMember = true;
          try {
            const member = await ctx.api.getChatMember(ch.id, from.id);
            const validStatuses = ["creator", "administrator", "member", "restricted"];
            isMember = validStatuses.includes(member.status);
          } catch (err) {
            const errMsg = String(err.description || err.message || "").toLowerCase();
            if (
              errMsg.includes("member list is inaccessible") ||
              errMsg.includes("chat not found") ||
              errMsg.includes("bot is not a member") ||
              errMsg.includes("not enough rights") ||
              errMsg.includes("forbidden")
            ) {
              isMember = true; // Graceful fallback
            } else if (
              errMsg.includes("not a member") ||
              errMsg.includes("user not found") ||
              errMsg.includes("left") ||
              errMsg.includes("kicked")
            ) {
              isMember = false;
            } else {
              isMember = true;
            }
          }

          if (!isMember) {
            allJoined = false;
            break;
          }
        }
      }

      if (!allJoined) {
        return ctx.answerCallbackQuery({
          text: "❌ Kripya dono official channels join karein verification ke liye!",
          show_alert: true
        });
      }

      const wasVerified = user.isVerified || user.verified;
      user.isVerified = true;
      user.verified = true;
      verifiedUsers.add(userId);
      updateUser(userId, { isVerified: true, verified: true }).catch(() => {});

      // Award +2 points to referrer on first verification
      if (!wasVerified && user.referrerId && users.has(user.referrerId)) {
        const referrer = users.get(user.referrerId);
        referrer.points = (referrer.points || 0) + 2;
        referrer.referralsCount = (referrer.referralsCount || 0) + 1;
        referrer.referrals = referrer.referralsCount;
        logActivity("referral_bonus", `+2 Points to ${referrer.firstName} for referring ${user.firstName}`);

        updateUserPoints(user.referrerId, 2).catch(() => {});
        updateUser(user.referrerId, {
          referrals: referrer.referralsCount,
          referralsCount: referrer.referralsCount
        }).catch(() => {});

        const refCashStats = getUserCashStats(user.referrerId);
        updateUserReferralCash(user.referrerId, {
          totalRefers: referrer.referralsCount,
          availableBalance: refCashStats.availableCash,
          totalWithdrawn: refCashStats.paidCash
        }).catch(() => {});

        try {
          await ctx.api.sendMessage(
            user.referrerId,
            `🎉 ━━━━━━━━━━━━━━━━━━\n` +
            `🎁 <b>Naya Cash & Points Referral Bonus!</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Aapke invite link se <b>${escapeHtml(user.firstName)}</b> ne bot join &amp; verify kar liya hai!\n\n` +
            `💎 <b>Reward:</b> <code>+2 Points</code> &amp; <b>+1 Cash Refer (₹1+)</b>\n` +
            `💰 <b>Kul Point Balance:</b> <b>${referrer.points} Points</b>\n` +
            `💵 <b>Available Cash For Payout:</b> <b>₹${refCashStats.availableCash}</b> (${refCashStats.availableRefers} Refers)\n` +
            `👥 <b>Total Referrals:</b> <b>${referrer.referralsCount}</b>\n` +
            `━━━━━━━━━━━━━━━━━━`,
            { parse_mode: "HTML" }
          );
        } catch (e) {}
      }

      await ctx.answerCallbackQuery({ text: "✅ Membership Verified Successfully!" });
      await ctx.reply(
        `🎉 ━━━━━━━━━━━━━━━━━━\n` +
        `✅ <b>CHANNELS VERIFIED SAFALTA POORVAK!</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Ab aapka <b>eIPL Official Dashboard</b> poori tarah unlock ho chuka hai.\n\n` +
        `💎 <b>Current Balance:</b> <code>${user.points} Points</code>\n` +
        `🎰 Roz Spin karein aur daily bonus claim karein!`,
        { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(from.id) }
      );
    }

    bot.callbackQuery("verify_channels_action", handleVerifyChannels);
    bot.callbackQuery("verify_membership", handleVerifyChannels);

    // ==========================================
    // 5. USER ACTIONS & GAMIFICATION HANDLERS
    // ==========================================

    // Feature 2: 🎰 Spin & Win (Lucky Wheel with 24-hour cooldown & Animation)
    async function handleSpinAndWin(ctx) {
      const user = getOrCreateUser(ctx.from);
      const now = Date.now();
      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const elapsed = now - (user.lastSpin || 0);

      if (elapsed < COOLDOWN_MS) {
        const remainMs = COOLDOWN_MS - elapsed;
        const hrs = Math.floor(remainMs / (1000 * 60 * 60));
        const mins = Math.floor((remainMs % (1000 * 60 * 60)) / (1000 * 60));

        const kb = new InlineKeyboard()
          .text("⏰ Roz ka Check-in", "open_checkin")
          .text("💰 Earn Money (Invite)", "open_invite");

        return ctx.reply(
          `🎰 ━━━━━━━━━━━━━━━━━━\n` +
          `⏳ <b>SPIN WHEEL COOLDOWN ACTIVE!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Aap aaj ka lucky spin pehle hi use kar chuke hain!\n\n` +
          `⏱ <b>Agla Spin Upaayein:</b> <code>${hrs}h ${mins}m</code> baad\n` +
          `💎 <b>Current Balance:</b> <b>${user.points} Points</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `💡 <i>Tip: Extra points paane ke liye doston ko invite karein (+2 pts each)!</i>`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      }

      // Initial animated spin state
      const spinMsg = await ctx.reply(
        `🎰 ━━━━━━━━━━━━━━━━━━\n` +
        `🎡 <b>SPINNING THE LUCKY WHEEL...</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🎲 <i>[ 7 | 💎 | 🍒 ] Spinning the reels...</i>`,
        { parse_mode: "HTML" }
      );

      // Random points between 1 and 10
      const wonPoints = Math.floor(Math.random() * 10) + 1;
      user.points = (user.points || 0) + wonPoints;
      user.lastSpin = now;
      logActivity("spin_win", `User ${user.firstName} (ID: ${user.id}) won ${wonPoints} points on Spin & Win.`);

      updateUserPoints(user.id, wonPoints).catch(() => {});
      updateUser(user.id, { lastSpin: now }).catch(() => {});

      // Brief animation suspense
      await new Promise((r) => setTimeout(r, 1100));

      const kb = new InlineKeyboard()
        .text("💎 View Balance", "refresh_balance")
        .text("🎯 Redeem Points", "open_redeem").row()
        .text("🏆 View Leaderboard", "open_leaderboard");

      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          spinMsg.message_id,
          `🎰 ━━━━━━━━━━━━━━━━━━\n` +
          `🎉 <b>LUCKY WHEEL RESULT!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🎡 <b>Winning Reel:</b> [ 💎 | 💎 | 💎 ]\n\n` +
          `💰 <b>Badhai Ho!</b> Aapne jeete <b>+${wonPoints} Points</b>!\n` +
          `💎 <b>Aapka Naya Balance:</b> <b>${user.points} Points</b>\n` +
          `⏳ <b>Next Spin:</b> <code>24 Ghante Baad</code>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🔥 <i>Kal dobara aakar apna lucky spin ghumayein!</i>`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      } catch (err) {
        await ctx.reply(
          `🎉 <b>Badhai Ho!</b> Aapne jeete <b>+${wonPoints} Points</b>!\n💎 Naya Balance: <b>${user.points} Points</b>`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      }
    }

    bot.hears([/🎰 Spin & Win/i, /Spin & Win/i, /^\/spin$/i], handleSpinAndWin);
    bot.callbackQuery("open_spin", handleSpinAndWin);

    // User: ⏰ Roz ka Check-in (24h cooldown)
    async function handleDailyCheckin(ctx) {
      const user = getOrCreateUser(ctx.from);
      const now = Date.now();
      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const elapsed = now - (user.lastCheckin || 0);

      if (elapsed < COOLDOWN_MS) {
        const remainMs = COOLDOWN_MS - elapsed;
        const hrs = Math.floor(remainMs / (1000 * 60 * 60));
        const mins = Math.floor((remainMs % (1000 * 60 * 60)) / (1000 * 60));

        const kb = new InlineKeyboard()
          .text("🎰 Spin & Win", "open_spin")
          .text("💰 Earn Money (Invite)", "open_invite");

        return ctx.reply(
          `⏰ ━━━━━━━━━━━━━━━━━━\n` +
          `⏳ <b>CHECK-IN COOLDOWN ACTIVE</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Aap aaj ka daily bonus pehle hi claim kar chuke hain!\n\n` +
          `⏱ <b>Agla Check-in Upaayein:</b> <code>${hrs}h ${mins}m</code> baad\n` +
          `💎 <b>Current Balance:</b> <b>${user.points} Points</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `💡 <i>Tip: Doston ko invite karein aur turant +2 Points paayein!</i>`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      }

      user.points = (user.points || 0) + 1;
      user.lastCheckin = now;
      logActivity("checkin", `User ${user.firstName} received +1 daily point.`);

      updateUserPoints(user.id, 1).catch(() => {});
      updateUser(user.id, { lastCheckin: now }).catch(() => {});

      const kb = new InlineKeyboard()
        .text("🎰 Spin & Win", "open_spin")
        .text("🎯 Redeem Points", "open_redeem");

      await ctx.reply(
        `⏰ ━━━━━━━━━━━━━━━━━━\n` +
        `✨ <b>ROZ KA DAILY CHECK-IN</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🎉 <b>Badhai Ho! Daily Bonus Safal!</b>\n\n` +
        `💎 <b>Reward Earned:</b> <code>+1 Daily Point</code>\n` +
        `💰 <b>Aapka Kul Balance:</b> <b>${user.points} Points</b>\n` +
        `⏳ <b>Next Check-in:</b> <code>24 Ghante Baad</code>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💡 <i>Kal dobara aakar apna rozana bonus claim karein!</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    }

    bot.hears([/Roz ka Check-in/i, /Check-in/i, /^\/daily$/i], handleDailyCheckin);
    bot.callbackQuery("open_checkin", handleDailyCheckin);

    // Feature 3: 🏆 Leaderboard (Top 10 users with points / referrals)
    async function sendLeaderboard(ctx) {
      const user = getOrCreateUser(ctx.from);
      const allUsers = Array.from(users.values());

      // Sort descending by points, secondary by referrals
      allUsers.sort((a, b) => (b.points || 0) - (a.points || 0) || (b.referralsCount || 0) - (a.referralsCount || 0));

      const top10 = allUsers.slice(0, 10);
      const userRank = allUsers.findIndex((u) => String(u.id) === String(user.id)) + 1;

      let text =
        `🏆 ━━━━━━━━━━━━━━━━━━\n` +
        `🌟 <b>eIPL HALL OF FAME / TOP 10</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n\n`;

      if (top10.length === 0) {
        text += `<i>Abhi koi users ranked nahi hain. Pehle rank par aaiye!</i>\n\n`;
      } else {
        top10.forEach((u, idx) => {
          let medal = "🔹";
          if (idx === 0) medal = "🥇";
          else if (idx === 1) medal = "🥈";
          else if (idx === 2) medal = "🥉";
          else medal = `<b>${idx + 1}.</b>`;

          const initial = getInitial(u.lastName);
          const displayName = escapeHtml(u.firstName) + (initial ? " " + escapeHtml(initial) + "." : "");
          text += `${medal} <b>${displayName}</b> — <b>${u.points || 0} Points</b> / <code>${u.referralsCount || 0} Refs</code>\n`;
        });
      }

      text +=
        `\n━━━━━━━━━━━━━━━━━━\n` +
        `📍 <b>Your Position:</b> #${userRank > 0 ? userRank : "Unranked"} | <b>Balance:</b> <b>${user.points} Points</b>\n` +
        `🔥 <i>Doston ko invite karein aur leaderboard par top rank paayein!</i>`;

      const kb = new InlineKeyboard()
        .text("💰 Earn Money (Invite)", "open_invite").row()
        .text("🎰 Spin & Win", "open_spin")
        .text("🔄 Refresh", "refresh_leaderboard");

      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
          return;
        } catch (e) {}
      }
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    bot.hears([/🏆 Leaderboard/i, /Leaderboard/i, /^\/leaderboard$/i], sendLeaderboard);
    bot.callbackQuery("open_leaderboard", sendLeaderboard);
    bot.callbackQuery("refresh_leaderboard", sendLeaderboard);

    // Feature 4: 🔥 Hot Referral Offers
    async function sendHotOffers(ctx) {
      const user = getOrCreateUser(ctx.from);
      const supportHandle = RAW_SUPPORT_LINK.includes("t.me/")
        ? RAW_SUPPORT_LINK.split("t.me/")[1].replace(/\//g, "")
        : RAW_SUPPORT_LINK.replace("@", "");

      const refCount = user.referralsCount || 0;
      let milestoneText = "";
      if (refCount < 10) {
        milestoneText = `🚀 <b>₹10 Cash Bonus</b> ke liye sirf <b>${10 - refCount} aur referrals</b> ki zaroorat hai!`;
      } else if (refCount < 50) {
        milestoneText = `🎉 <b>10 Referrals Milestone Poora!</b> ₹10 Bonus claim kar sakte hain.\n🚀 <b>₹100 Mega Bonus</b> ke liye sirf <b>${50 - refCount} aur referrals</b> baaki hain!`;
      } else {
        milestoneText = `🏆 <b>Badhai Ho!</b> Aap dono milestones (10 & 50 referrals) achieve kar chuke hain!`;
      }

      const kb = new InlineKeyboard()
        .text("💰 Invite Friends Now", "open_invite").row()
        .url("🏆 Claim Bonus via Support", SUPPORT_URL);

      await ctx.reply(
        `🔥 ━━━━━━━━━━━━━━━━━━\n` +
        `⚡ <b>HOT REFERRAL CASH OFFERS</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Apne referral milestones achieve karein aur paayein direct Cash Prizes:\n\n` +
        `🎁 <b>Milestone 1:</b> 10 Referrals ➔ <b>₹10 Cash Bonus</b>\n` +
        `👑 <b>Milestone 2:</b> 50 Referrals ➔ <b>₹100 Mega Cash Bonus</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>Aapke Current Referrals:</b> <code>${refCount} Users</code>\n` +
        `${milestoneText}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 <b>Note:</b> Yeh bonus claim karne ke liye hamare Customer Support (@${escapeHtml(supportHandle)}) se sampark karein aur apna User ID <code>${user.id}</code> share karein.`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    }

    bot.hears([/🔥 Hot Offers/i, /Hot Offers/i, /Hot Offer/i, /^\/offers$/i], sendHotOffers);
    bot.callbackQuery("open_offers", sendHotOffers);

    // User: 💰 Earn Money (Invite)
    async function sendInviteDetails(ctx) {
      const user = getOrCreateUser(ctx.from);
      const botName = botStatus.username || "eipl_bot";
      const link = `https://t.me/${botName}?start=${user.id}`;
      const shareMsg = `🏏 Join eIPL Official Bot now to get Daily Check-in Cash Rewards, Spin Wheel & Tournament Loots! Free Joining Bonus waiting:\n${link}`;

      const kb = new InlineKeyboard()
        .url("🚀 Share on Telegram", `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareMsg)}`).row()
        .text("🔥 View Hot Offers", "open_offers").row()
        .url("📞 Customer Support", SUPPORT_URL)
        .text("💎 Point Balance", "refresh_balance");

      const text =
        `💰 ━━━━━━━━━━━━━━━━━━\n` +
        `🚀 <b>EARN MONEY (REFERRAL SYSTEM)</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Apne doston ko invite karein aur har verified friend par <b>+2 Points (₹5+)</b> turant paayein!\n\n` +
        `👥 <b>Aapke Successful Referrals:</b> <code>${user.referralsCount} Users</code>\n` +
        `💎 <b>Referrals Se Total Kamai:</b> <code>${user.referralsCount * 2} Points</code>\n\n` +
        `🔗 <b>Aapka Exclusive Invite Link:</b>\n` +
        `<code>${link}</code>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Doston ke sath link share karne ke liye neeche button dabayein:</i>`;

      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery();
      }
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    bot.hears([/Earn Money/i, /Invite/i, /kamaayein/i, /^\/invite$/i, /^\/refer$/i], sendInviteDetails);
    bot.callbackQuery("open_invite", sendInviteDetails);

    // ==========================================
    // CASH REFER & PAYOUT DASHBOARD (USER)
    // ==========================================
    async function sendCashReferDashboard(ctx) {
      const user = getOrCreateUser(ctx.from);
      const stats = getUserCashStats(user.id);

      const text =
        `👥 ━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>CASH REFER & PAYOUT DASHBOARD</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Namaste <b>${escapeHtml(user.firstName)}</b>! Apne doston ko invite karke seedhe <b>Real Cash (₹)</b> kamaayein aur apne UPI / Bank account mein payout paayein!\n\n` +
        `📊 <b>Aapka Cash Overview:</b>\n` +
        `• 👥 <b>Total Verified Refers:</b> <code>${stats.totalRefers} Users</code>\n` +
        `• 💵 <b>Available For Payout:</b> <b>${stats.availableRefers} Refers (₹${stats.availableCash})</b>\n` +
        `• ⏳ <b>Pending Payout:</b> <code>₹${stats.pendingCash}</code>\n` +
        `• 💰 <b>Total Paid / Withdrawn:</b> <code>₹${stats.paidCash}</code>\n\n` +
        `📌 <b>Payout Rules & Bonuses:</b>\n` +
        `• <b>Minimum Payout:</b> ₹10 (10 refers required)\n` +
        `• <b>1 Refer:</b> ₹1 Cash\n` +
        `• <b>50+ Refers Mega Bonus:</b> Flat <b>₹100 Cash Bonus!</b> 🎁\n` +
        `• <b>Payment Methods:</b> UPI ID, PhonePe, Paytm, Google Pay\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Neeche diye gaye buttons se option chunein:</i>`;

      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch (_) {}
      }
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: getCashReferInlineKeyboard()
      });
    }

    bot.hears([/Refer & Earn/i, /Cash Refer/i, /^\/cashrefer$/i, /^\/payout$/i], sendCashReferDashboard);
    bot.callbackQuery("open_cash_refer_menu", sendCashReferDashboard);

    // 1. 🔗 [My Referral Link]
    async function sendMyReferralLink(ctx) {
      const user = getOrCreateUser(ctx.from);
      const stats = getUserCashStats(user.id);
      const botName = botStatus.username || "eipl_bot";
      const link = `https://t.me/${botName}?start=${user.id}`;
      const shareMsg = `🏏 Join eIPL Official Bot now & get Real Cash Rewards! Invite your friends and earn instant UPI Cash:\n${link}`;

      const kb = new InlineKeyboard()
        .url("🚀 Share on Telegram", `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareMsg)}`).row()
        .text("💸 Request Payout", "cash_ref_request")
        .text("📊 My Refers List", "cash_ref_list").row()
        .text("🔙 Refer Menu", "open_cash_refer_menu");

      const text =
        `🔗 ━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>MY REFERRAL LINK & STATS</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Apna exclusive invite link doston aur WhatsApp/Telegram groups mein share karein. Har verified join par cash reward paayein!\n\n` +
        `🔗 <b>Aapka Unique Referral Link:</b>\n` +
        `<code>${link}</code>\n\n` +
        `📊 <b>Real-time Stats:</b>\n` +
        `• 👥 <b>Total Refers:</b> <code>${stats.totalRefers} Users</code>\n` +
        `• ⏳ <b>Pending ₹:</b> <code>₹${stats.pendingCash}</code>\n` +
        `• 💰 <b>Earned & Paid ₹:</b> <code>₹${stats.paidCash}</code>\n` +
        `• 💵 <b>Available For Payout:</b> <code>${stats.availableRefers} Refers (₹${stats.availableCash})</code>\n\n` +
        `🎁 <b>Milestone Offer:</b> 50+ Refers complete karne par paayein flat <b>₹100 bonus</b>!\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Doston ke sath link share karne ke liye neeche button dabayein:</i>`;

      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch (_) {}
      }
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    bot.hears([/My Referral Link/i, /Referral Link/i, /^\/reflink$/i], sendMyReferralLink);
    bot.callbackQuery("cash_ref_link", sendMyReferralLink);

    // 2. 📊 [My Refers List]
    async function sendMyRefersList(ctx) {
      const user = getOrCreateUser(ctx.from);
      const userId = String(user.id);
      const botName = botStatus.username || "eipl_bot";
      const link = `https://t.me/${botName}?start=${user.id}`;

      // Filter all users referred by this user
      const referredUsers = [];
      for (const u of users.values()) {
        if (String(u.referrerId) === userId) {
          referredUsers.push(u);
        }
      }

      // Sort newest first
      referredUsers.sort((a, b) => (b.joinedTimestamp || 0) - (a.joinedTimestamp || 0));

      const kb = new InlineKeyboard()
        .text("🔗 Invite Friends", "cash_ref_link")
        .text("💸 Request Payout", "cash_ref_request").row()
        .text("🔙 Refer Menu", "open_cash_refer_menu");

      if (referredUsers.length === 0) {
        const text =
          `📊 ━━━━━━━━━━━━━━━━━━\n` +
          `👥 <b>MY REFERS LIST</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Abhi tak aapne kisi bhi user ko invite nahi kiya hai.\n\n` +
          `🔗 <b>Apna Link Share Karein:</b>\n` +
          `<code>${link}</code>\n\n` +
          `💡 <i>Doston ko invite karein aur har verified join par cash reward paayein!</i>`;

        if (ctx.callbackQuery) {
          try { await ctx.answerCallbackQuery(); } catch (_) {}
        }
        return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }

      const recent = referredUsers.slice(0, 10);
      let listItems = "";
      recent.forEach((u, i) => {
        const name = escapeHtml(`${u.firstName || ""} ${u.lastName || ""}`.trim() || u.username || "User");
        const uTag = u.username ? ` (${escapeHtml(u.username)})` : "";
        const dateStr = new Date(u.joinedTimestamp || u.joinedAt).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric"
        });
        const statusStr = (u.isVerified || u.verified) ? "✅ Verified" : "⚠️ Unverified";
        listItems += `<b>${i + 1}. ${name}</b>${uTag}\n   📅 Joined: <code>${dateStr}</code> | Status: ${statusStr}\n\n`;
      });

      const text =
        `📊 ━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>MY REFERRED USERS (Last ${recent.length} of ${referredUsers.length})</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Aapke invite link se join karne wale sadasya:\n\n` +
        listItems +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💡 <i>Sirf verified members par hi ₹ cash payout reward count hota hai.</i>`;

      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch (_) {}
      }
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    bot.hears([/My Refers List/i, /Refers List/i, /^\/myrefers$/i], sendMyRefersList);
    bot.callbackQuery("cash_ref_list", sendMyRefersList);

    // 3. 💸 [Request Payout]
    async function startPayoutRequest(ctx) {
      const user = getOrCreateUser(ctx.from);
      const stats = getUserCashStats(user.id);

      // Check rule: prevent multiple duplicate requests while one is still PENDING
      if (stats.hasPending && stats.pendingRequest) {
        const pr = stats.pendingRequest;
        const dateStr = new Date(pr.timestamp).toLocaleString("en-IN");
        const kb = new InlineKeyboard()
          .text("📜 Payout History", "cash_ref_history").row()
          .text("🔙 Refer Menu", "open_cash_refer_menu");

        const text =
          `⚠️ ━━━━━━━━━━━━━━━━━━\n` +
          `⏳ <b>PENDING PAYOUT REQUEST ACTIVE!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Aapki ek payout request pehle se <b>PENDING</b> hai:\n\n` +
          `📌 <b>Request ID:</b> <code>${pr.requestId}</code>\n` +
          `💵 <b>Amount:</b> <b>₹${pr.amount}</b> (${pr.refersCount} Refers)\n` +
          `📱 <b>Payment Method:</b> <code>${escapeHtml(pr.paymentDetails)}</code>\n` +
          `📅 <b>Submitted On:</b> <code>${dateStr}</code>\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⚠️ <i>Aap ek samay par sirf ek pending request rakh sakte hain. Yeh request complete hone ke baad hi aap doosri request bhej sakenge.</i>`;

        if (ctx.callbackQuery) {
          try { await ctx.answerCallbackQuery(); } catch (_) {}
        }
        return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }

      // Check rule: Minimum payout ₹10 (10 refers)
      if (stats.availableRefers < 10) {
        const needed = 10 - stats.availableRefers;
        const kb = new InlineKeyboard()
          .text("🔗 Get Referral Link", "cash_ref_link").row()
          .text("🔙 Refer Menu", "open_cash_refer_menu");

        const text =
          `⚠️ ━━━━━━━━━━━━━━━━━━\n` +
          `❌ <b>MINIMUM PAYOUT REQUIREMENT</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Cash payout request bhejne ke liye kam se kam <b>10 verified refers (₹10)</b> hone chahiye.\n\n` +
          `👥 <b>Aapke Available Refers:</b> <b>${stats.availableRefers} Refers</b>\n` +
          `⏳ <b>Zaroori Refers:</b> <b>${needed} aur refers chahiye</b>\n\n` +
          `💡 <b>Bonuses & Multipliers:</b>\n` +
          `• 10 Refers ➔ ₹10 Payout\n` +
          `• 25 Refers ➔ ₹25 Payout\n` +
          `• 50+ Refers ➔ <b>Flat ₹100 Mega Bonus!</b> 🎁\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👇 <i>Apna invite link share karke aur doston ko jodein:</i>`;

        if (ctx.callbackQuery) {
          try { await ctx.answerCallbackQuery(); } catch (_) {}
        }
        return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }

      // Calculate payout amount (flat ₹100 bonus for 50+ refers, else ₹1 per refer)
      const payoutAmount = stats.availableRefers >= 50 ? 100 : stats.availableRefers;

      userStates.set(String(user.id), {
        action: "awaiting_payout_payment_details",
        data: {
          availableRefers: stats.availableRefers,
          amount: payoutAmount
        }
      });

      const kb = new InlineKeyboard().text("❌ Cancel", "cancel_action");

      const bonusNote = stats.availableRefers >= 50
        ? `\n🎁 <b>50+ Refers Mega Offer: Flat ₹100 Bonus Activated!</b>\n`
        : "";

      const text =
        `💸 ━━━━━━━━━━━━━━━━━━\n` +
        `💳 <b>REQUEST CASH PAYOUT</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Aap <b>${stats.availableRefers} Refers</b> ke badle <b>₹${payoutAmount} Cash</b> withdraw kar rahe hain!${bonusNote}\n` +
        `Kripya apna Payment Method bhejein:\n` +
        `• <b>UPI ID:</b> <code>yourname@upi</code> ya <code>number@okaxis</code>\n` +
        `• <b>PhonePe / Paytm / Google Pay Number:</b> <code>9876543210</code>\n` +
        `• <b>Scanner / QR Code Link</b>\n\n` +
        `👇 <i>Neeche chat mein apna payment details likh kar bhejein:</i>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `❌ <i>Cancel karne ke liye /cancel type karein.</i>`;

      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch (_) {}
      }
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    bot.hears([/Request Payout/i, /Payout Request/i, /^\/requestpayout$/i], startPayoutRequest);
    bot.callbackQuery("cash_ref_request", startPayoutRequest);

    // 4. 📜 [Payout History]
    async function sendPayoutHistory(ctx) {
      const user = getOrCreateUser(ctx.from);
      const userId = String(user.id);

      const userRequests = [];
      for (const req of payoutRequests.values()) {
        if (String(req.userId) === userId) {
          userRequests.push(req);
        }
      }

      userRequests.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      const kb = new InlineKeyboard()
        .text("💸 Request Payout", "cash_ref_request").row()
        .text("🔙 Refer Menu", "open_cash_refer_menu");

      if (userRequests.length === 0) {
        const text =
          `📜 ━━━━━━━━━━━━━━━━━━\n` +
          `💳 <b>PAYOUT HISTORY</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Aapne abhi tak koi payout request nahi bheji hai.\n\n` +
          `10 verified refers hone par aap direct cash payout request bhej sakte hain!`;

        if (ctx.callbackQuery) {
          try { await ctx.answerCallbackQuery(); } catch (_) {}
        }
        return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }

      let historyText = "";
      userRequests.slice(0, 10).forEach((req, i) => {
        let statusBadge = "🟡 PENDING";
        if (req.status === "PAID" || req.status === "Completed") statusBadge = "✅ COMPLETED & PAID";
        else if (req.status === "REJECTED") statusBadge = `❌ REJECTED ${req.rejectionReason ? `(${escapeHtml(req.rejectionReason)})` : ""}`;

        const dateStr = new Date(req.timestamp).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });

        historyText +=
          `<b>${i + 1}. Request ID:</b> <code>${req.requestId}</code>\n` +
          `   💵 <b>Amount:</b> ₹${req.amount} (${req.refersCount || 10} Refers)\n` +
          `   📱 <b>Payment Method:</b> <code>${escapeHtml(req.paymentDetails || "N/A")}</code>\n` +
          `   🛡 <b>Status:</b> ${statusBadge}\n` +
          `   📅 <b>Date:</b> <code>${dateStr}</code>\n\n`;
      });

      const text =
        `📜 ━━━━━━━━━━━━━━━━━━\n` +
        `💳 <b>PAYOUT REQUESTS HISTORY (${userRequests.length})</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        historyText +
        `━━━━━━━━━━━━━━━━━━`;

      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch (_) {}
      }
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    bot.hears([/Payout History/i, /^\/payouthistory$/i], sendPayoutHistory);
    bot.callbackQuery("cash_ref_history", sendPayoutHistory);

    // 5. 🔙 [Back to Main Menu]
    bot.hears([/🔙 Back to Main Menu/i, /Back to Main Menu/i], async (ctx) => {
      await ctx.reply(
        `🏏 ━━━━━━━━━━━━━━━━━━\n` +
        `🏆 <b>MAIN USER DASHBOARD</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Main menu activate ho gaya hai:`,
        { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
      );
    });
    bot.callbackQuery("cash_ref_back", async (ctx) => {
      try { await ctx.answerCallbackQuery(); } catch (_) {}
      await ctx.reply(
        `🏏 ━━━━━━━━━━━━━━━━━━\n` +
        `🏆 <b>MAIN USER DASHBOARD</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Main menu activate ho gaya hai:`,
        { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
      );
    });

    // User: 💎 Point Balance
    async function sendUserBalance(ctx, isEdit = false) {
      const user = getOrCreateUser(ctx.from);
      const joinStr = new Date(user.joinedTimestamp || user.joinedAt).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric"
      });

      const text =
        `👤 ━━━━━━━━━━━━━━━━━━\n` +
        `💎 <b>USER DASHBOARD & PROFILE</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName || "")}\n` +
        `🆔 <b>User ID:</b> <code>${escapeHtml(user.id)}</code>\n` +
        `💎 <b>Point Balance:</b> <b>${user.points} Points</b>\n` +
        `👥 <b>Total Referrals:</b> <b>${user.referralsCount} Users</b> (+2 pts each)\n` +
        `📅 <b>Registered On:</b> <code>${joinStr}</code>\n` +
        `🛡 <b>Account Status:</b> ${user.isVerified ? "✅ Verified Member" : "⚠️ Unverified"}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 <b>Reward Conversion Rates:</b>\n` +
        `• <b>3 Points</b>  ➔ ₹5.27 UPI\n` +
        `• <b>7 Points</b>  ➔ ₹15.27 UPI\n` +
        `• <b>10 Points</b> ➔ ₹25.27 UPI\n` +
        `• <b>20 Points</b> ➔ ₹45.27 UPI\n` +
        `• <b>30 Points</b> ➔ ₹65.27 UPI\n` +
        `━━━━━━━━━━━━━━━━━━`;

      const kb = new InlineKeyboard()
        .text("💰 Earn Money", "open_invite")
        .text("🎯 Redeem Points", "open_redeem").row()
        .text("🎰 Spin & Win", "open_spin")
        .text("🔄 Refresh", "refresh_balance");

      if (isEdit && ctx.callbackQuery) {
        try {
          await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
        } catch (e) {}
      } else {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }
    }

    bot.hears([/Point Balance/i, /Balance/i, /^\/balance$/i, /^\/profile$/i], (ctx) => sendUserBalance(ctx, false));
    bot.callbackQuery("refresh_balance", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "🔄 Balance Refreshed!" });
      return sendUserBalance(ctx, true);
    });

    // Feature 5: 🎯 Redeem Points (Controlled by Dynamic Withdrawal Toggle)
    async function sendRedeemDetails(ctx) {
      const user = getOrCreateUser(ctx.from);

      // Check if Admin has paused withdrawals
      if (!withdrawalsEnabled) {
        const kb = new InlineKeyboard().url("📞 Customer Support Desk", SUPPORT_URL);
        const text =
          `⚠️ ━━━━━━━━━━━━━━━━━━\n` +
          `🔒 <b>REDEMPTION CURRENTLY PAUSED</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Abhi withdrawals admin dwara maintenance ke liye paused hain. Kripya thodi der baad koshish karein ya kisi zaroori jaankari ke liye Customer Support se contact karein.\n\n` +
          `💎 <b>Current Balance:</b> <b>${user.points} Points</b>`;
        if (ctx.callbackQuery) await ctx.answerCallbackQuery();
        return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }

      const joinTime = user.joinedTimestamp || new Date(user.joinedAt).getTime() || Date.now();
      const LOCK_MS = 10 * 24 * 60 * 60 * 1000; // 10 days
      const elapsed = Date.now() - joinTime;

      if (elapsed < LOCK_MS) {
        const remainingMs = LOCK_MS - elapsed;
        const remainingDays = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));

        const kb = new InlineKeyboard()
          .url("📞 Customer Support Desk", SUPPORT_URL).row()
          .text("💰 Earn More Points", "open_invite");

        const text =
          `🎯 ━━━━━━━━━━━━━━━━━━\n` +
          `💳 <b>REDEEM POINTS & CASH LOOT</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⏳ <b>Redemption Review Period Active!</b>\n` +
          `Aapka account security review period mein hai. Rewards unlock hone mein <b>${remainingDays} din bache hain</b> (10-Day Policy).\n\n` +
          `💎 <b>Current Balance:</b> <b>${user.points} Points</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📊 <b>eIPL Official Payout Tiers:</b>\n` +
          `🥉 <b>3 Daily Points</b>  ➔ <b>₹5.27 UPI</b>\n` +
          `🥈 <b>7 Daily Points</b>  ➔ <b>₹15.27 UPI</b>\n` +
          `🥇 <b>10 Daily Points</b> ➔ <b>₹25.27 UPI</b>\n` +
          `💎 <b>20 Daily Points</b> ➔ <b>₹45.27 UPI</b>\n` +
          `👑 <b>30 Daily Points</b> ➔ <b>₹65.27 UPI</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🔒 <i>Review period poora hote hi aapka direct UPI transfer unlock ho jayega!</i>`;

        if (ctx.callbackQuery) await ctx.answerCallbackQuery();
        return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }

      const kb = new InlineKeyboard().url("💬 Claim Reward via Support", SUPPORT_URL);
      const text =
        `🎯 ━━━━━━━━━━━━━━━━━━\n` +
        `🎉 <b>REDEMPTION UNLOCKED!</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Aapka 10-day review period safaltapoorvak poora ho chuka hai!\n\n` +
        `💎 <b>Aapka Available Balance:</b> <b>${user.points} Points</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 <b>Selectable Payout Tiers:</b>\n` +
        `🥉 <b>3 Daily Points</b>  ➔ <b>₹5.27 UPI</b>\n` +
        `🥈 <b>7 Daily Points</b>  ➔ <b>₹15.27 UPI</b>\n` +
        `🥇 <b>10 Daily Points</b> ➔ <b>₹25.27 UPI</b>\n` +
        `💎 <b>20 Daily Points</b> ➔ <b>₹45.27 UPI</b>\n` +
        `👑 <b>30 Daily Points</b> ➔ <b>₹65.27 UPI</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💬 <i>Apna UPI ID dekar reward transfer karwane ke liye support se contact karein:</i>`;

      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    bot.hears([/Redeem Points/i, /Redeem Point/i, /^\/redeem$/i], sendRedeemDetails);
    bot.callbackQuery("open_redeem", sendRedeemDetails);

    // ==========================================
    // GIFT CODE / PROMO CODE REDEMPTION LOGIC
    // ==========================================
    async function processRedeemCode(ctx, rawCode, user) {
      const userId = String(user.id);
      const codeInput = String(rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");

      if (!codeInput) {
        return ctx.reply("❌ Kripya valid Gift ya Promo Code bhejein.", {
          parse_mode: "HTML",
          reply_markup: getMainReplyKeyboard(ctx.from?.id)
        });
      }

      const codeObj = redeemCodes.get(codeInput);
      if (!codeObj || codeObj.active === false) {
        return ctx.reply(
          `❌ <b>Galat ya Expired Code!</b>\n` +
          `Code <code>${escapeHtml(codeInput)}</code> exist nahi karta ya expire ho chuka hai.\n\n` +
          `👉 Kripya valid code check karke dobara type karein ya official channels join karein.`,
          {
            parse_mode: "HTML",
            reply_markup: getMainReplyKeyboard(ctx.from?.id)
          }
        );
      }

      // Check if user has already redeemed this specific code
      const alreadyClaimed =
        codeObj.usedBy.has(userId) ||
        Boolean(user.redeemedCodes && user.redeemedCodes[codeInput]);

      if (alreadyClaimed) {
        return ctx.reply(
          `⚠️ <b>Already Redeemed!</b>\n` +
          `Aap pehle hi code <code>${escapeHtml(codeInput)}</code> redeem kar chuke hain.\n` +
          `📌 <i>Ek Telegram user ek gift code ko sirf ek hi baar claim kar sakta hai.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: getMainReplyKeyboard(ctx.from?.id)
          }
        );
      }

      // Check if maximum global limit reached
      if (codeObj.maxUses && codeObj.usedBy.size >= codeObj.maxUses) {
        return ctx.reply(
          `⚠️ <b>Limit Full!</b>\n` +
          `Is gift code <code>${escapeHtml(codeInput)}</code> ki maximum usage limit (<code>${codeObj.maxUses}</code> users) poori ho chuki hai.\n` +
          `📢 Naye promo drops ke liye hamare channels par active rahein!`,
          {
            parse_mode: "HTML",
            reply_markup: getMainReplyKeyboard(ctx.from?.id)
          }
        );
      }

      // Success! Grant Points and mark redeemed
      codeObj.usedBy.add(userId);
      user.points = (user.points || 0) + codeObj.points;
      if (!user.redeemedCodes) user.redeemedCodes = {};
      user.redeemedCodes[codeInput] = Date.now();

      logActivity("code_redeemed", `User ${user.firstName} (ID: ${userId}) redeemed ${codeInput} for +${codeObj.points} pts.`);

      // Persist to Firebase Realtime Database
      updateUserPoints(user.id, codeObj.points).catch(() => {});
      recordPromoCodeRedemption(codeInput, userId).catch(() => {});
      updateUser(user.id, {
        points: user.points,
        redeemedCodes: user.redeemedCodes
      }).catch(() => {});

      const kb = new InlineKeyboard()
        .text("🎰 Spin & Win", "open_spin")
        .text("💎 Point Balance", "refresh_balance").row()
        .text("🏆 Leaderboard", "open_leaderboard");

      return ctx.reply(
        `🎉 ━━━━━━━━━━━━━━━━━━\n` +
        `🎁 <b>GIFT CODE REDEEMED SUCCESSFULLY!</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Kamaal kar diya <b>${escapeHtml(user.firstName)}</b>! Aapka Secret Gift Code safalta-poorvak redeem ho chuka hai!\n\n` +
        `🎟 <b>Redeemed Code:</b> <code>${escapeHtml(codeInput)}</code>\n` +
        `💎 <b>Points Credited:</b> <b>+${codeObj.points} Points</b>\n` +
        `💰 <b>Aapka Naya Balance:</b> <b>${user.points} Points</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🚀 <i>Aur points earn karne ke liye <b>🎰 Spin & Win</b> karein ya apne doston ko invite karein!</i>`,
        {
          parse_mode: "HTML",
          reply_markup: kb
        }
      );
    }

    async function handleGiftCodePrompt(ctx) {
      const from = ctx.from;
      if (!from) return;
      const user = getOrCreateUser(from);

      // Check if command has code passed directly: e.g. /gift EIPLBONUS or /redeem LUCKY7
      const text = (ctx.message?.text || "").trim();
      const match = text.match(/^\/(?:gift|giftcode|redeem|code|promo|promocode)\s+([A-Za-z0-9_]+)$/i);
      if (match) {
        return processRedeemCode(ctx, match[1], user);
      }

      userStates.set(String(from.id), { action: "awaiting_redeem_code" });

      const kb = new InlineKeyboard()
        .url("📢 Official Channels", formatTelegramUrl(dynamicChannels[0]?.link || SUPPORT_URL)).row()
        .text("❌ Cancel", "cancel_action");

      await ctx.reply(
        `🎁 ━━━━━━━━━━━━━━━━━━\n` +
        `✨ <b>SECRET VIP GIFT CODE REDEMPTION</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Namaste <b>${escapeHtml(user.firstName)}</b>! Yahan apna <b>Secret Gift Code</b> ya <b>Promo Code</b> submit karein aur turant balance mein bonus points claim karein!\n\n` +
        `💎 <b>VIP Active Codes:</b>\n` +
        `• <code>EIPLBONUS</code> — +9 Points (VIP Bonus)\n` +
        `• <code>LUCKY7</code> — +7 Points (Lucky Gift)\n` +
        `• <code>WELCOME5</code> — +5 Points (Welcome Starter)\n` +
        `• <code>SPINWIN3</code> — +3 Points (Spin Booster)\n` +
        `• <code>SUPER10</code> — +10 Points (Mega Drop)\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Apna code abhi chat mein type karke bhejein:</i>\n` +
        `❌ <i>Cancel karne ke liye /cancel type karein.</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    }

    // User: 🎁 Secret Gift Code & 🎫 Redeem Code Triggers
    bot.hears([/Secret Gift/i, /Gift Code/i, /🎁/i, /Redeem Code/i, /Promo Code/i], handleGiftCodePrompt);
    bot.command(["gift", "giftcode", "code", "promo", "promocode", "claim"], handleGiftCodePrompt);
    bot.callbackQuery("open_secret_gift", async (ctx) => {
      await ctx.answerCallbackQuery();
      return handleGiftCodePrompt(ctx);
    });
    bot.callbackQuery("cancel_action", async (ctx) => {
      userStates.delete(String(ctx.from.id));
      await ctx.answerCallbackQuery({ text: "Action Cancelled" });
      await ctx.reply("❌ Action cancel kar diya gaya hai.", {
        reply_markup: getMainReplyKeyboard(ctx.from.id)
      });
    });

    // User: 📞 Customer Support
    bot.hears([/Customer Support/i, /Support/i, /^\/support$/i], async (ctx) => {
      const kb = new InlineKeyboard()
        .url("💬 Open Support Chat", SUPPORT_URL).row()
        .text("💎 Check Balance", "refresh_balance");

      await ctx.reply(
        `📞 ━━━━━━━━━━━━━━━━━━\n` +
        `💬 <b>CUSTOMER SUPPORT DESK</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Aapko point redemption, referral status ya kisi bhi samasya ke liye sahayata chahiye?\n\n` +
        `🛡 <b>Official Desk:</b> 24x7 Priority Support\n` +
        `🔗 <b>Direct Link:</b> <a href="${SUPPORT_URL}">${escapeHtml(RAW_SUPPORT_LINK)}</a>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Neeche diye button par click karke direct support chat open karein:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // User: ❌ Close Menu
    bot.hears([/❌ Close Menu/i, /Close Menu/i], async (ctx) => {
      const kb = new InlineKeyboard().text("📱 Open Main Menu", "reopen_menu");
      await ctx.reply(
        `🚪 <b>Menu Closed</b>\n━━━━━━━━━━━━━━━━━━\nReply keyboard minimize kar diya gaya hai. Dobara kholne ke liye /start type karein ya neeche button dabayein:`,
        {
          parse_mode: "HTML",
          reply_markup: {
            remove_keyboard: true
          }
        }
      );
      await ctx.reply(`👉 <i>Tap to restore keyboard:</i>`, {
        parse_mode: "HTML",
        reply_markup: kb
      });
    });

    bot.callbackQuery("reopen_menu", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Opening menu..." });
      await ctx.reply(
        `🏏 <b>Menu Reopened!</b>\nNeeche diye gaye buttons se vikalp chunein:`,
        {
          parse_mode: "HTML",
          reply_markup: getMainReplyKeyboard(ctx.from.id)
        }
      );
    });

    // ==========================================
    // 6. ADMIN PANEL CONTROLS & UPGRADES
    // ==========================================

    // Admin Panel Trigger -> Switches to Admin Keyboard
    bot.hears([/⚙️ Admin Panel/i, /Admin Panel/i, /^\/admin$/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) {
        return ctx.reply("⛔ <b>Access Denied:</b> Admin permissions required.", { parse_mode: "HTML" });
      }

      await ctx.reply(
        `⚙️ ━━━━━━━━━━━━━━━━━━\n` +
        `🛡 <b>ADMIN CONTROL CENTER</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Admin:</b> ${escapeHtml(ctx.from.first_name)} (<code>${ctx.from.id}</code>)\n` +
        `👥 <b>Total Users:</b> <code>${users.size}</code>\n` +
        `💳 <b>Payout Requests:</b> <code>${Array.from(payoutRequests.values()).filter(r => r.status === "PENDING").length} Pending / ${payoutRequests.size} Total</code>\n` +
        `📢 <b>Active Channels:</b> <code>${dynamicChannels.length}</code>\n` +
        `🎟 <b>Promo Codes:</b> <code>${redeemCodes.size}</code>\n` +
        `💸 <b>Withdrawals:</b> <b>${withdrawalsEnabled ? "🟢 ENABLED" : "🔴 PAUSED"}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Neeche diye gaye admin keyboard se action chunein:</i>`,
        { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
      );
    });

    // ==========================================
    // ADMIN: 💳 MANAGE PAYOUTS & CONTROLS
    // ==========================================
    async function sendAdminPayoutDashboard(ctx) {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      const allReqs = Array.from(payoutRequests.values());
      const pendingReqs = allReqs.filter((r) => r.status === "PENDING");
      const paidReqs = allReqs.filter((r) => r.status === "PAID" || r.status === "Completed");
      const rejectedReqs = allReqs.filter((r) => r.status === "REJECTED");
      const totalPaidAmount = paidReqs.reduce((acc, r) => acc + Number(r.amount || 0), 0);

      const kb = new InlineKeyboard()
        .text(`📋 View Pending Payouts (${pendingReqs.length})`, "admin_view_pending_payouts").row()
        .text("📜 All Payouts History", "admin_view_all_payouts")
        .text("📥 Export Payouts CSV", "admin_export_payouts_csv").row()
        .text("🔙 Back to Admin Menu", "admin_back_to_menu");

      const text =
        `💳 ━━━━━━━━━━━━━━━━━━\n` +
        `🛡 <b>PAYOUT REQUESTS MANAGEMENT</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Cash payout requests ko review aur approve/reject karein:\n\n` +
        `📋 <b>Pending Requests:</b> <code>${pendingReqs.length}</code>\n` +
        `✅ <b>Completed & Paid:</b> <code>${paidReqs.length}</code>\n` +
        `❌ <b>Rejected:</b> <code>${rejectedReqs.length}</code>\n` +
        `💰 <b>Total Paid Out:</b> <b>₹${totalPaidAmount}</b>\n` +
        `👥 <b>Total Requests:</b> <code>${allReqs.length}</code>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Option chunein:</i>`;

      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch (_) {}
      }
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    bot.hears([/💳 Manage Payouts/i, /Manage Payouts/i, /^\/payouts$/i], sendAdminPayoutDashboard);
    bot.callbackQuery("admin_manage_payouts", sendAdminPayoutDashboard);
    bot.callbackQuery("admin_back_to_menu", async (ctx) => {
      if (!isAdmin(ctx.from.id)) return;
      try { await ctx.answerCallbackQuery(); } catch (_) {}
      await ctx.reply("⚙️ Admin Control Center:", { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
    });

    // View Pending Payouts
    async function viewPendingPayouts(ctx) {
      if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Access Denied", show_alert: true });

      const pendingReqs = Array.from(payoutRequests.values())
        .filter((r) => r.status === "PENDING")
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      if (pendingReqs.length === 0) {
        if (ctx.callbackQuery) {
          try { await ctx.answerCallbackQuery({ text: "Koi pending payout request nahi hai!", show_alert: true }); } catch (_) {}
        }
        return ctx.reply(
          `✅ ━━━━━━━━━━━━━━━━━━\n` +
          `📋 <b>NO PENDING PAYOUTS</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Sabhi payout requests process ho chuki hain. Koi nayi pending request nahi hai!`,
          { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
        );
      }

      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch (_) {}
      }

      await ctx.reply(
        `📋 ━━━━━━━━━━━━━━━━━━\n` +
        `⏳ <b>PENDING PAYOUT REQUESTS (${pendingReqs.length})</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Neeche diye gaye requests par action lein:`,
        { parse_mode: "HTML" }
      );

      for (const req of pendingReqs.slice(0, 10)) {
        const u = users.get(String(req.userId));
        const totalRefers = u ? (u.referralsCount || u.referrals || 0) : req.refersCount;
        const dateStr = new Date(req.timestamp).toLocaleString("en-IN");
        const bonusTag = Number(req.refersCount) >= 50 ? " (Flat ₹100 Bonus! 🎁)" : "";

        const reqText =
          `💳 <b>Request ID:</b> <code>${req.requestId}</code>\n` +
          `👤 <b>User Name:</b> ${escapeHtml(req.userName)}\n` +
          `🆔 <b>Telegram ID:</b> <code>${req.userId}</code>\n` +
          `👥 <b>Total Refers:</b> ${totalRefers} (Claimed: ${req.refersCount})\n` +
          `💵 <b>Amount:</b> <b>₹${req.amount}</b>${bonusTag}\n` +
          `📱 <b>Payment Details:</b> <code>${escapeHtml(req.paymentDetails)}</code>\n` +
          `📅 <b>Requested Date:</b> <code>${dateStr}</code>`;

        const actionKb = new InlineKeyboard()
          .text("✅ Approve & Paid", `payout_appr_${req.requestId}`)
          .text("❌ Reject & Refund", `payout_rej_${req.requestId}`);

        await ctx.reply(reqText, { parse_mode: "HTML", reply_markup: actionKb });
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    bot.callbackQuery("admin_view_pending_payouts", viewPendingPayouts);

    // View All Payouts History
    bot.callbackQuery("admin_view_all_payouts", async (ctx) => {
      if (!isAdmin(ctx.from.id)) return;
      try { await ctx.answerCallbackQuery(); } catch (_) {}

      const allReqs = Array.from(payoutRequests.values())
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      if (allReqs.length === 0) {
        return ctx.reply("Abhi koi payout record nahi hai.", { parse_mode: "HTML" });
      }

      let historyText = "";
      allReqs.slice(0, 10).forEach((r, i) => {
        let badge = "🟡 PENDING";
        if (r.status === "PAID" || r.status === "Completed") badge = "✅ PAID";
        else if (r.status === "REJECTED") badge = "❌ REJECTED";
        historyText += `${i + 1}. <code>${r.requestId}</code> | <b>${escapeHtml(r.userName)}</b> | ₹${r.amount} | ${badge}\n   UPI: <code>${escapeHtml(r.paymentDetails)}</code>\n`;
      });

      const kb = new InlineKeyboard()
        .text("📥 Export Payouts CSV", "admin_export_payouts_csv").row()
        .text("🔙 Manage Payouts", "admin_manage_payouts");

      await ctx.reply(
        `📜 ━━━━━━━━━━━━━━━━━━\n` +
        `💳 <b>ALL PAYOUT REQUESTS (${allReqs.length})</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        historyText +
        `━━━━━━━━━━━━━━━━━━`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // Approve & Paid Handler
    bot.callbackQuery(/^payout_appr_(.+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Access Denied", show_alert: true });
      const reqId = ctx.match[1];
      const req = payoutRequests.get(reqId);

      if (!req) {
        return ctx.answerCallbackQuery({ text: "Request nahi mili!", show_alert: true });
      }
      if (req.status === "PAID" || req.status === "Completed") {
        return ctx.answerCallbackQuery({ text: "Yeh request pehle hi Paid ho chuki hai!", show_alert: true });
      }

      const updates = {
        status: "PAID",
        statusDisplay: "Completed",
        processedAt: Date.now(),
        processedBy: String(ctx.from.id)
      };

      await updatePayoutRequest(reqId, updates);
      Object.assign(req, updates);

      // Update user referral_cash
      const cashStats = getUserCashStats(req.userId);
      await updateUserReferralCash(req.userId, {
        totalRefers: cashStats.totalRefers,
        availableBalance: cashStats.availableCash,
        totalWithdrawn: cashStats.paidCash
      });

      logActivity("payout_approved", `Payout ${reqId} (₹${req.amount}) approved by admin ${ctx.from.id} for user ${req.userId}`);
      await ctx.answerCallbackQuery({ text: `✅ Payout ${reqId} Approved!`, show_alert: true });

      // Direct DM to User as requested:
      // "🎉 Aapka ₹{Amount} ka payout successfully bhej diya gaya hai! Transaction proof dekhne ke liye support se sampark karein."
      try {
        await ctx.api.sendMessage(
          req.userId,
          `🎉 ━━━━━━━━━━━━━━━━━━\n` +
          `💰 <b>PAYOUT SUCCESSFULLY TRANSFERRED!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🎉 Aapka <b>₹${req.amount}</b> ka payout successfully bhej diya gaya hai!\n\n` +
          `📌 <b>Request ID:</b> <code>${req.requestId}</code>\n` +
          `💵 <b>Amount Paid:</b> <code>₹${req.amount}</code>\n` +
          `📱 <b>Payment Method:</b> <code>${escapeHtml(req.paymentDetails)}</code>\n` +
          `📅 <b>Date:</b> <code>${new Date().toLocaleString("en-IN")}</code>\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Transaction proof dekhne ke liye support se sampark karein: ${SUPPORT_URL}`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        console.warn(`[Payout Approval] Could not send direct message to user ${req.userId}:`, err.message);
      }

      try {
        await ctx.editMessageText(
          `✅ <b>PAYOUT APPROVED & COMPLETED!</b>\n\n` +
          `📌 <b>Request ID:</b> <code>${req.requestId}</code>\n` +
          `👤 <b>User:</b> ${escapeHtml(req.userName)} (<code>${req.userId}</code>)\n` +
          `💵 <b>Amount:</b> <b>₹${req.amount}</b>\n` +
          `📱 <b>Payment Details:</b> <code>${escapeHtml(req.paymentDetails)}</code>\n` +
          `🛡 <b>Status:</b> 🟢 PAID (User DM sent)`,
          { parse_mode: "HTML" }
        );
      } catch (_) {}
    });

    // Reject & Refund Refers Handler
    bot.callbackQuery(/^payout_rej_(.+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Access Denied", show_alert: true });
      const reqId = ctx.match[1];
      const req = payoutRequests.get(reqId);

      if (!req) {
        return ctx.answerCallbackQuery({ text: "Request nahi mili!", show_alert: true });
      }
      if (req.status !== "PENDING") {
        return ctx.answerCallbackQuery({ text: `Request already ${req.status}!`, show_alert: true });
      }

      await ctx.answerCallbackQuery();

      const reasonKb = new InlineKeyboard()
        .text("⚠️ Fake / Inactive Referrals", `payout_rejwhy_${reqId}_fake`).row()
        .text("❌ Invalid UPI / Account", `payout_rejwhy_${reqId}_invalidupi`).row()
        .text("🚫 Channels Left Before Verification", `payout_rejwhy_${reqId}_leftchannel`).row()
        .text("✍️ Custom Rejection Reason", `payout_rejwhy_${reqId}_custom`).row()
        .text("🔙 Cancel", "admin_view_pending_payouts");

      await ctx.reply(
        `❌ ━━━━━━━━━━━━━━━━━━\n` +
        `⚠️ <b>REJECT PAYOUT REQUEST (${reqId})</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `User: <b>${escapeHtml(req.userName)}</b> (<code>${req.userId}</code>)\n` +
        `Amount: <b>₹${req.amount}</b> (${req.refersCount} Refers)\n\n` +
        `Kripya rejection ka karan chunein (refers user ko refund ho jayenge):`,
        { parse_mode: "HTML", reply_markup: reasonKb }
      );
    });

    // Quick Rejection Reason Handlers
    bot.callbackQuery(/^payout_rejwhy_(.+)_([a-z]+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Access Denied", show_alert: true });
      const reqId = ctx.match[1];
      const reasonCode = ctx.match[2];
      const req = payoutRequests.get(reqId);

      if (!req || req.status !== "PENDING") {
        return ctx.answerCallbackQuery({ text: "Request already processed or not found.", show_alert: true });
      }

      if (reasonCode === "custom") {
        userStates.set(String(ctx.from.id), {
          action: "awaiting_payout_reject_custom_reason",
          data: { reqId }
        });
        await ctx.answerCallbackQuery();
        return ctx.reply(
          `✍️ <b>Custom Rejection Reason Bhejein:</b>\n\n` +
          `Request ID: <code>${reqId}</code>\n` +
          `User: ${escapeHtml(req.userName)}\n\n` +
          `Kripya karan likhein jo user ko DM mein bhejna hai:`,
          { parse_mode: "HTML" }
        );
      }

      let reasonText = "Referral verification criteria not satisfied.";
      if (reasonCode === "fake") reasonText = "Fake, inactive, or bot referral accounts detected.";
      else if (reasonCode === "invalidupi") reasonText = "Invalid UPI ID or unreachable account details.";
      else if (reasonCode === "leftchannel") reasonText = "Referred members left mandatory channels.";

      await executePayoutRejection(ctx, req, reasonText);
    });

    async function executePayoutRejection(ctx, req, reasonText) {
      const updates = {
        status: "REJECTED",
        rejectionReason: reasonText,
        processedAt: Date.now(),
        processedBy: String(ctx.from.id)
      };

      await updatePayoutRequest(req.requestId, updates);
      Object.assign(req, updates);

      // Refund refers back to user referral_cash
      const cashStats = getUserCashStats(req.userId);
      await updateUserReferralCash(req.userId, {
        totalRefers: cashStats.totalRefers,
        availableBalance: cashStats.availableCash,
        totalWithdrawn: cashStats.paidCash
      });

      logActivity("payout_rejected", `Payout ${req.requestId} rejected by admin ${ctx.from.id}: ${reasonText}`);
      if (ctx.answerCallbackQuery) {
        try { await ctx.answerCallbackQuery({ text: "Request Rejected & Refers Refunded!", show_alert: true }); } catch (_) {}
      }

      // Alert user via DM
      try {
        await ctx.api.sendMessage(
          req.userId,
          `❌ ━━━━━━━━━━━━━━━━━━\n` +
          `⚠️ <b>PAYOUT REQUEST REJECTED</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Aapka Payout Request reject kar diya gaya hai:\n\n` +
          `📌 <b>Request ID:</b> <code>${req.requestId}</code>\n` +
          `💵 <b>Amount:</b> ₹${req.amount}\n` +
          `⚠️ <b>Karan (Reason):</b> <b>${escapeHtml(reasonText)}</b>\n\n` +
          `🔄 <b>Refers Refunded:</b> Aapke <b>${req.refersCount} refers</b> wapas aapke available balance mein refund kar diye gaye hain!\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Kisi bhi sahayata ke liye support team se sampark karein: ${SUPPORT_URL}`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        console.warn(`[Payout Rejection] Could not send DM to user ${req.userId}:`, err.message);
      }

      await ctx.reply(
        `❌ <b>Payout <code>${req.requestId}</code> Rejected & Refers Refunded!</b>\nUser ko reason ka DM bhej diya gaya hai.`,
        { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
      );
    }

    // Export Payouts CSV
    async function exportPayoutsCsv(ctx) {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      const allReqs = Array.from(payoutRequests.values())
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      const csvHeader = "Request ID,User ID,User Name,Amount (INR),Refers Count,Payment Details,Status,Submitted At,Processed At,Rejection Reason\n";
      const escapeCsv = (val) => `"${String(val || "").replace(/"/g, '""')}"`;
      const csvRows = allReqs
        .map((r) => [
          escapeCsv(r.requestId),
          escapeCsv(r.userId),
          escapeCsv(r.userName),
          r.amount || 0,
          r.refersCount || 0,
          escapeCsv(r.paymentDetails),
          escapeCsv(r.status),
          escapeCsv(new Date(r.timestamp).toISOString()),
          escapeCsv(r.processedAt ? new Date(r.processedAt).toISOString() : "Pending"),
          escapeCsv(r.rejectionReason || "None")
        ].join(","))
        .join("\n");

      const csvContent = "\uFEFF" + csvHeader + csvRows;
      const fileBuffer = Buffer.from(csvContent, "utf-8");
      const dateStr = new Date().toISOString().split("T")[0];

      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch (_) {}
      }

      await ctx.replyWithDocument(
        new InputFile(fileBuffer, `eipl_payout_requests_${dateStr}.csv`),
        {
          caption:
            `📁 ━━━━━━━━━━━━━━━━━━\n` +
            `📊 <b>PAYOUT REQUESTS DATABASE EXPORT</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💳 <b>Total Requests:</b> <code>${allReqs.length}</code>\n` +
            `📅 <b>Export Date:</b> <code>${new Date().toLocaleDateString("en-IN")}</code>\n` +
            `✨ Complete history with UPI details, statuses, & rejection reasons.`,
          parse_mode: "HTML",
          reply_markup: getAdminReplyKeyboard()
        }
      );
    }

    bot.callbackQuery("admin_export_payouts_csv", exportPayoutsCsv);
    bot.hears([/Export Payouts CSV/i, /^\/payoutscsv$/i], exportPayoutsCsv);

    // Back to User Menu Trigger -> Switches back to User Keyboard
    bot.hears([/🔙 Back to User Menu/i, /Back to User Menu/i], async (ctx) => {
      await ctx.reply(
        `🏏 ━━━━━━━━━━━━━━━━━━\n` +
        `🏆 <b>MAIN USER DASHBOARD</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `User menu activate ho gaya hai:`,
        { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
      );
    });

    // Admin Action: 🔘 Toggle Withdrawals
    bot.hears([/🔘 Toggle Withdrawals/i, /Toggle Withdrawals/i, /^\/togglewithdrawals$/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      withdrawalsEnabled = !withdrawalsEnabled;
      logActivity("admin_toggle_withdrawals", `Withdrawals toggled to: ${withdrawalsEnabled ? "ENABLED" : "PAUSED"}`);

      await ctx.reply(
        `🔘 ━━━━━━━━━━━━━━━━━━\n` +
        `💸 <b>WITHDRAWAL STATUS UPDATED</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Status abhi: <b>${withdrawalsEnabled ? "🟢 ENABLED (Users can redeem)" : "🔴 PAUSED (Maintenance Mode)"}</b>\n` +
        `Jab paused ho, users ko maintenance notice dikhaya jayega.`,
        { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
      );
    });

    // Admin Action: 💳 Manage Points (Add or Deduct points by User ID)
    bot.hears([/💳 Manage Points/i, /Manage Points/i, /^\/managepoints$/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_point_management" });
      await ctx.reply(
        `💳 ━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>POINT MANAGEMENT SYSTEM</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Kisi bhi user ke points add ya deduct karne ke liye format bhejein:\n` +
        `<code>USER_ID | AMOUNT</code>\n\n` +
        `📌 <b>Examples:</b>\n` +
        `• <code>123456789 | +20</code> (Points add karne ke liye)\n` +
        `• <code>123456789 | -10</code> (Points deduct karne ke liye)\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `❌ <i>Cancel karne ke liye /cancel type karein.</i>`,
        { parse_mode: "HTML" }
      );
    });

    // Admin Action: ➕ Add Force Channel
    bot.hears([/➕ Add Force Channel/i, /Add Force Channel/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_channel_info" });
      await ctx.reply(
        `➕ ━━━━━━━━━━━━━━━━━━\n` +
        `📢 <b>ADD FORCE CHANNEL</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Kripya channel ki details bhejein:\n` +
        `<code>CHANNEL_NAME | CHANNEL_ID | CHANNEL_LINK</code>\n\n` +
        `📌 <b>Examples:</b>\n` +
        `• <code>Pritam Looters | @saurabh_editz | https://t.me/saurabh_editz</code>\n` +
        `• <code>@smartmoneyboost2 | https://t.me/smartmoneyboost2</code>\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `❌ <i>Cancel karne ke liye /cancel type karein.</i>`,
        { parse_mode: "HTML" }
      );
    });

    // Admin Action: 📋 View/Remove Channels
    bot.hears([/📋 View\/Remove Channels/i, /View\/Remove Channels/i, /View Channels/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      const kb = new InlineKeyboard();
      if (dynamicChannels.length === 0) {
        return ctx.reply(
          `📢 ━━━━━━━━━━━━━━━━━━\n` +
          `📢 <b>FORCE CHANNELS LIST</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Abhi koi active force channel nahi hai. Naya channel jodne ke liye <b>➕ Add Force Channel</b> button dabayein.`,
          { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
        );
      }

      let text =
        `📢 ━━━━━━━━━━━━━━━━━━\n` +
        `📢 <b>ACTIVE FORCE CHANNELS (${dynamicChannels.length})</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n\n`;

      dynamicChannels.forEach((ch, i) => {
        text += `🔹 <b>${i + 1}. ${escapeHtml(ch.name)}</b>\n   ID: <code>${escapeHtml(ch.id)}</code>\n   Link: ${escapeHtml(ch.link)}\n\n`;
        kb.text(`❌ Remove ${ch.name}`, `del_ch_${i}`).row();
      });

      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
    });

    // Inline callback for channel removal
    bot.callbackQuery(/^del_ch_(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Access Denied", show_alert: true });
      const idx = parseInt(ctx.match[1], 10);
      let removedName = "";
      if (dynamicChannels[idx]) {
        const removed = dynamicChannels.splice(idx, 1)[0];
        removedName = removed.name || removed.id;
        logActivity("admin_remove_channel", `Removed channel: ${removed.id} (${removed.name})`);
        await ctx.answerCallbackQuery({ text: `Removed: ${removedName}`, show_alert: true });
      } else {
        await ctx.answerCallbackQuery({ text: "Channel already removed." });
      }

      // Re-render channel list
      const kb = new InlineKeyboard();
      if (dynamicChannels.length === 0) {
        return ctx.editMessageText(
          `✅ Channel <b>${escapeHtml(removedName)}</b> removed successfully!\n\nAbhi koi active force channel nahi hai.`,
          { parse_mode: "HTML" }
        );
      }

      let text =
        `✅ Channel <b>${escapeHtml(removedName)}</b> removed.\n\n` +
        `📢 ━━━━━━━━━━━━━━━━━━\n` +
        `📢 <b>ACTIVE FORCE CHANNELS (${dynamicChannels.length})</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n\n`;

      dynamicChannels.forEach((ch, i) => {
        text += `🔹 <b>${i + 1}. ${escapeHtml(ch.name)}</b>\n   ID: <code>${escapeHtml(ch.id)}</code>\n   Link: ${escapeHtml(ch.link)}\n\n`;
        kb.text(`❌ Remove ${ch.name}`, `del_ch_${i}`).row();
      });

      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
    });

    // Admin Action: 🎟 Create Redeem Code
    bot.hears([/🎟 Create Redeem Code/i, /Create Redeem Code/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_new_code" });
      await ctx.reply(
        `🎟 ━━━━━━━━━━━━━━━━━━\n` +
        `🎟 <b>CREATE REDEEM CODE</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Format bhejein: <code>CODE | POINTS | MAX_USES</code>\n\n` +
        `📌 <b>Example:</b>\n` +
        `<code>IPL50 | 50 | 100</code>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `❌ <i>Cancel karne ke liye /cancel type karein.</i>`,
        { parse_mode: "HTML" }
      );
    });

    // Admin Action: 👤 Add Admin
    bot.hears([/👤 Add Admin/i, /Add Admin/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_admin_id" });
      await ctx.reply(
        `👤 ━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>ADD BOT ADMIN</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Naye admin ka numeric Telegram User ID bhejein (e.g. <code>123456789</code>).\n\n` +
        `❌ <i>Cancel karne ke liye /cancel type karein.</i>`,
        { parse_mode: "HTML" }
      );
    });

    // Admin Action: 👥 View Users List (Safe chunks of 35 users per message + CSV Export)
    bot.hears([/👥 View Users List/i, /View Users List/i, /^\/users$/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      const userList = Array.from(users.values());
      if (userList.length === 0) {
        return ctx.reply("ℹ️ Abhi koi user registered nahi hai.", { reply_markup: getAdminReplyKeyboard() });
      }

      await ctx.reply(
        `👥 ━━━━━━━━━━━━━━━━━━\n` +
        `📊 <b>TOTAL REGISTERED USERS: ${userList.length}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🚀 Sending user list in sequential parts (35 users/msg) & generating complete CSV export file...`,
        { parse_mode: "HTML" }
      );

      // Safe chunks of 35 users per message to prevent Telegram 4096-char overflow
      const CHUNK_SIZE = 35;
      const totalChunks = Math.ceil(userList.length / CHUNK_SIZE);

      for (let c = 0; c < totalChunks; c++) {
        const chunk = userList.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
        let chunkText =
          `👥 ━━━━━━━━━━━━━━━━━━\n` +
          `📋 <b>USERS LIST [Part ${c + 1}/${totalChunks}]</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n\n`;

        chunk.forEach((u, idx) => {
          const globalIdx = c * CHUNK_SIZE + idx + 1;
          const uname = u.username ? `@${escapeHtml(u.username)}` : "<i>No Username</i>";
          const statusIcon = u.isVerified ? "✅" : "⚠️";
          chunkText += `<b>#${globalIdx}. ${escapeHtml(u.firstName)}</b> (${uname})\n` +
            `   🆔 <code>${escapeHtml(u.id)}</code> | 💎 <b>${u.points || 0} pts</b> | 👥 <b>${u.referralsCount || 0} refs</b> ${statusIcon}\n\n`;
        });

        await ctx.reply(chunkText, { parse_mode: "HTML" });
        if (c < totalChunks - 1) {
          await new Promise((r) => setTimeout(r, 300)); // 300ms delay between messages
        }
      }

      // Generate and send complete downloadable CSV file export
      try {
        const csvHeader = "User ID,First Name,Last Name,Username,Points,Referrals,Referrer ID,Joined Date,Verified Status\n";
        const escapeCsv = (val) => `"${String(val || "").replace(/"/g, '""')}"`;
        const csvRows = userList
          .map((u) => [
            escapeCsv(u.id),
            escapeCsv(u.firstName),
            escapeCsv(u.lastName || ""),
            escapeCsv(u.username ? `@${u.username}` : ""),
            u.points || 0,
            u.referralsCount || 0,
            escapeCsv(u.referrerId || "None"),
            escapeCsv(u.joinedAt || ""),
            u.isVerified ? "Verified" : "Unverified"
          ].join(","))
          .join("\n");

        const csvContent = "\uFEFF" + csvHeader + csvRows; // UTF-8 BOM for Excel
        const fileBuffer = Buffer.from(csvContent, "utf-8");
        const dateStr = new Date().toISOString().split("T")[0];

        await ctx.replyWithDocument(
          new InputFile(fileBuffer, `eipl_users_${dateStr}.csv`),
          {
            caption:
              `📁 ━━━━━━━━━━━━━━━━━━\n` +
              `📊 <b>COMPLETE USER DATABASE EXPORT</b>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `👥 <b>Total Users:</b> <code>${userList.length}</code>\n` +
              `📅 <b>Export Date:</b> <code>${new Date().toLocaleDateString("en-IN")}</code>\n` +
              `✨ Compatible with Excel, Google Sheets, & Numbers.`,
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          }
        );
      } catch (err) {
        console.error("Error generating CSV export:", err);
      }
    });

    // Admin Action: 📊 Bot Stats
    bot.hears([/📊 Bot Stats/i, /Bot Stats/i, /^\/stats$/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      const userList = Array.from(users.values());
      const totalPoints = userList.reduce((s, u) => s + (u.points || 0), 0);
      const verified = userList.filter((u) => u.isVerified).length;
      const unverified = userList.length - verified;
      const totalReferrals = userList.reduce((s, u) => s + (u.referralsCount || 0), 0);
      const vRate = userList.length > 0 ? ((verified / userList.length) * 100).toFixed(1) : "0.0";

      const uptimeSec = Math.floor(process.uptime());
      const uptimeH = Math.floor(uptimeSec / 3600);
      const uptimeM = Math.floor((uptimeSec % 3600) / 60);

      await ctx.reply(
        `📊 ━━━━━━━━━━━━━━━━━━\n` +
        `📈 <b>eIPL SYSTEM & BOT ANALYTICS</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>Total Users Registered:</b> <code>${userList.length}</code>\n` +
        `✅ <b>Verified Members:</b> <code>${verified}</code> (${vRate}%)\n` +
        `⚠️ <b>Pending Verification:</b> <code>${unverified}</code>\n` +
        `💎 <b>Total Points in Circulation:</b> <code>${totalPoints} Points</code>\n` +
        `🤝 <b>Active Referrals:</b> <code>${totalReferrals}</code>\n` +
        `💸 <b>Withdrawals Status:</b> <b>${withdrawalsEnabled ? "🟢 ENABLED" : "🔴 PAUSED"}</b>\n` +
        `📢 <b>Active Force Channels:</b> <code>${dynamicChannels.length}</code>\n` +
        `🎟 <b>Active Promo Codes:</b> <code>${redeemCodes.size}</code>\n` +
        `👤 <b>Admin Operators:</b> <code>${admins.size}</code>\n` +
        `⏱ <b>Process Uptime:</b> <code>${uptimeH}h ${uptimeM}m</code>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🟢 <i>Telegram Polling & Keep-Alive Server Active</i>`,
        { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
      );
    });

    // Admin Action: 📢 Broadcast Msg Prompt
    bot.hears([/📢 Broadcast Msg/i, /Broadcast Msg/i, /^\/broadcast$/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_broadcast" });
      await ctx.reply(
        `📢 ━━━━━━━━━━━━━━━━━━\n` +
        `🚀 <b>ROBUST BROADCAST SYSTEM</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Agla message jo aap yahan bhejenge woh sabhi <b>${users.size}</b> registered users ko smoothly forward/copy kiya jayega!\n\n` +
        `✨ <b>Supported Formats (copyMessage):</b>\n` +
        `• 📝 Plain text & Long formatted text\n` +
        `• 🔗 Links & Markdown/HTML styling\n` +
        `• 🖼 Photos with Captions\n` +
        `• 🎥 Videos, Stickers, Voice & Audio\n` +
        `• 🔘 Custom Inline Keyboard buttons\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Apna broadcast message abhi yahan bhejein ya cancel karne ke liye /cancel type karein.</i>`,
        { parse_mode: "HTML" }
      );
    });

    // Command: /cancel
    bot.command("cancel", async (ctx) => {
      userStates.delete(String(ctx.from.id));
      await ctx.reply("❌ Action cancel kar diya gaya hai.", { reply_markup: getMainReplyKeyboard(ctx.from.id) });
    });

    // Universal Message & Input Handler
    bot.on("message", async (ctx) => {
      const from = ctx.from;
      if (!from) return;
      const userId = String(from.id);
      const state = userStates.get(userId);
      const text = ctx.message.text ? ctx.message.text.trim() : "";

      if (!state) return;

      // Check for cancel / back navigation while in any active state
      if (text === "/cancel" || text === "🔙 Back to User Menu" || text === "⚙️ Admin Panel") {
        userStates.delete(userId);
        if (text === "🔙 Back to User Menu") {
          return ctx.reply("🏏 User Menu Activate.", { reply_markup: getMainReplyKeyboard(from.id) });
        }
        if (text === "⚙️ Admin Panel") {
          return ctx.reply("⚙️ Admin Panel Activate.", { reply_markup: getAdminReplyKeyboard() });
        }
        return ctx.reply("❌ Action cancel kar diya gaya hai.", { reply_markup: getMainReplyKeyboard(from.id) });
      }

      // 1. BROADCAST HANDLER (copyMessage for all message types)
      if (state.action === "awaiting_broadcast" && isAdmin(userId)) {
        userStates.delete(userId);
        const targetIds = Array.from(users.keys());
        const total = targetIds.length;

        if (total === 0) {
          return ctx.reply("⚠️ <b>Broadcast Cancelled:</b> Abhi database mein koi user registered nahi hai.", {
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          });
        }

        await ctx.reply(
          `⏳ ━━━━━━━━━━━━━━━━━━\n` +
          `🚀 <b>BROADCAST DELIVERY IN PROGRESS</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Copying message to <b>${total}</b> registered users...\n` +
          `Rate-limit safe delay (~50ms/recipient) active.`,
          { parse_mode: "HTML" }
        );

        let delivered = 0;
        let failed = 0;
        const fromChatId = ctx.chat.id;
        const messageId = ctx.message.message_id;

        for (const targetId of targetIds) {
          try {
            await ctx.api.copyMessage(targetId, fromChatId, messageId);
            delivered++;
          } catch (err) {
            failed++;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        const successRate = total > 0 ? ((delivered / total) * 100).toFixed(1) : "0.0";
        logActivity("broadcast_complete", `Broadcast: ${delivered} delivered, ${failed} failed out of ${total}`);

        return ctx.reply(
          `📢 ━━━━━━━━━━━━━━━━━━\n` +
          `📊 <b>BROADCAST DELIVERY SUMMARY</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👥 <b>Total Attempted:</b> <code>${total}</code>\n` +
          `✅ <b>Delivered Successfully:</b> <code>${delivered}</code>\n` +
          `❌ <b>Failed / Blocked:</b> <code>${failed}</code>\n` +
          `📈 <b>Success Rate:</b> <code>${successRate}%</code>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `✨ <i>Delivered without entity formatting errors!</i>`,
          { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
        );
      }

      // 2. POINT MANAGEMENT (Add or Deduct points by User ID)
      if (state.action === "awaiting_point_management" && isAdmin(userId)) {
        userStates.delete(userId);
        const parts = text.split("|").map((s) => s.trim());
        if (parts.length < 2) {
          return ctx.reply("❌ Invalid format! Please send <code>USER_ID | AMOUNT</code> (e.g. <code>123456789 | +25</code>).", {
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          });
        }

        const targetUserId = parts[0].replace(/[^0-9]/g, "");
        const rawAmount = parts[1].replace(/\s+/g, "");
        const amountNum = parseInt(rawAmount, 10);

        if (isNaN(amountNum) || amountNum === 0) {
          return ctx.reply("❌ Invalid amount! Use format like <code>+20</code> or <code>-10</code>.", {
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          });
        }

        const targetUser = users.get(targetUserId);
        if (!targetUser) {
          return ctx.reply(`❌ User ID <code>${escapeHtml(targetUserId)}</code> not found in bot database.`, {
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          });
        }

        const oldPoints = targetUser.points || 0;
        targetUser.points = Math.max(0, oldPoints + amountNum);
        logActivity("admin_point_manage", `Admin ${userId} adjusted points for ${targetUserId} by ${amountNum} (Old: ${oldPoints}, New: ${targetUser.points})`);

        updateUser(targetUserId, { points: targetUser.points }).catch(() => {});

        // Notify user
        try {
          await bot.api.sendMessage(
            targetUserId,
            `💳 ━━━━━━━━━━━━━━━━━━\n` +
            `💎 <b>POINTS BALANCE UPDATE</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Aapke account mein <b>${amountNum > 0 ? "+" + amountNum : amountNum} Points</b> update kiye gaye hain!\n\n` +
            `💰 <b>Aapka Naya Balance:</b> <b>${targetUser.points} Points</b>`,
            { parse_mode: "HTML" }
          );
        } catch (e) {}

        return ctx.reply(
          `✅ ━━━━━━━━━━━━━━━━━━\n` +
          `💳 <b>POINTS UPDATED SUCCESSFULLY!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>User:</b> ${escapeHtml(targetUser.firstName)} (<code>${escapeHtml(targetUserId)}</code>)\n` +
          `🔹 <b>Adjustment:</b> <code>${amountNum > 0 ? "+" + amountNum : amountNum} Points</code>\n` +
          `💰 <b>Previous Balance:</b> <code>${oldPoints} Points</code>\n` +
          `💎 <b>Current Balance:</b> <b>${targetUser.points} Points</b>`,
          { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
        );
      }

      // 3. REDEEM CODE REDEMPTION
      if (state.action === "awaiting_redeem_code") {
        userStates.delete(userId);
        const user = getOrCreateUser(from);
        return processRedeemCode(ctx, text, user);
      }

      // 4. ADD FORCE CHANNEL
      if (state.action === "awaiting_channel_info" && isAdmin(userId)) {
        userStates.delete(userId);
        const parts = text.split("|").map((s) => s.trim()).filter(Boolean);

        let chName = "";
        let chId = "";
        let chLink = "";

        if (parts.length >= 3) {
          chName = parts[0];
          chId = parts[1].startsWith("@") ? parts[1] : parts[1].startsWith("-") ? parts[1] : `@${parts[1]}`;
          chLink = formatTelegramUrl(parts[2]);
        } else if (parts.length === 2) {
          chId = parts[0].startsWith("@") ? parts[0] : parts[0].startsWith("-") ? parts[0] : `@${parts[0]}`;
          chName = chId;
          chLink = formatTelegramUrl(parts[1]);
        } else if (parts.length === 1) {
          chId = parts[0].startsWith("@") ? parts[0] : `@${parts[0]}`;
          chName = chId;
          chLink = formatTelegramUrl(chId);
        } else {
          return ctx.reply("❌ Invalid format! Please send <code>NAME | @CHANNEL_ID | LINK</code>.", {
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          });
        }

        const existing = dynamicChannels.find((c) => c.id.toLowerCase() === chId.toLowerCase());
        if (existing) {
          existing.name = chName;
          existing.link = chLink;
          return ctx.reply(`✅ <b>Channel Updated:</b> <code>${escapeHtml(chId)}</code>`, {
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          });
        }

        dynamicChannels.push({ id: chId, name: chName, link: chLink });
        logActivity("admin_add_channel", `Added channel: ${chId} (${chName})`);
        return ctx.reply(
          `✅ ━━━━━━━━━━━━━━━━━━\n` +
          `📢 <b>FORCE CHANNEL ADDED SAFALTA POORVAK!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🔹 <b>Name:</b> ${escapeHtml(chName)}\n` +
          `🔹 <b>ID:</b> <code>${escapeHtml(chId)}</code>\n` +
          `🔹 <b>Link:</b> ${escapeHtml(chLink)}\n` +
          `━━━━━━━━━━━━━━━━━━`,
          { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard(), link_preview_options: { is_disabled: true } }
        );
      }

      // 5. CREATE PROMO CODE
      if (state.action === "awaiting_new_code" && isAdmin(userId)) {
        userStates.delete(userId);
        const parts = text.split("|").map((s) => s.trim());
        if (parts.length < 3) {
          return ctx.reply("❌ Invalid format! Please send <code>CODE | POINTS | MAX_USES</code>.", {
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          });
        }
        const cCode = parts[0].toUpperCase().replace(/\s+/g, "");
        const cPts = parseInt(parts[1], 10) || 5;
        const cMax = parseInt(parts[2], 10) || 100;

        const promoPayload = {
          code: cCode,
          points: cPts,
          maxUses: cMax,
          active: true,
          description: "Admin Created Promo Code",
          createdAt: new Date().toISOString(),
          usedBy: {}
        };

        redeemCodes.set(cCode, {
          ...promoPayload,
          usedBy: new Set()
        });

        savePromoCode(cCode, promoPayload).catch(() => {});
        logActivity("admin_create_code", `Created code: ${cCode}`);
        return ctx.reply(
          `✅ ━━━━━━━━━━━━━━━━━━\n` +
          `🎟 <b>PROMO CODE CREATED!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🔹 <b>Code:</b> <code>${escapeHtml(cCode)}</code>\n` +
          `🔹 <b>Points:</b> <code>+${cPts}</code>\n` +
          `🔹 <b>Max Uses:</b> <code>${cMax}</code>\n` +
          `💾 <i>Saved to Firebase Realtime Database!</i>`,
          { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
        );
      }

      // 6. ADD ADMIN ID
      if (state.action === "awaiting_admin_id" && isAdmin(userId)) {
        userStates.delete(userId);
        const newId = text.replace(/[^0-9]/g, "");
        if (newId.length >= 5) {
          admins.add(newId);
          logActivity("admin_add", `New Admin: ${newId}`);
          return ctx.reply(`✅ <b>Admin <code>${escapeHtml(newId)}</code> Added Successfully!</b>`, {
            parse_mode: "HTML",
            reply_markup: getAdminReplyKeyboard()
          });
        }
        return ctx.reply("❌ Invalid numeric User ID.", { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
      }

      // 7. CASH PAYOUT PAYMENT DETAILS
      if (state.action === "awaiting_payout_payment_details") {
        userStates.delete(userId);
        const user = getOrCreateUser(from);
        const availableRefers = state.data?.availableRefers || 10;
        const payoutAmount = state.data?.amount || 10;

        if (!text || text.length < 3 || text.startsWith("/")) {
          return ctx.reply("⚠️ <b>Invalid Payment Method:</b> Kripya valid UPI ID ya mobile number enter karein (e.g. <code>yourname@upi</code> ya <code>9876543210</code>).", {
            parse_mode: "HTML",
            reply_markup: getMainReplyKeyboard(userId)
          });
        }

        // Generate clean Request ID
        const requestId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
        const newReq = {
          requestId,
          userId: String(user.id),
          userName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "User",
          amount: payoutAmount,
          refersCount: availableRefers,
          paymentDetails: text.trim(),
          status: "PENDING",
          timestamp: Date.now(),
          createdAt: new Date().toISOString()
        };

        payoutRequests.set(requestId, newReq);
        await savePayoutRequest(requestId, newReq);

        // Update user referral_cash in Firebase
        const stats = getUserCashStats(user.id);
        await updateUserReferralCash(user.id, {
          totalRefers: stats.totalRefers,
          availableBalance: stats.availableCash,
          totalWithdrawn: stats.paidCash
        });

        logActivity("payout_request_created", `User ${user.id} requested payout ${requestId} for ₹${payoutAmount} (${availableRefers} refers) via ${text.trim()}`);

        // Notify Admins
        for (const adminId of admins) {
          try {
            const adminKb = new InlineKeyboard()
              .text("✅ Approve & Paid", `payout_appr_${requestId}`)
              .text("❌ Reject & Refund", `payout_rej_${requestId}`);

            await bot.api.sendMessage(
              adminId,
              `🔔 ━━━━━━━━━━━━━━━━━━\n` +
              `💳 <b>NEW CASH PAYOUT REQUEST!</b>\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `Nayi cash payout request aayi hai:\n\n` +
              `📌 <b>Request ID:</b> <code>${requestId}</code>\n` +
              `👤 <b>User:</b> ${escapeHtml(newReq.userName)} (<code>${user.id}</code>)\n` +
              `💵 <b>Amount:</b> <b>₹${payoutAmount}</b>\n` +
              `👥 <b>Refers Count:</b> <b>${availableRefers} Refers</b>\n` +
              `📱 <b>Payment Method:</b> <code>${escapeHtml(newReq.paymentDetails)}</code>\n` +
              `📅 <b>Time:</b> <code>${new Date().toLocaleTimeString("en-IN")}</code>\n\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `👇 <i>Quick Action:</i>`,
              { parse_mode: "HTML", reply_markup: adminKb }
            );
          } catch (_) {}
        }

        return ctx.reply(
          `🎉 ━━━━━━━━━━━━━━━━━━\n` +
          `✅ <b>PAYOUT REQUEST CONFIRMED!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Aapki payout request successfully submit ho chuki hai:\n\n` +
          `📌 <b>Request ID:</b> <code>${requestId}</code>\n` +
          `💵 <b>Payout Amount:</b> <b>₹${payoutAmount}</b>\n` +
          `👥 <b>Refers Redeemed:</b> <b>${availableRefers} Refers</b>\n` +
          `📱 <b>Payment Method:</b> <code>${escapeHtml(newReq.paymentDetails)}</code>\n` +
          `⏳ <b>Status:</b> <b>🟡 PENDING (Under Review)</b>\n` +
          `📅 <b>Date:</b> <code>${new Date().toLocaleString("en-IN")}</code>\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⏱ <i>Admin team 1-12 ghanton ke andar aapke account mein paise transfer kar degi. Status dekhne ke liye <b>📜 Payout History</b> check karein.</i>`,
          { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(userId) }
        );
      }

      // 8. ADMIN CUSTOM REJECTION REASON
      if (state.action === "awaiting_payout_reject_custom_reason" && isAdmin(userId)) {
        userStates.delete(userId);
        const reqId = state.data?.reqId;
        const req = payoutRequests.get(reqId);
        if (!req) {
          return ctx.reply("❌ Payout request not found.", { reply_markup: getAdminReplyKeyboard() });
        }
        return executePayoutRejection(ctx, req, text.trim());
      }
    });

    // Start Polling Safely with Single Polling Guard
    (async () => {
      try {
        // Clear any existing webhook to ensure clean polling without conflict
        await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

        await bot.start({
          onStart(info) {
            botStatus.isPolling = true;
            botStatus.username = info.username;
            botStatus.error = null;
            console.log(`[Telegram Bot] Polling started live as @${info.username} (ID: ${info.id})`);
            logActivity("bot_online", `@${info.username} is online and polling updates.`);
          }
        });
      } catch (err) {
        if (err.error_code === 409 || String(err.message || "").includes("409: Conflict")) {
          console.warn("[Telegram Bot] Another polling instance detected (409 Conflict). Single polling guard active; ensuring no duplicate polling loop lingers.");
          botStatus.isPolling = false;
          botStatus.error = "Conflict: another polling instance is running";
        } else {
          console.error("[Telegram Bot Polling Error]:", err.message);
          botStatus.isPolling = false;
          botStatus.error = err.message;
        }
      }
    })();
  } catch (err) {
    console.error("[Telegram Initialization Error]:", err.message);
    botStatus.error = err.message;
  }
} else {
  console.log("======================================================");
  console.log("⚠️  [eIPL Official Bot] BOT_TOKEN is missing or empty!");
  console.log("👉 Please configure BOT_TOKEN, ADMIN_ID_1, ADMIN_ID_2, and SUPPORT_LINK in Secrets / .env");
  console.log("🌐 Keep-Alive Health Server is running on port " + PORT);
  console.log("======================================================");
}

// Clean process shutdown to ensure no zombie polling instances linger
let isShuttingDown = false;
async function cleanExit(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Process] Received ${signal}. Stopping bot safely...`);
  if (bot && botStatus.isPolling) {
    try {
      await bot.stop();
      console.log("[Telegram Bot] Polling stopped successfully.");
    } catch (_) {}
    botStatus.isPolling = false;
  }
  process.exit(0);
}
process.once("SIGINT", () => cleanExit("SIGINT"));
process.once("SIGTERM", () => cleanExit("SIGTERM"));

// ==========================================
// 7. LIGHTWEIGHT HTTP HEALTH & DASHBOARD
// ==========================================
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  if (pathname === "/health" || pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        bot: botStatus.isPolling ? "online" : "waiting_token",
        username: botStatus.username || null,
        usersCount: users.size,
        firebaseConnected: isFirebaseReady(),
        firebaseDatabaseUrl: DATABASE_URL,
        withdrawalsEnabled,
        uptime: process.uptime()
      })
    );
  }

  if (pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        botTokenConfigured: Boolean(BOT_TOKEN && BOT_TOKEN.length > 10),
        isPolling: botStatus.isPolling,
        username: botStatus.username,
        error: botStatus.error,
        admins: Array.from(admins),
        supportLink: SUPPORT_URL,
        usersCount: users.size,
        payoutsCount: payoutRequests.size,
        pendingPayoutsCount: Array.from(payoutRequests.values()).filter((r) => r.status === "PENDING").length,
        firebaseConnected: isFirebaseReady(),
        firebaseDatabaseUrl: DATABASE_URL,
        channelsCount: dynamicChannels.length,
        codesCount: redeemCodes.size,
        withdrawalsEnabled,
        logs: activityLogs
      })
    );
  }

  // Root Visual Dashboard
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      ${!botStatus.isPolling ? '<meta http-equiv="refresh" content="5">' : ''}
      <title>eIPL Official Bot - Service Dashboard</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #f1f5f9; padding: 1.5rem 1rem; margin: 0; line-height: 1.5; }
        .container { max-width: 580px; margin: 0 auto; background: #111a2e; border: 1px solid #1e293b; border-radius: 24px; padding: 1.5rem; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
        h1 { margin: 0 0 0.25rem 0; font-size: 1.4rem; display: flex; align-items: center; gap: 0.5rem; color: #f8fafc; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 0.8rem; }
        .badge-green { background: #064e3b; color: #34d399; border: 1px solid #059669; }
        .badge-amber { background: #451a03; color: #fbbf24; border: 1px solid #d97706; }
        .badge-blue { background: #0c4a6e; color: #38bdf8; border: 1px solid #0284c7; }
        
        .feature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; margin: 1.2rem 0; }
        .feature-card { background: #0e172a; border: 1px solid #1e293b; border-radius: 12px; padding: 0.75rem; font-size: 0.82rem; }
        .feature-title { font-weight: 700; color: #38bdf8; margin-bottom: 0.25rem; }

        .keyboard-frame { background: #1e293b; border-radius: 20px; padding: 14px; margin: 1.2rem 0; border: 1px solid #334155; }
        .kb-title { font-size: 0.85rem; color: #94a3b8; font-weight: 700; text-transform: uppercase; margin-bottom: 10px; display: flex; justify-content: space-between; }
        .kb-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
        .kb-row.single { grid-template-columns: 1fr; }
        .kb-btn { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 10px; border-radius: 12px; font-weight: 600; font-size: 0.85rem; color: #ffffff; }
        .btn-primary { background: #2563eb; border: 1px solid #3b82f6; }
        .btn-success { background: #16a34a; border: 1px solid #22c55e; }
        .btn-danger { background: #dc2626; border: 1px solid #ef4444; color: #fff; }

        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; margin: 1rem 0; }
        .stat-card { background: #0a101d; border: 1px solid #1e293b; border-radius: 12px; padding: 0.75rem; text-align: center; }
        .stat-num { font-size: 1.2rem; font-weight: bold; color: #f59e0b; }
        .stat-label { font-size: 0.68rem; color: #94a3b8; text-transform: uppercase; }
        .section-title { font-size: 0.9rem; font-weight: bold; margin-top: 1.25rem; margin-bottom: 0.5rem; color: #cbd5e1; }
        ul { padding-left: 1.2rem; margin: 0.5rem 0; }
        li { font-size: 0.85rem; color: #94a3b8; margin-bottom: 0.3rem; }
        a { color: #38bdf8; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .notice-box { background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 12px; padding: 1rem; margin: 1rem 0; font-size: 0.85rem; color: #fde68a; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏏 eIPL Official Bot</h1>
        <p style="margin: 0 0 1rem 0; font-size: 0.88rem; color: #94a3b8;">Firebase RTDB Persistence • Cash Refer & Payout System • Spin & Win</p>
        
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem;">
          ${
            botStatus.isPolling
              ? `<span class="badge badge-green">🟢 Live Polling (@${botStatus.username})</span>`
              : `<span class="badge badge-amber">🟡 Bot: Standby (Waiting for BOT_TOKEN)</span>`
          }
          ${
            isFirebaseReady()
              ? `<span class="badge badge-green">🔥 Firebase RTDB: Connected</span>`
              : `<span class="badge badge-blue">💾 Memory Sync: 31 Restored Users Active</span>`
          }
        </div>

        ${
          !botStatus.isPolling
            ? `
          <div class="notice-box">
            🔑 <strong>Secrets Configuration Required:</strong><br/>
            Please fill in your <strong>BOT_TOKEN</strong> in the Secrets panel. This dashboard automatically rechecks every 5 seconds.
          </div>
        `
            : ""
        }

        <div class="feature-grid">
          <div class="feature-card">
            <div class="feature-title">👥 Cash Refer & Payout</div>
            <div>₹ Cash dashboard, UPI withdrawals, ₹100 flat bonus for 50+ refers.</div>
          </div>
          <div class="feature-card">
            <div class="feature-title">💳 Admin Payout Controls</div>
            <div>Review, 1-click Approve & DM, Reject & Refund, CSV Export.</div>
          </div>
          <div class="feature-card">
            <div class="feature-title">🎰 Spin & Win Wheel</div>
            <div>24h cooldown, animated reels, random +1 to 10 points reward.</div>
          </div>
          <div class="feature-card">
            <div class="feature-title">🔥 Firebase RTDB Persistence</div>
            <div>All users, promo codes, & payout requests synced real-time.</div>
          </div>
        </div>

        <!-- Vibrant Styled User Keyboard Preview -->
        <div class="keyboard-frame">
          <div class="kb-title">
            <span>📱 Styled Native Keyboard:</span>
            <span style="color: ${withdrawalsEnabled ? '#34d399' : '#f87171'};">
              Redemptions: ${withdrawalsEnabled ? 'ON' : 'PAUSED'}
            </span>
          </div>
          <div class="kb-row single">
            <div class="kb-btn btn-success">👥 Refer & Earn (₹ Cash)</div>
          </div>
          <div class="kb-row">
            <div class="kb-btn btn-primary">🎰 Spin & Win</div>
            <div class="kb-btn btn-primary">⏰ Roz ka Check-in</div>
          </div>
          <div class="kb-row">
            <div class="kb-btn btn-success">💰 Earn Money (Invite)</div>
            <div class="kb-btn btn-success">🔥 Hot Offers</div>
          </div>
          <div class="kb-row">
            <div class="kb-btn btn-primary">💎 Point Balance</div>
            <div class="kb-btn btn-primary">🏆 Leaderboard</div>
          </div>
          <div class="kb-row">
            <div class="kb-btn btn-success">🎯 Redeem Points</div>
            <div class="kb-btn btn-success">🎁 Secret Gift Code</div>
          </div>
          <div class="kb-row single">
            <div class="kb-btn btn-primary">📞 Customer Support</div>
          </div>
          <div class="kb-row single">
            <div class="kb-btn btn-danger">⚙️ Admin Panel</div>
          </div>
          <div class="kb-row single">
            <div class="kb-btn btn-danger">❌ Close Menu</div>
          </div>
        </div>

        <div class="grid">
          <div class="stat-card">
            <div class="stat-num">${users.size}</div>
            <div class="stat-label">Users</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${Array.from(payoutRequests.values()).filter((r) => r.status === "PENDING").length}</div>
            <div class="stat-label">Pending ₹</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${dynamicChannels.length}</div>
            <div class="stat-label">Channels</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${redeemCodes.size}</div>
            <div class="stat-label">Codes</div>
          </div>
        </div>

        <div class="section-title">💳 Recent Payout Requests (${payoutRequests.size}):</div>
        <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 6px 12px; margin-bottom: 20px;">
          ${
            payoutRequests.size === 0
              ? '<div style="color: #64748b; font-size: 13px; padding: 8px;">No payout requests yet. Users can request payout via 👥 Refer & Earn (₹ Cash).</div>'
              : Array.from(payoutRequests.values()).slice(-5).reverse().map(r => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.06);">
                  <div>
                    <code style="color: #38bdf8; font-size: 13px; font-weight: bold;">${escapeHtml(r.requestId)}</code>
                    <span style="color: #cbd5e1; font-size: 13px; margin-left: 6px;">${escapeHtml(r.userName)}</span>
                    <div style="color: #64748b; font-size: 11px;">UPI: ${escapeHtml(r.paymentDetails)}</div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">₹${r.amount}</span>
                    <span style="padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; ${r.status === 'PAID' ? 'background: #064e3b; color: #34d399;' : r.status === 'REJECTED' ? 'background: #450a0a; color: #f87171;' : 'background: #451a03; color: #fbbf24;'}">${r.status}</span>
                  </div>
                </div>
              `).join('')
          }
        </div>

        <div class="section-title">🎁 Active Promo / Gift Codes (${redeemCodes.size}):</div>
        <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 6px 12px; margin-bottom: 20px;">
          ${Array.from(redeemCodes.values()).map(c => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.06);">
              <div>
                <code style="color: #60a5fa; font-size: 14px; font-weight: bold;">${escapeHtml(c.code)}</code>
                <span style="color: #94a3b8; font-size: 12px; margin-left: 6px;">(${escapeHtml(c.description || 'VIP Gift')})</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="background: rgba(52, 211, 153, 0.2); color: #34d399; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">+${c.points} Pts</span>
                <span style="color: #64748b; font-size: 11px;">${c.usedBy ? (c.usedBy.size !== undefined ? c.usedBy.size : Object.keys(c.usedBy).length) : 0}/${c.maxUses || '∞'} claimed</span>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="section-title">⚡ Environment & Database:</div>
        <ul>
          <li><strong>Firebase RTDB:</strong> <code>${escapeHtml(DATABASE_URL)}</code></li>
          <li><strong>User Records:</strong> ${users.size} loaded (${SEED_USERS ? Object.keys(SEED_USERS).length : 0} from CSV restore)</li>
          <li><strong>BOT_TOKEN:</strong> ${BOT_TOKEN ? "Configured (" + BOT_TOKEN.slice(0, 7) + "...)" : "Not configured yet"}</li>
          <li><strong>ADMIN_ID_1:</strong> ${ADMIN_ID_1}</li>
          <li><strong>ADMIN_ID_2:</strong> ${ADMIN_ID_2}</li>
          <li><strong>SUPPORT_LINK:</strong> <a href="${SUPPORT_URL}" target="_blank">${escapeHtml(RAW_SUPPORT_LINK)}</a></li>
          <li><strong>PORT:</strong> ${PORT}</li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

// Bind server once strictly on PORT
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Keep-Alive Server] Listening on port ${PORT} (0.0.0.0:${PORT})`);
});
