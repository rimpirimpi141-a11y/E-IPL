/**
 * eIPL Official Bot
 * Pure Node.js & CommonJS Telegram Bot Engine
 * Framework: grammY
 */

const { Bot, InlineKeyboard, Keyboard } = require("grammy");
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

// ==========================================
// 2. IN-MEMORY STORAGE & CACHE
// ==========================================
const users = new Map(); // userId -> { id, firstName, lastName, username, points, referrerId, isVerified, joinedAt, joinedTimestamp, lastCheckin, referralsCount }
const verifiedUsers = new Set(); // Persistent cache of verified user IDs to prevent re-prompting

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
// 3. KEYBOARDS & UI BUILDERS
// ==========================================

// Clean Main Reply Keyboard (with Admin Panel button for admins)
function getMainReplyKeyboard(userId) {
  const kb = new Keyboard()
    .text("⏰ Roz ka Check-in").text("💎 Point Balance").row()
    .text("🍀 Invite & Earn").text("🎯 Redeem Points").row()
    .text("🎁 Secret Gift Code").text("🎫 Redeem Code").row()
    .text("🏆 Customer Support");

  if (userId && isAdmin(userId)) {
    kb.row().text("⚙️ Admin Panel");
  }

  return kb.resized();
}

// Full Admin Bottom Reply Keyboard (Replaces menu when Admin clicks ⚙️ Admin Panel)
function getAdminReplyKeyboard() {
  return new Keyboard()
    .text("➕ Add Force Channel").text("📋 View/Remove Channels").row()
    .text("🎟 Create Redeem Code").text("👤 Add Admin").row()
    .text("👥 View Users List").text("📊 Bot Stats").row()
    .text("📢 Broadcast Msg").row()
    .text("🔙 Back to User Menu")
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
  kb.text("✅ Verify / Joined", "verify_channels_action");
  return kb;
}

function getForceJoinMessage() {
  const channelsList = dynamicChannels
    .map((c, i) => `${i + 1}. <b>${escapeHtml(c.name)}</b>`)
    .join("\n");

  return (
    `🏏 <b>Welcome to eIPL Official Bot!</b>\n\n` +
    `Kripya bot ke saare features aur daily rewards unlock karne ke liye <b>dono official channels</b> join karein:\n\n` +
    channelsList
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

      // 3. If user is in an active interactive prompt (e.g. promo code), allow through
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
          `🏏 <b>Namaste ${escapeHtml(from.first_name)}! eIPL Official Bot me aapka swagat hai!</b>\n\n` +
          `Aapka account verified hai. Neeche diye gaye menu se vikalp chunein:`,
          { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(from.id) }
        );
      }

      const refNote = user.referrerId ? `\n🎁 <b>Invite Link detected!</b> Verify hone par aapke inviter ko +2 Points milenge.\n` : "";

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
              isMember = true;
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
          text: "❌ Aapne dono channels join nahi kiye hain! Kripya pehle dono channels join karein.",
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
            `🎉 <b>Naya Referral Reward!</b>\n\n` +
            `Aapke invite link se <b>${escapeHtml(user.firstName)}</b> ne bot join &amp; verify kar liya hai!\n` +
            `💎 <b>+2 Points</b> aapke account me jud gaye hain!\n` +
            `💰 <b>Kul Balance:</b> ${referrer.points} Points`,
            { parse_mode: "HTML" }
          );
        } catch (e) {}
      }

      await ctx.answerCallbackQuery({ text: "✅ Channels Verified!" });
      await ctx.reply(
        `🎉 <b>Badhai Ho! Channels Verify Ho Chuke Hain.</b>\n\n` +
        `Ab aapka <b>eIPL Dashboard</b> unlock ho chuka hai:`,
        { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(from.id) }
      );
    }

    bot.callbackQuery("verify_channels_action", handleVerifyChannels);
    bot.callbackQuery("verify_membership", handleVerifyChannels);

    // ==========================================
    // USER ACTIONS & HANDLERS
    // ==========================================

    // User: ⏰ Roz ka Check-in (24h cooldown)
    bot.hears([/Roz ka Check-in/i, /Check-in/i], async (ctx) => {
      const user = getOrCreateUser(ctx.from);
      const now = Date.now();
      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const elapsed = now - user.lastCheckin;

      if (elapsed < COOLDOWN_MS) {
        const remainMs = COOLDOWN_MS - elapsed;
        const hrs = Math.floor(remainMs / (1000 * 60 * 60));
        const mins = Math.floor((remainMs % (1000 * 60 * 60)) / (1000 * 60));
        return ctx.reply(
          `⏳ <b>Aap aaj ka check-in pehle hi kar chuke hain!</b>\n\n` +
          `Agla check-in <b>${hrs} ghante ${mins} minute</b> baad uplabdh hoga.\n` +
          `💎 <b>Current Balance:</b> ${user.points} Points`,
          { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
        );
      }

      user.points += 1;
      user.lastCheckin = now;
      logActivity("checkin", `User ${user.firstName} received +1 daily point.`);

      await ctx.reply(
        `🎉 <b>Roz ka Check-in Safal!</b> ⏰\n\n` +
        `💎 <b>+1 Point</b> aapke account me credit ho gaya hai!\n` +
        `💰 <b>Aapka Kul Balance:</b> <b>${user.points} Points</b>\n\n` +
        `Kal dobara check-in karein aur daily bonus paayein!`,
        { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
      );
    });

    // User: 💎 Point Balance
    bot.hears([/Point Balance/i, /Balance/i], async (ctx) => {
      const user = getOrCreateUser(ctx.from);
      const joinStr = new Date(user.joinedAt).toLocaleDateString("en-IN");
      await ctx.reply(
        `💳 <b>═══ AAPKA DASHBOARD ═══</b> 💳\n\n` +
        `👤 <b>Naam:</b> ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName || "")}\n` +
        `🆔 <b>User ID:</b> <code>${escapeHtml(user.id)}</code>\n` +
        `💎 <b>Point Balance:</b> <b>${user.points} Points</b>\n` +
        `👥 <b>Total Referrals:</b> <b>${user.referralsCount} Users</b>\n` +
        `📅 <b>Joined:</b> ${joinStr}\n` +
        `🛡 <b>Status:</b> ${user.isVerified ? "✅ Verified Member" : "⚠️ Unverified"}`,
        { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
      );
    });

    // User: 🍀 Invite & Earn
    bot.hears([/Invite/i, /kamaayein/i], async (ctx) => {
      const user = getOrCreateUser(ctx.from);
      const botName = botStatus.username || "eipl_bot";
      const link = `https://t.me/${botName}?start=${user.id}`;
      
      const kb = new InlineKeyboard()
        .url("🚀 Share on Telegram", `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Join eIPL Official Bot for daily rewards!")}`)
        .row()
        .url("🏆 Customer Support", SUPPORT_URL);

      await ctx.reply(
        `🍀 <b>═══ INVITE &amp; EARN ═══</b> 🍀\n\n` +
        `Apne doston ko invite karein aur har verified join par paayein <b>+2 Points</b>!\n\n` +
        `👥 <b>Aapke Kul Referrals:</b> ${user.referralsCount}\n` +
        `🔗 <b>Aapka Invite Link:</b>\n<code>${link}</code>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // User: 🎯 Redeem Points (10-Day Lock Policy)
    bot.hears([/Redeem Points/i, /Redeem Point/i], async (ctx) => {
      const user = getOrCreateUser(ctx.from);
      const joinTime = user.joinedTimestamp || new Date(user.joinedAt).getTime() || Date.now();
      const LOCK_MS = 10 * 24 * 60 * 60 * 1000; // 10 days
      const elapsed = Date.now() - joinTime;

      if (elapsed < LOCK_MS) {
        const remainingMs = LOCK_MS - elapsed;
        const remainingDays = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));

        const kb = new InlineKeyboard().url("🏆 Customer Support", SUPPORT_URL);

        return ctx.reply(
          `⏳ <b>Redemption Locked!</b>\n` +
          `Aapka account review period mein hai. Rewards redeem karne ke liye <b>${remainingDays} din bache hain</b> (10-Day Lock Policy).\n\n` +
          `📊 <b>eIPL Reward Model Tiers:</b>\n` +
          `• <b>3 Daily Points</b> ➔ ₹5.27\n` +
          `• <b>7 Daily Points</b> ➔ ₹15.27\n` +
          `• <b>10 Daily Points</b> ➔ ₹25.27\n` +
          `• <b>20 Daily Points</b> ➔ ₹45.27\n` +
          `• <b>30 Daily Points</b> ➔ ₹65.27\n\n` +
          `💰 <b>Aapka Current Balance:</b> <b>${user.points} Points</b>`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      }

      const kb = new InlineKeyboard().url("💬 Claim Reward via Support", SUPPORT_URL);
      await ctx.reply(
        `🎉 <b>Redemption Unlocked!</b>\n\n` +
        `Aapka 10-day review period poora ho chuka hai!\n\n` +
        `📊 <b>eIPL Reward Model Tiers:</b>\n` +
        `• <b>3 Daily Points</b> ➔ ₹5.27\n` +
        `• <b>7 Daily Points</b> ➔ ₹15.27\n` +
        `• <b>10 Daily Points</b> ➔ ₹25.27\n` +
        `• <b>20 Daily Points</b> ➔ ₹45.27\n` +
        `• <b>30 Daily Points</b> ➔ ₹65.27\n\n` +
        `💰 <b>Aapka Current Balance:</b> <b>${user.points} Points</b>\n\n` +
        `Points ko UPI / Cash reward me transfer karwane ke liye Customer Support se contact karein:`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // User: 🎁 Secret Gift Code (Updated Copywriting)
    bot.hears([/Secret Gift/i, /Gift Code/i], async (ctx) => {
      const kb = new InlineKeyboard().url("🏆 Customer Support", SUPPORT_URL);
      await ctx.reply(
        `🚀 <b>Coming Soon!</b>\n\n` +
        `VIP Secret Gift Drops aur Grand Tournament Rewards jaldi live hone wale hain! Exclusive updates aur bonus info ke liye Customer Support se contact karein.`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // User: 🎫 Redeem Code Prompt
    bot.hears([/Redeem Code/i, /Promo Code/i], async (ctx) => {
      userStates.set(String(ctx.from.id), { action: "awaiting_redeem_code" });
      await ctx.reply(
        `🎫 <b>REDEEM CODE</b>\n\n` +
        `Kripya apna Promo Code yahan type karke bhejein (e.g. <code>EIPLFREE120</code>):\n\n` +
        `<i>(Cancel karne ke liye /cancel likhein)</i>`,
        { parse_mode: "HTML" }
      );
    });

    // User: 🏆 Customer Support
    bot.hears([/Customer Support/i, /Support/i], async (ctx) => {
      const kb = new InlineKeyboard().url("💬 Open Support Chat", SUPPORT_URL);
      await ctx.reply(
        `🏆 <b>CUSTOMER SUPPORT</b>\n\n` +
        `Kisi bhi samasya ya bonus reward ke liye support team se baat karein:\n\n` +
        `🔗 <b>Support Link:</b> <a href="${SUPPORT_URL}">${escapeHtml(RAW_SUPPORT_LINK)}</a>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ==========================================
    // ADMIN PANEL (REPLY KEYBOARD SWITCH)
    // ==========================================

    // Admin Panel Trigger -> Switches to Admin Keyboard
    bot.hears([/⚙️ Admin Panel/i, /Admin Panel/i, /^\/admin$/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) {
        return ctx.reply("⛔ <b>Access Denied:</b> Admin permissions required.", { parse_mode: "HTML" });
      }
      await ctx.reply(
        `🛡 <b>═══ eIPL BOT ADMIN CONTROL PANEL ═══</b> 🛡\n\n` +
        `Admin: <b>${escapeHtml(ctx.from.first_name)}</b> (ID: <code>${ctx.from.id}</code>)\n\n` +
        `Admin controls unlock ho chuke hain. Neeche diye gaye keyboard se option chunein:`,
        { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
      );
    });

    // Back to User Menu Trigger -> Switches back to User Keyboard
    bot.hears([/🔙 Back to User Menu/i, /Back to User Menu/i], async (ctx) => {
      await ctx.reply(
        `🏏 <b>Main User Dashboard</b>\n\nUser menu activate ho gaya hai:`,
        { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
      );
    });

    // Admin Action: ➕ Add Force Channel
    bot.hears([/➕ Add Force Channel/i, /Add Force Channel/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_channel_info" });
      await ctx.reply(
        `➕ <b>ADD FORCE CHANNEL</b>\n\n` +
        `Kripya channel ki details bhejein:\n` +
        `<code>CHANNEL_NAME | CHANNEL_ID | CHANNEL_LINK</code>\n\n` +
        `📌 <b>Examples:</b>\n` +
        `• <code>Pritam Looters | @saurabh_editz | https://t.me/saurabh_editz</code>\n` +
        `• <code>@smartmoneyboost2 | https://t.me/smartmoneyboost2</code>\n\n` +
        `<i>(Cancel karne ke liye /cancel type karein)</i>`,
        { parse_mode: "HTML" }
      );
    });

    // Admin Action: 📋 View/Remove Channels
    bot.hears([/📋 View\/Remove Channels/i, /View\/Remove Channels/i, /View Channels/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      const kb = new InlineKeyboard();
      if (dynamicChannels.length === 0) {
        return ctx.reply(
          `📢 <b>FORCE CHANNELS LIST:</b>\n\nAbhi koi active force channel nahi hai. Naya channel add karne ke liye <b>➕ Add Force Channel</b> button dabayein.`,
          { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
        );
      }

      let text = `📢 <b>ACTIVE FORCE CHANNELS (${dynamicChannels.length}):</b>\n\n`;
      dynamicChannels.forEach((ch, i) => {
        text += `🔹 <b>${i + 1}.</b> ${escapeHtml(ch.name)}\n   ID: <code>${escapeHtml(ch.id)}</code>\n   Link: ${escapeHtml(ch.link)}\n\n`;
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

      let text = `✅ Channel <b>${escapeHtml(removedName)}</b> removed.\n\n📢 <b>ACTIVE FORCE CHANNELS (${dynamicChannels.length}):</b>\n\n`;
      dynamicChannels.forEach((ch, i) => {
        text += `🔹 <b>${i + 1}.</b> ${escapeHtml(ch.name)}\n   ID: <code>${escapeHtml(ch.id)}</code>\n   Link: ${escapeHtml(ch.link)}\n\n`;
        kb.text(`❌ Remove ${ch.name}`, `del_ch_${i}`).row();
      });

      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
    });

    // Admin Action: 🎟 Create Redeem Code
    bot.hears([/🎟 Create Redeem Code/i, /Create Redeem Code/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_new_code" });
      await ctx.reply(
        `🎟 <b>CREATE REDEEM CODE</b>\n\n` +
        `Format: <code>CODE_NAME | POINTS | MAX_USES</code>\n\n` +
        `Example:\n<code>IPL50 | 50 | 100</code>`,
        { parse_mode: "HTML" }
      );
    });

    // Admin Action: 👤 Add Admin
    bot.hears([/👤 Add Admin/i, /Add Admin/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_admin_id" });
      await ctx.reply(
        `👤 <b>ADD ADMIN</b>\n\nSend numeric Telegram User ID (e.g. <code>123456789</code>).`,
        { parse_mode: "HTML" }
      );
    });

    // Admin Action: 👥 View Users List
    bot.hears([/👥 View Users List/i, /View Users List/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      const userList = Array.from(users.values());
      if (userList.length === 0) {
        return ctx.reply("ℹ️ Abhi koi user registered nahi hai.", { reply_markup: getAdminReplyKeyboard() });
      }

      let text = `👥 <b>REGISTERED USERS LIST (${userList.length} Total):</b>\n\n`;
      userList.slice(0, 40).forEach((u, i) => {
        const uname = u.username ? `@${u.username}` : "No Username";
        text += `${i + 1}. <b>${escapeHtml(u.firstName)}</b> (${escapeHtml(uname)})\n   ID: <code>${escapeHtml(u.id)}</code> | Points: <b>${u.points}</b>\n\n`;
      });

      if (userList.length > 40) {
        text += `<i>...aur ${userList.length - 40} users baaki hain</i>\n`;
      }

      await ctx.reply(text, { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
    });

    // Admin Action: 📊 Bot Stats
    bot.hears([/📊 Bot Stats/i, /Bot Stats/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");

      const userList = Array.from(users.values());
      const totalPoints = userList.reduce((s, u) => s + (u.points || 0), 0);
      const verified = userList.filter(u => u.isVerified).length;

      await ctx.reply(
        `📊 <b>═══ BOT STATISTICS ═══</b> 📊\n\n` +
        `👥 <b>Total Users:</b> ${userList.length}\n` +
        `✅ <b>Verified Users:</b> ${verified}\n` +
        `💎 <b>Total Points:</b> ${totalPoints}\n` +
        `📢 <b>Force Channels:</b> ${dynamicChannels.length}\n` +
        `🎟 <b>Active Promo Codes:</b> ${redeemCodes.size}\n` +
        `👤 <b>Admins Count:</b> ${admins.size}`,
        { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() }
      );
    });

    // Admin Action: 📢 Broadcast Msg
    bot.hears([/📢 Broadcast Msg/i, /Broadcast Msg/i, /Broadcast/i], async (ctx) => {
      if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Access Denied.");
      userStates.set(String(ctx.from.id), { action: "awaiting_broadcast" });
      await ctx.reply(
        `📢 <b>BROADCAST MESSAGE</b>\n\nType the announcement message to broadcast to all ${users.size} users.`,
        { parse_mode: "HTML" }
      );
    });

    // Command: /cancel
    bot.command("cancel", async (ctx) => {
      userStates.delete(String(ctx.from.id));
      await ctx.reply("❌ Action cancel kar diya gaya hai.", { reply_markup: getMainReplyKeyboard(ctx.from.id) });
    });

    // Text & Form Input Handler
    bot.on("message:text", async (ctx) => {
      const from = ctx.from;
      const userId = String(from.id);
      const text = ctx.message.text.trim();
      const state = userStates.get(userId);

      if (!state) return;

      if (state.action === "awaiting_redeem_code") {
        userStates.delete(userId);
        const user = getOrCreateUser(from);
        const codeInput = text.toUpperCase();

        const codeObj = redeemCodes.get(codeInput);
        if (!codeObj) {
          return ctx.reply(`❌ <b>Galat Code!</b> Code <code>${escapeHtml(codeInput)}</code> exist nahi karta.`, { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) });
        }
        if (codeObj.usedBy.has(userId)) {
          return ctx.reply(`⚠️ <b>Aap pehle hi yeh code redeem kar chuke hain!</b>`, { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) });
        }
        if (codeObj.usedBy.size >= codeObj.maxUses) {
          return ctx.reply(`⚠️ <b>Yeh code ki limit poori ho chuki hai!</b>`, { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) });
        }

        codeObj.usedBy.add(userId);
        user.points += codeObj.points;
        logActivity("code_redeemed", `User ${user.firstName} redeemed ${codeInput} for +${codeObj.points} pts.`);

        return ctx.reply(
          `🎉 <b>Badhaai Ho! Code Safaltapoorvak Redeem Hua!</b> 🎫\n\n` +
          `💎 <b>+${codeObj.points} Points</b> jud gaye hain!\n` +
          `💰 <b>Naya Balance:</b> <b>${user.points} Points</b>`,
          { parse_mode: "HTML", reply_markup: getMainReplyKeyboard(ctx.from.id) }
        );
      }

      if (state.action === "awaiting_channel_info" && isAdmin(userId)) {
        userStates.delete(userId);
        const parts = text.split("|").map(s => s.trim()).filter(Boolean);
        
        let chName = "";
        let chId = "";
        let chLink = "";

        if (parts.length >= 3) {
          chName = parts[0];
          chId = parts[1].startsWith("@") ? parts[1] : (parts[1].startsWith("-") ? parts[1] : `@${parts[1]}`);
          chLink = formatTelegramUrl(parts[2]);
        } else if (parts.length === 2) {
          chId = parts[0].startsWith("@") ? parts[0] : (parts[0].startsWith("-") ? parts[0] : `@${parts[0]}`);
          chName = chId;
          chLink = formatTelegramUrl(parts[1]);
        } else if (parts.length === 1) {
          chId = parts[0].startsWith("@") ? parts[0] : `@${parts[0]}`;
          chName = chId;
          chLink = formatTelegramUrl(chId);
        } else {
          return ctx.reply("❌ Invalid format! Please send <code>NAME | @CHANNEL_ID | LINK</code>.", { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
        }

        // Check if already exists
        const existing = dynamicChannels.find(c => c.id.toLowerCase() === chId.toLowerCase());
        if (existing) {
          existing.name = chName;
          existing.link = chLink;
          return ctx.reply(`✅ <b>Channel Updated:</b> <code>${escapeHtml(chId)}</code>`, { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
        }

        dynamicChannels.push({ id: chId, name: chName, link: chLink });
        logActivity("admin_add_channel", `Added channel: ${chId} (${chName})`);
        return ctx.reply(
          `✅ <b>Force Channel Added Successfully!</b>\n\n` +
          `🔹 <b>Name:</b> ${escapeHtml(chName)}\n` +
          `🔹 <b>ID:</b> <code>${escapeHtml(chId)}</code>\n` +
          `🔹 <b>Link:</b> ${escapeHtml(chLink)}`,
          { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard(), link_preview_options: { is_disabled: true } }
        );
      }

      if (state.action === "awaiting_new_code" && isAdmin(userId)) {
        userStates.delete(userId);
        const parts = text.split("|").map(s => s.trim());
        if (parts.length < 3) {
          return ctx.reply("❌ Invalid format! Please send <code>CODE | POINTS | MAX_USES</code>.", { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
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
        return ctx.reply(`✅ <b>Redeem Code Created:</b> <code>${escapeHtml(cCode)}</code> (+${cPts} pts, max ${cMax})`, { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
      }

      if (state.action === "awaiting_admin_id" && isAdmin(userId)) {
        userStates.delete(userId);
        const newId = text.replace(/[^0-9]/g, "");
        if (newId.length >= 5) {
          admins.add(newId);
          logActivity("admin_add", `New Admin: ${newId}`);
          return ctx.reply(`✅ <b>Admin ${escapeHtml(newId)} Added!</b>`, { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
        }
        return ctx.reply("❌ Invalid numeric User ID.", { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
      }

      if (state.action === "awaiting_broadcast" && isAdmin(userId)) {
        userStates.delete(userId);
        let sent = 0;
        for (const [targetId] of users) {
          try {
            await bot.api.sendMessage(targetId, `📢 <b>eIPL Announcement:</b>\n\n${escapeHtml(text)}`, { parse_mode: "HTML" });
            sent++;
            await new Promise(r => setTimeout(r, 40));
          } catch (e) {}
        }
        logActivity("broadcast", `Broadcast sent to ${sent} users.`);
        return ctx.reply(`📢 <b>Broadcast Sent to ${sent} users!</b>`, { parse_mode: "HTML", reply_markup: getAdminReplyKeyboard() });
      }
    });

    // Start Polling Safely
    bot.start({
      onStart(info) {
        botStatus.isPolling = true;
        botStatus.username = info.username;
        botStatus.error = null;
        console.log(`[Telegram Bot] Polling started live as @${info.username} (ID: ${info.id})`);
        logActivity("bot_online", `@${info.username} is online and polling updates.`);
      }
    }).catch((err) => {
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
// 5. LIGHTWEIGHT HTTP HEALTH & DASHBOARD
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
    return res.end(JSON.stringify({
      status: "ok",
      bot: botStatus.isPolling ? "online" : "waiting_token",
      username: botStatus.username || null,
      usersCount: users.size,
      uptime: process.uptime()
    }));
  }

  if (pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      botTokenConfigured: Boolean(BOT_TOKEN && BOT_TOKEN.length > 10),
      isPolling: botStatus.isPolling,
      username: botStatus.username,
      error: botStatus.error,
      admins: Array.from(admins),
      supportLink: SUPPORT_URL,
      usersCount: users.size,
      channelsCount: dynamicChannels.length,
      codesCount: redeemCodes.size,
      logs: activityLogs
    }));
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
        .container { max-width: 540px; margin: 0 auto; background: #111a2e; border: 1px solid #1e293b; border-radius: 24px; padding: 1.5rem; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
        h1 { margin: 0 0 0.25rem 0; font-size: 1.4rem; display: flex; align-items: center; gap: 0.5rem; color: #f8fafc; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 0.8rem; }
        .badge-green { background: #064e3b; color: #34d399; border: 1px solid #059669; }
        .badge-amber { background: #451a03; color: #fbbf24; border: 1px solid #d97706; }
        
        .keyboard-frame { background: #1e293b; border-radius: 20px; padding: 14px; margin: 1.5rem 0; border: 1px solid #334155; }
        .kb-title { font-size: 0.85rem; color: #94a3b8; font-weight: 700; text-transform: uppercase; margin-bottom: 10px; }
        .kb-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
        .kb-row.single { grid-template-columns: 1fr; }
        .kb-btn { display: flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid #475569; padding: 12px 10px; border-radius: 12px; font-weight: 600; font-size: 0.88rem; color: #ffffff; background: #334155; }
        .kb-btn.admin { background: #991b1b; border-color: #dc2626; color: #fecaca; }

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
        <p style="margin: 0 0 1rem 0; font-size: 0.88rem; color: #94a3b8;">Clean Reply Keyboard • Bottom Admin Deck • 10-Day Lock Policy</p>
        
        <div>
          Status: 
          ${botStatus.isPolling 
            ? `<span class="badge badge-green">🟢 Live Polling (@${botStatus.username})</span>` 
            : `<span class="badge badge-amber">🟡 Standby (Waiting for BOT_TOKEN)</span>`
          }
        </div>

        ${!botStatus.isPolling ? `
          <div class="notice-box">
            🔑 <strong>Secrets Configuration Required:</strong><br/>
            Please fill in your <strong>BOT_TOKEN</strong> in the Secrets panel. This dashboard automatically rechecks every 5 seconds.
          </div>
        ` : ''}

        <!-- User Keyboard Layout Preview -->
        <div class="keyboard-frame">
          <div class="kb-title">📱 User Reply Keyboard:</div>
          <div class="kb-row">
            <div class="kb-btn">⏰ Roz ka Check-in</div>
            <div class="kb-btn">💎 Point Balance</div>
          </div>
          <div class="kb-row">
            <div class="kb-btn">🍀 Invite & Earn</div>
            <div class="kb-btn">🎯 Redeem Points</div>
          </div>
          <div class="kb-row">
            <div class="kb-btn">🎁 Secret Gift Code</div>
            <div class="kb-btn">🎫 Redeem Code</div>
          </div>
          <div class="kb-row single">
            <div class="kb-btn">🏆 Customer Support</div>
          </div>
          <div class="kb-row single">
            <div class="kb-btn admin">⚙️ Admin Panel</div>
          </div>
        </div>

        <div class="grid">
          <div class="stat-card">
            <div class="stat-num">${users.size}</div>
            <div class="stat-label">Users</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${dynamicChannels.length}</div>
            <div class="stat-label">Force Channels</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${redeemCodes.size}</div>
            <div class="stat-label">Promo Codes</div>
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
