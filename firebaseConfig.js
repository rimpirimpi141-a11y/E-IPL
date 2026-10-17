/**
 * Firebase Realtime Database Configuration & Data Access Layer
 * Supports FIREBASE_CONFIG (JSON credentials) & FIREBASE_DATABASE_URL
 */

const admin = require("firebase-admin");
const fs = require("fs");
require("dotenv").config();

const DEFAULT_DB_URL = "https://eiplnewbot-e6d21-default-rtdb.asia-southeast1.firebasedatabase.app";
const DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || DEFAULT_DB_URL).trim();

let db = null;
let isInitialized = false;

// 31 Restored User Records from Provided CSV Data
const SEED_USERS = {
  "8838351233": { "firstName": "𝗔𝗮𝗱𝗶𝘁𝘆𝗮", "lastName": "𝗢𝗽", "username": "@Aaditya334356", "points": 15, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-14T11:08:13.434Z", "verified": true },
  "8670903515": { "firstName": "𝗔𝗮𝗱𝗶𝘁𝘆𝗮'𝘀", "lastName": "𝗗𝗲𝘃𝗲𝗹𝗽𝗼𝗲𝗿", "username": "@Aaditya334357", "points": 2, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-14T11:09:52.814Z", "verified": true },
  "8836958761": { "firstName": "Prince", "lastName": "Kumar Gupta", "username": "", "points": 0, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-14T11:33:41.218Z", "verified": false },
  "7403193890": { "firstName": "Pritam", "lastName": "Power", "username": "@Pritam_power", "points": 0, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-14T12:13:38.518Z", "verified": true },
  "7754675562": { "firstName": "Aman", "lastName": "", "username": "@Asgamify", "points": 8, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-14T13:45:15.825Z", "verified": true },
  "8149973752": { "firstName": "Rohit", "lastName": "Kushwaha J", "username": "", "points": 6, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-14T14:04:33.017Z", "verified": true },
  "8997135033": { "firstName": "Vimal", "lastName": "Kumari", "username": "", "points": 1, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-14T14:05:11.418Z", "verified": true },
  "8303378629": { "firstName": "Yakuzamasschatte", "lastName": "", "username": "", "points": 2, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-14T17:18:29.742Z", "verified": true },
  "8491504991": { "firstName": "Rakesh", "lastName": "Maurya", "username": "", "points": 1, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T00:13:43.476Z", "verified": true },
  "8608240254": { "firstName": "H", "lastName": "", "username": "", "points": 1, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T00:35:23.570Z", "verified": true },
  "8722584693": { "firstName": "Maurya", "lastName": "", "username": "", "points": 1, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T00:35:54.702Z", "verified": true },
  "6821078437": { "firstName": "Bam Bhola", "lastName": "Bihrri", "username": "", "points": 11, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T00:36:28.477Z", "verified": true },
  "8451189247": { "firstName": "ᏕᏒ_ᎶᏗᎷᏋᏒ96𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭𑲭", "lastName": "", "username": "@SRGAMER96", "points": 11, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T01:52:57.564Z", "verified": true },
  "8624972151": { "firstName": "Manoranjan", "lastName": "Manoranjan", "username": "", "points": 1, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T02:20:36.912Z", "verified": true },
  "8084226994": { "firstName": "Manoranjan Maurya", "lastName": "Manoranjan Maurya", "username": "", "points": 1, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T02:22:46.256Z", "verified": true },
  "8963682685": { "firstName": "Kk", "lastName": "Bhai", "username": "@Sonuiop95093", "points": 0, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T03:10:13.099Z", "verified": false },
  "8962179432": { "firstName": "SOOO", "lastName": "", "username": "@deargmail", "points": 0, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T03:55:27.661Z", "verified": true },
  "8612818277": { "firstName": "Simmi🖤", "lastName": "", "username": "", "points": 0, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T03:57:51.331Z", "verified": true },
  "8993905274": { "firstName": "DEMON", "lastName": "", "username": "@alwaysreadyhu", "points": 0, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T04:00:47.830Z", "verified": true },
  "8563422347": { "firstName": "Aura", "lastName": "Farmers", "username": "@AuraXFarmer", "points": 0, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T04:39:07.230Z", "verified": false },
  "8711559817": { "firstName": "JAFAR 💌", "lastName": "", "username": "@JAFARHU1", "points": 4, "referrals": 2, "referrerId": null, "joinedDate": "2026-10-15T04:58:45.406Z", "verified": true },
  "8995173118": { "firstName": "Niraj Kumar", "lastName": "Maurya", "username": "", "points": 1, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T04:58:48.967Z", "verified": true },
  "6748308829": { "firstName": "亗 KING 亗 🃏", "lastName": "", "username": "@Kinghu112", "points": 0, "referrals": 0, "referrerId": "8711559817", "joinedDate": "2026-10-15T04:59:37.699Z", "verified": true },
  "8904732353": { "firstName": "User", "lastName": "", "username": "", "points": 0, "referrals": 0, "referrerId": "8711559817", "joinedDate": "2026-10-15T05:00:02.492Z", "verified": true },
  "8815323199": { "firstName": "Akm", "lastName": "G", "username": "", "points": 3, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T06:04:30.055Z", "verified": true },
  "8340624175": { "firstName": "Sudhanshu", "lastName": "", "username": "@DevilxAerus", "points": 0, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T06:17:42.068Z", "verified": false },
  "8397790750": { "firstName": "亗 𝙉𝙄𝙂𝙃𝙏𝙈𝘼𝙍𝙀 亗", "lastName": "", "username": "@godhubhaiyaar", "points": 13, "referrals": 3, "referrerId": null, "joinedDate": "2026-10-15T06:20:56.664Z", "verified": true },
  "6499938028": { "firstName": "☠️", "lastName": "💀", "username": "@x9q_7pz_k2", "points": 0, "referrals": 0, "referrerId": "8397790750", "joinedDate": "2026-10-15T06:22:38.623Z", "verified": true },
  "8948009298": { "firstName": "PERMA OFF KOI MSG MT KRNA 🙂👍", "lastName": "", "username": "@ubgodhu", "points": 0, "referrals": 0, "referrerId": "8397790750", "joinedDate": "2026-10-15T06:23:45.677Z", "verified": true },
  "5642942317": { "firstName": "༒︎♛ 𝑷𝑹𝑰𝑴𝑬 ♛༒︎", "lastName": "", "username": "@kidzhuyaar", "points": 0, "referrals": 0, "referrerId": "8397790750", "joinedDate": "2026-10-15T06:25:39.773Z", "verified": true },
  "8898620137": { "firstName": "SANJAY", "lastName": "", "username": "@AkUTOSAITOP1", "points": 7, "referrals": 0, "referrerId": null, "joinedDate": "2026-10-15T06:56:40.798Z", "verified": true }
};

// 5 Active Unique Promo Codes (Points Strictly Under / Equal to 10 points: range 2 to 10 points)
const DEFAULT_PROMO_CODES = {
  "EIPLBONUS": {
    code: "EIPLBONUS",
    points: 9,
    maxUses: 1000,
    active: true,
    description: "eIPL Special VIP Bonus Drop",
    createdAt: "2026-10-17T00:00:00.000Z",
    usedBy: {}
  },
  "LUCKY7": {
    code: "LUCKY7",
    points: 7,
    maxUses: 500,
    active: true,
    description: "Lucky 7 Exclusive Gift Code",
    createdAt: "2026-10-17T00:00:00.000Z",
    usedBy: {}
  },
  "WELCOME5": {
    code: "WELCOME5",
    points: 5,
    maxUses: 2000,
    active: true,
    description: "Welcome Free Starter Points",
    createdAt: "2026-10-17T00:00:00.000Z",
    usedBy: {}
  },
  "SPINWIN3": {
    code: "SPINWIN3",
    points: 3,
    maxUses: 1000,
    active: true,
    description: "Spin & Win Extra Points Drop",
    createdAt: "2026-10-17T00:00:00.000Z",
    usedBy: {}
  },
  "SUPER10": {
    code: "SUPER10",
    points: 10,
    maxUses: 500,
    active: true,
    description: "Super 10 Mega VIP Drop",
    createdAt: "2026-10-17T00:00:00.000Z",
    usedBy: {}
  }
};

/**
 * Parses FIREBASE_CONFIG from various formats (raw JSON string, base64, file path, or object)
 */
function parseFirebaseCredentials() {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw || typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();

  // 1. Check if it points to an existing file
  if (fs.existsSync(trimmed)) {
    try {
      const fileData = fs.readFileSync(trimmed, "utf8");
      return JSON.parse(fileData);
    } catch (e) {
      console.error("[FirebaseConfig] Failed to read credentials file:", e.message);
    }
  }

  // 2. Direct JSON string
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.private_key && typeof parsed.private_key === "string") {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      return parsed;
    } catch (e) {
      console.error("[FirebaseConfig] Failed to parse JSON from FIREBASE_CONFIG:", e.message);
    }
  }

  // 3. Base64 encoded JSON
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.startsWith("{") && decoded.endsWith("}")) {
      const parsed = JSON.parse(decoded);
      if (parsed.private_key && typeof parsed.private_key === "string") {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      return parsed;
    }
  } catch (_) {
    // Not base64
  }

  return null;
}

/**
 * Initializes firebase-admin and returns Realtime Database instance
 */
function initFirebase() {
  if (isInitialized && db) {
    return db;
  }

  const serviceAccount = parseFirebaseCredentials();

  if (!serviceAccount) {
    console.warn("⚠️  [Firebase Realtime Database] FIREBASE_CONFIG environment variable is not set or invalid.");
    console.warn("👉 To persist data permanently, add FIREBASE_CONFIG (service account JSON) and FIREBASE_DATABASE_URL to your environment.");
    return null;
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: DATABASE_URL
      });
      console.log(`[Firebase Realtime Database] Connected successfully to ${DATABASE_URL}`);
    }

    db = admin.database();
    isInitialized = true;
    return db;
  } catch (err) {
    console.error("[Firebase Realtime Database] Initialization error:", err.message);
    return null;
  }
}

function getDb() {
  if (!db) {
    initFirebase();
  }
  return db;
}

function isFirebaseReady() {
  return Boolean(db && isInitialized);
}

/**
 * Normalizes user record with uniform properties
 */
function normalizeUserRecord(userId, data) {
  const strId = String(userId);
  const now = Date.now();
  const joinedDate = data.joinedDate || data.joinedAt || new Date(now).toISOString();
  const joinedTs = data.joinedTimestamp || new Date(joinedDate).getTime() || now;
  const verifiedVal = data.verified !== undefined ? Boolean(data.verified) : (data.isVerified !== undefined ? Boolean(data.isVerified) : true);
  const refsVal = Number(data.referrals !== undefined ? data.referrals : (data.referralsCount !== undefined ? data.referralsCount : 0));

  return {
    id: strId,
    firstName: data.firstName || "User",
    lastName: data.lastName || "",
    username: data.username || "",
    points: Number(data.points || 0),
    referrals: refsVal,
    referralsCount: refsVal,
    referrerId: data.referrerId ? String(data.referrerId) : null,
    joinedDate: joinedDate,
    joinedAt: joinedDate,
    joinedTimestamp: joinedTs,
    verified: verifiedVal,
    isVerified: verifiedVal,
    lastCheckin: Number(data.lastCheckin || 0),
    lastSpin: Number(data.lastSpin || 0),
    redeemedCodes: data.redeemedCodes || {},
    referral_cash: {
      totalRefers: data.referral_cash?.totalRefers !== undefined ? Number(data.referral_cash.totalRefers) : refsVal,
      availableBalance: data.referral_cash?.availableBalance !== undefined ? Number(data.referral_cash.availableBalance) : refsVal,
      totalWithdrawn: Number(data.referral_cash?.totalWithdrawn || 0)
    }
  };
}

/**
 * Reads single user from Firebase RTDB: /users/{userId}
 */
async function getUser(userId) {
  const database = getDb();
  if (!database) return null;
  try {
    const snapshot = await database.ref(`users/${userId}`).once("value");
    if (!snapshot.exists()) return null;
    return normalizeUserRecord(userId, snapshot.val());
  } catch (err) {
    console.error(`[Firebase RTDB] Failed to read /users/${userId}:`, err.message);
    return null;
  }
}

/**
 * Writes/overwrites user in Firebase RTDB: /users/{userId}
 */
async function saveUser(userId, userData) {
  const database = getDb();
  if (!database) return false;
  try {
    const normalized = normalizeUserRecord(userId, userData);
    await database.ref(`users/${userId}`).set(normalized);
    return true;
  } catch (err) {
    console.error(`[Firebase RTDB] Failed to save /users/${userId}:`, err.message);
    return false;
  }
}

/**
 * Updates specific fields for user in Firebase RTDB: /users/{userId}
 */
async function updateUser(userId, updates) {
  const database = getDb();
  if (!database) return false;
  try {
    await database.ref(`users/${userId}`).update(updates);
    return true;
  } catch (err) {
    console.error(`[Firebase RTDB] Failed to update /users/${userId}:`, err.message);
    return false;
  }
}

/**
 * Atomically updates user points using Firebase RTDB transaction
 */
async function updateUserPoints(userId, delta) {
  const database = getDb();
  if (!database) return null;
  try {
    const pointsRef = database.ref(`users/${userId}/points`);
    const result = await pointsRef.transaction((currentPoints) => {
      const cur = Number(currentPoints || 0);
      return Math.max(0, cur + Number(delta));
    });
    return result.snapshot.val();
  } catch (err) {
    console.error(`[Firebase RTDB] Failed to update points for /users/${userId}:`, err.message);
    return null;
  }
}

/**
 * Fetches all users from Firebase RTDB: /users
 */
async function getAllUsers() {
  const database = getDb();
  if (!database) return null;
  try {
    const snapshot = await database.ref("users").once("value");
    if (!snapshot.exists()) return {};
    const val = snapshot.val();
    const result = {};
    for (const [uid, udata] of Object.entries(val)) {
      if (udata) {
        result[uid] = normalizeUserRecord(uid, udata);
      }
    }
    return result;
  } catch (err) {
    console.error("[Firebase RTDB] Failed to fetch all users:", err.message);
    return null;
  }
}

/**
 * Checks if Firebase RTDB /users is empty or missing any of the 31 seed records.
 * Restores and seeds missing records automatically.
 */
async function seedUsersIfEmpty(seedData = SEED_USERS) {
  const database = getDb();
  if (!database) return { seeded: 0, existing: 0 };

  try {
    console.log("[Firebase RTDB] Checking user records for automatic restoration...");
    const snapshot = await database.ref("users").once("value");
    const existingData = snapshot.exists() ? (snapshot.val() || {}) : {};

    const updates = {};
    let seededCount = 0;
    const existingCount = Object.keys(existingData).length;

    for (const [userId, record] of Object.entries(seedData)) {
      if (!existingData[userId]) {
        updates[`users/${userId}`] = normalizeUserRecord(userId, record);
        seededCount++;
      }
    }

    if (seededCount > 0) {
      await database.ref().update(updates);
      console.log(`[Firebase RTDB] ✅ Successfully restored and seeded ${seededCount} user records to Firebase!`);
    } else {
      console.log(`[Firebase RTDB] All ${existingCount} user records already present. No seed needed.`);
    }

    return { seeded: seededCount, existing: existingCount };
  } catch (err) {
    console.error("[Firebase RTDB] Error checking/seeding user records:", err.message);
    return { seeded: 0, existing: 0, error: err.message };
  }
}

/**
 * Subscribes to real-time updates at /users to keep internal memory cache synchronized
 */
function subscribeToUsers(onUpdate) {
  const database = getDb();
  if (!database) return null;

  try {
    const usersRef = database.ref("users");
    const listener = usersRef.on("value", (snapshot) => {
      const val = snapshot.exists() ? snapshot.val() : {};
      const normalizedMap = new Map();
      for (const [uid, udata] of Object.entries(val)) {
        if (udata) {
          normalizedMap.set(String(uid), normalizeUserRecord(uid, udata));
        }
      }
      if (typeof onUpdate === "function") {
        onUpdate(normalizedMap);
      }
    }, (error) => {
      console.error("[Firebase RTDB] Realtime listener error:", error.message);
    });

    return () => usersRef.off("value", listener);
  } catch (err) {
    console.error("[Firebase RTDB] Failed to attach realtime listener:", err.message);
    return null;
  }
}

/**
 * Fetches all promo codes from /promo_codes in Firebase RTDB
 */
async function getAllPromoCodes() {
  const database = getDb();
  if (!database) return null;
  try {
    const snap = await database.ref("promo_codes").once("value");
    return snap.exists() ? snap.val() : {};
  } catch (err) {
    console.error("[Firebase RTDB] Error fetching promo codes:", err.message);
    return null;
  }
}

/**
 * Seeds default promo codes into Firebase RTDB (/promo_codes/{code}) if missing
 */
async function seedPromoCodesIfEmpty(promoCodes = DEFAULT_PROMO_CODES) {
  const database = getDb();
  if (!database) return { seeded: 0, existing: 0 };

  try {
    console.log("[Firebase RTDB] Checking promo codes in database...");
    const snap = await database.ref("promo_codes").once("value");
    const existingCodes = snap.exists() ? (snap.val() || {}) : {};

    const updates = {};
    let seededCount = 0;
    const existingCount = Object.keys(existingCodes).length;

    for (const [codeKey, promoData] of Object.entries(promoCodes)) {
      if (!existingCodes[codeKey]) {
        updates[`promo_codes/${codeKey}`] = {
          code: promoData.code || codeKey,
          points: Number(promoData.points) || 5,
          maxUses: Number(promoData.maxUses) || 1000,
          active: promoData.active !== false,
          description: promoData.description || "",
          createdAt: promoData.createdAt || new Date().toISOString(),
          usedBy: promoData.usedBy || {}
        };
        seededCount++;
      }
    }

    if (seededCount > 0) {
      await database.ref().update(updates);
      console.log(`[Firebase RTDB] ✅ Successfully seeded ${seededCount} promo codes to /promo_codes!`);
    } else {
      console.log(`[Firebase RTDB] All ${existingCount} promo codes already present in database.`);
    }

    return { seeded: seededCount, existing: existingCount };
  } catch (err) {
    console.error("[Firebase RTDB] Error seeding promo codes:", err.message);
    return { seeded: 0, existing: 0, error: err.message };
  }
}

/**
 * Saves or updates a promo code in Firebase RTDB (/promo_codes/{code})
 */
async function savePromoCode(codeKey, promoData) {
  const database = getDb();
  if (!database) return false;
  try {
    const cleanKey = String(codeKey).toUpperCase().trim();
    await database.ref(`promo_codes/${cleanKey}`).set(promoData);
    return true;
  } catch (err) {
    console.error(`[Firebase RTDB] Error saving promo code ${codeKey}:`, err.message);
    return false;
  }
}

/**
 * Records promo code redemption atomically in Firebase RTDB
 */
async function recordPromoCodeRedemption(codeKey, userId) {
  const database = getDb();
  if (!database) return false;
  try {
    const cleanKey = String(codeKey).toUpperCase().trim();
    const strUserId = String(userId).trim();
    const now = Date.now();

    const updates = {};
    updates[`promo_codes/${cleanKey}/usedBy/${strUserId}`] = now;
    updates[`users/${strUserId}/redeemedCodes/${cleanKey}`] = now;

    await database.ref().update(updates);
    return true;
  } catch (err) {
    console.error(`[Firebase RTDB] Error recording code redemption:`, err.message);
    return false;
  }
}

/**
 * Subscribes to /promo_codes changes to sync state with Telegram bot memory
 */
function subscribeToPromoCodes(onUpdate) {
  const database = getDb();
  if (!database) return null;

  try {
    const ref = database.ref("promo_codes");
    const listener = ref.on("value", (snap) => {
      const val = snap.exists() ? snap.val() : {};
      if (typeof onUpdate === "function") {
        onUpdate(val);
      }
    }, (err) => {
      console.error("[Firebase RTDB] Promo codes listener error:", err.message);
    });

    return () => ref.off("value", listener);
  } catch (err) {
    console.error("[Firebase RTDB] Failed to attach promo codes listener:", err.message);
    return null;
  }
}

/**
 * Saves/creates a payout request under /payout_requests/{requestId}
 */
async function savePayoutRequest(requestId, requestData) {
  const database = getDb();
  if (!database) return false;
  try {
    const cleanId = String(requestId).trim();
    const payload = {
      requestId: cleanId,
      userId: String(requestData.userId),
      userName: String(requestData.userName || "User"),
      amount: Number(requestData.amount || 0),
      refersCount: Number(requestData.refersCount || 0),
      paymentDetails: String(requestData.paymentDetails || ""),
      status: requestData.status || "PENDING",
      timestamp: Number(requestData.timestamp || Date.now()),
      createdAt: requestData.createdAt || new Date().toISOString()
    };
    if (requestData.processedAt) payload.processedAt = requestData.processedAt;
    if (requestData.processedBy) payload.processedBy = requestData.processedBy;
    if (requestData.rejectionReason) payload.rejectionReason = requestData.rejectionReason;

    await database.ref(`payout_requests/${cleanId}`).set(payload);
    return true;
  } catch (err) {
    console.error(`[Firebase RTDB] Failed to save /payout_requests/${requestId}:`, err.message);
    return false;
  }
}

/**
 * Updates a payout request in /payout_requests/{requestId}
 */
async function updatePayoutRequest(requestId, updates) {
  const database = getDb();
  if (!database) return false;
  try {
    const cleanId = String(requestId).trim();
    await database.ref(`payout_requests/${cleanId}`).update(updates);
    return true;
  } catch (err) {
    console.error(`[Firebase RTDB] Failed to update /payout_requests/${requestId}:`, err.message);
    return false;
  }
}

/**
 * Reads all payout requests from Firebase RTDB: /payout_requests
 */
async function getAllPayoutRequests() {
  const database = getDb();
  if (!database) return {};
  try {
    const snap = await database.ref("payout_requests").once("value");
    if (!snap.exists()) return {};
    return snap.val() || {};
  } catch (err) {
    console.error("[Firebase RTDB] Failed to fetch /payout_requests:", err.message);
    return {};
  }
}

/**
 * Subscribes to /payout_requests changes to sync memory state
 */
function subscribeToPayoutRequests(onUpdate) {
  const database = getDb();
  if (!database) return null;
  try {
    const ref = database.ref("payout_requests");
    const listener = ref.on("value", (snap) => {
      const val = snap.exists() ? snap.val() : {};
      if (typeof onUpdate === "function") {
        onUpdate(val);
      }
    }, (err) => {
      console.error("[Firebase RTDB] Payout requests listener error:", err.message);
    });

    return () => ref.off("value", listener);
  } catch (err) {
    console.error("[Firebase RTDB] Failed to attach payout requests listener:", err.message);
    return null;
  }
}

/**
 * Updates user referral_cash in /users/{userId}/referral_cash
 */
async function updateUserReferralCash(userId, cashData) {
  const database = getDb();
  if (!database) return false;
  try {
    const cleanUid = String(userId).trim();
    await database.ref(`users/${cleanUid}/referral_cash`).update({
      totalRefers: Number(cashData.totalRefers || 0),
      availableBalance: Number(cashData.availableBalance || 0),
      totalWithdrawn: Number(cashData.totalWithdrawn || 0)
    });
    return true;
  } catch (err) {
    console.error(`[Firebase RTDB] Failed to update /users/${userId}/referral_cash:`, err.message);
    return false;
  }
}

module.exports = {
  admin,
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
};
