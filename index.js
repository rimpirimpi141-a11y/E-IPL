/**
 * eIPL Official Bot
 * Pure Node.js & CommonJS Telegram Bot Engine
 * Framework: grammY
 * Standard: Node.js / NPM (Zero Bun / Frozen Lockfile dependencies)
 */

const { Bot, InlineKeyboard, Keyboard, InputFile } = require("grammy");
const http = require("http");
require("dotenv").config();

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
// 2. IN-MEMORY STORAGE & CACHE
// ==========================================
// userId -> { id, firstName, lastName, username, points, referrerId, isVerified, joinedAt, joinedTimestamp, lastCheckin, lastSpin, referralsCount }
const users = new Map();
const verifiedUsers = new Set(); // Persistent cache of verified user IDs

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

const redeemCodes = new Map([
  [
    "EIPLFREE120",
    {
      code: "EIPLFREE120",
      points: 10,
      maxUses: 10000,
      usedBy: new Set(),
      createdAt: new Date().toISOString()
    }
  ],
  [
    "EIPL2026",
    {
      code: "EIPL2026",
      points: 5,
      maxUses: 500,
      usedBy: new Set(),
      createdAt: new Date().toISOString()
    }
  ],
  [
    "WELCOME10",
    {
      code: "WELCOME10",
      points: 10,
      maxUses: 100,
      usedBy: new Set(),
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
  if (!users.has(userId)) {
    const newUser = {
      id: userId,
      firstName: from.first_name || "User",
      lastName: from.last_name || "",
      username: from.username || "",
      points: 0,
      referrerId: referrerId && referrerId !== userId ? String(referrerId) : null,
      isVerified: false,
      joinedAt: new Date().toISOString(),
      joinedTimestamp: Date.now(),
      lastCheckin: 0,
      lastSpin: 0,
      referralsCount: 0
    };
    users.set(userId, newUser);
    logActivity("user_registered", `User ${newUser.firstName} (ID: ${userId}) registered.`);
    return newUser;
  }
  const user = users.get(userId);
  if (from.first_name) user.firstName = from.first_name;
  if (from.last_name) user.lastName = from.last_name;
  if (from.username) user.username = from.username;
  if (!user.joinedTimestamp) {
    user.joinedTimestamp = user.joinedAt ? new Date(user.joinedAt).getTime() : Date.now();
  }
  if (user.isVerified) {
    verifiedUsers.add(userId);
  }
  return user;
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

  // ROW 1 (Blue / Primary): "🎰 Spin & Win" | "⏰ Roz ka Check-in"
  kb.text("🎰 Spin & Win").primary().text("⏰ Roz ka Check-in").primary().row();

  // ROW 2 (Green / Success): "💰 Earn Money (Invite)" | "🔥 Hot Offers"
  kb.text("💰 Earn Money (Invite)").success().text("🔥 Hot Offers").success().row();

  // ROW 3 (Blue / Primary): "💎 Point Balance" | "🏆 Leaderboard"
  kb.text("💎 Point Balance").primary().text("🏆 Leaderboard").primary().row();

  // ROW 4 (Green / Success): "🎯 Redeem Points" | "🎁 Secret Gift Code"
  kb.text("🎯 Redeem Points").success().text("🎁 Secret Gift Code").success().row();

  // ROW 5 (Blue / Primary): "📞 Customer Support"
  kb.text("📞 Customer Support").primary().row();

  // ROW 6 (Red / Danger): "⚙️ Admin Panel" (Admin Only)
  if (userId && isAdmin(userId)) {
    kb.text("⚙️ Admin Panel").danger().row();
  }

  // ROW 7 (Red / Danger): "❌ Close Menu"
  kb.text("❌ Close Menu").danger();

  return kb.resized();
}

/**
 * Full Admin Reply Keyboard with Native Color Styles:
 */
function getAdminReplyKeyboard() {
  return new Keyboard()
    .text("➕ Add Force Channel").primary().text("📋 View/Remove Channels").primary().row()
    .text("🎟 Create Redeem Code").success().text("👤 Add Admin").success().row()
    .text("👥 View Users List").primary().text("📊 Bot Stats").primary().row()
    .text("💳 Manage Points").success().text("🔘 Toggle Withdrawals").danger().row()
    .text("📢 Broadcast Msg").primary().row()
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

    // Transformer: Sanitize all outgoing text and caption payloads to ensure valid UTF-8
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (payload && typeof payload === "object") {
        for (const key of ["text", "caption"]) {
          if (typeof payload[key] === "string") {
            payload[key] = cleanUtf8(payload[key]);
          }
        }
      }
      return prev(method, payload, signal);
    });

    // Global Error Handler so the bot never crashes the process
    bot.catch((err) => {
      console.error(`[Telegram Bot Error] Error in update ${err.ctx?.update?.update_id}:`, err.error);
      botStatus.error = err.error?.message || "Telegram API error";
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

      const wasVerified = user.isVerified;
      user.isVerified = true;
      verifiedUsers.add(userId);

      // Award +2 points to referrer on first verification
      if (!wasVerified && user.referrerId && users.has(user.referrerId)) {
        const referrer = users.get(user.referrerId);
        referrer.points += 2;
        referrer.referralsCount += 1;
        logActivity("referral_bonus", `+2 Points to ${referrer.firstName} for referring ${user.firstName}`);

        try {
          await ctx.api.sendMessage(
            user.referrerId,
            `🎉 ━━━━━━━━━━━━━━━━━━\n` +
            `🎁 <b>Naya Referral Bonus!</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Aapke invite link se <b>${escapeHtml(user.firstName)}</b> ne bot join &amp; verify kar liya hai!\n\n` +
            `💎 <b>Reward:</b> <code>+2 Points</code>\n` +
            `💰 <b>Kul Balance:</b> <b>${referrer.points} Points</b>\n` +
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
      user.points += wonPoints;
      user.lastSpin = now;
      logActivity("spin_win", `User ${user.firstName} (ID: ${user.id}) won ${wonPoints} points on Spin & Win.`);

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

      user.points += 1;
      user.lastCheckin = now;
      logActivity("checkin", `User ${user.firstName} received +1 daily point.`);

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

    // User: 🎁 Secret Gift Code
    bot.hears([/Secret Gift/i, /Gift Code/i], async (ctx) => {
      const kb = new InlineKeyboard()
        .url("📢 Official Channels", formatTelegramUrl(dynamicChannels[0]?.link || SUPPORT_URL)).row()
        .url("📞 Customer Support", SUPPORT_URL);

      await ctx.reply(
        `🎁 ━━━━━━━━━━━━━━━━━━\n` +
        `✨ <b>SECRET VIP GIFT DROPS</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🚀 <b>Grand Tournament Drops Coming Soon!</b>\n\n` +
        `VIP Secret Gift Codes hamare official Telegram channels aur live tournament matches ke dauran drop kiye jayenge.\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📢 <i>Channels par active rahein aur notifications ON rakhein!</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // User: 🎫 Redeem Code Prompt
    bot.hears([/Redeem Code/i, /Promo Code/i], async (ctx) => {
      userStates.set(String(ctx.from.id), { action: "awaiting_redeem_code" });
      await ctx.reply(
        `🎫 ━━━━━━━━━━━━━━━━━━\n` +
        `🎟 <b>ENTER PROMO CODE</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Apna Secret Promo / Gift Code yahan chat mein type karke bhejein:\n\n` +
        `📌 <i>Try Demo Code:</i> <code>EIPLFREE120</code>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `❌ <i>Cancel karne ke liye /cancel type karein.</i>`,
        { parse_mode: "HTML" }
      );
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
        `📢 <b>Active Channels:</b> <code>${dynamicChannels.length}</code>\n` +
        `🎟 <b>Promo Codes:</b> <code>${redeemCodes.size}</code>\n` +
        `💸 <b>Withdrawals:</b> <b>${withdrawalsEnabled ? "🟢 ENABLED" : "🔴 PAUSED"}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>Neeche diye gaye admin keyboard se action chunein:</i>`,
        { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
      );
    });

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
        const codeInput = text.toUpperCase();

        const codeObj = redeemCodes.get(codeInput);
        if (!codeObj) {
          return ctx.reply(`❌ <b>Galat Code!</b> Code <code>${escapeHtml(codeInput)}</code> exist nahi karta.`, {
            parse_mode: "HTML",
            reply_markup: getMainReplyKeyboard(ctx.from.id)
          });
        }
        if (codeObj.usedBy.has(userId)) {
          return ctx.reply(`⚠️ <b>Aap pehle hi yeh code redeem kar chuke hain!</b>`, {
            parse_mode: "HTML",
            reply_markup: getMainReplyKeyboard(ctx.from.id)
          });
        }
        if (codeObj.usedBy.size >= codeObj.maxUses) {
          return ctx.reply(`⚠️ <b>Yeh code ki maximum limit poori ho chuki hai!</b>`, {
            parse_mode: "HTML",
            reply_markup: getMainReplyKeyboard(ctx.from.id)
          });
        }

        codeObj.usedBy.add(userId);
        user.points += codeObj.points;
        logActivity("code_redeemed", `User ${user.firstName} redeemed ${codeInput} for +${codeObj.points} pts.`);

        return ctx.reply(
          `🎉 ━━━━━━━━━━━━━━━━━━\n` +
          `🎫 <b>CODE REDEEMED SUCCESSFULLY!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>Reward:</b> <code>+${codeObj.points} Points</code>\n` +
          `💰 <b>Naya Total Balance:</b> <b>${user.points} Points</b>\n` +
          `━━━━━━━━━━━━━━━━━━`,
          { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
        );
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

        redeemCodes.set(cCode, {
          code: cCode,
          points: cPts,
          maxUses: cMax,
          usedBy: new Set(),
          createdAt: new Date().toISOString()
        });
        logActivity("admin_create_code", `Created code: ${cCode}`);
        return ctx.reply(
          `✅ ━━━━━━━━━━━━━━━━━━\n` +
          `🎟 <b>PROMO CODE CREATED!</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🔹 <b>Code:</b> <code>${escapeHtml(cCode)}</code>\n` +
          `🔹 <b>Points:</b> <code>+${cPts}</code>\n` +
          `🔹 <b>Max Uses:</b> <code>${cMax}</code>`,
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
    });

    // Start Polling Safely
    bot
      .start({
        onStart(info) {
          botStatus.isPolling = true;
          botStatus.username = info.username;
          botStatus.error = null;
          console.log(`[Telegram Bot] Polling started live as @${info.username} (ID: ${info.id})`);
          logActivity("bot_online", `@${info.username} is online and polling updates.`);
        }
      })
      .catch((err) => {
        console.error("[Telegram Bot Polling Error]:", err.message);
        botStatus.isPolling = false;
        botStatus.error = err.message;
      });
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

        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin: 1rem 0; }
        .stat-card { background: #0a101d; border: 1px solid #1e293b; border-radius: 12px; padding: 0.75rem; text-align: center; }
        .stat-num { font-size: 1.3rem; font-weight: bold; color: #f59e0b; }
        .stat-label { font-size: 0.72rem; color: #94a3b8; text-transform: uppercase; }
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
        <p style="margin: 0 0 1rem 0; font-size: 0.88rem; color: #94a3b8;">Vibrant Colors • Spin & Win • Top 10 Leaderboard • Hot Offers • Admin Point Controls</p>
        
        <div>
          Status: 
          ${
            botStatus.isPolling
              ? `<span class="badge badge-green">🟢 Live Polling (@${botStatus.username})</span>`
              : `<span class="badge badge-amber">🟡 Standby (Waiting for BOT_TOKEN)</span>`
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
            <div class="feature-title">🎰 Spin & Win Wheel</div>
            <div>24h cooldown, animated reels, random +1 to 10 points reward.</div>
          </div>
          <div class="feature-card">
            <div class="feature-title">🏆 Top 10 Leaderboard</div>
            <div>Dynamic rankings by points & referrals + user position.</div>
          </div>
          <div class="feature-card">
            <div class="feature-title">🔥 Hot Referral Offers</div>
            <div>10 refs = ₹10 cash bonus | 50 refs = ₹100 cash bonus.</div>
          </div>
          <div class="feature-card">
            <div class="feature-title">💳 Admin Point Management</div>
            <div>Add or deduct points for any user ID directly in Telegram.</div>
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
            <div class="stat-num">${dynamicChannels.length}</div>
            <div class="stat-label">Channels</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${redeemCodes.size}</div>
            <div class="stat-label">Codes</div>
          </div>
        </div>

        <div class="section-title">⚡ Environment Secrets:</div>
        <ul>
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
