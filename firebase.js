const admin = require("firebase-admin");

if (!process.env.FIREBASE_CONFIG || !process.env.FIREBASE_DATABASE_URL) {
  console.warn("⚠️ Firebase credentials missing in environment variables!");
}

let serviceAccount;
try {
  if (process.env.FIREBASE_CONFIG) {
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
  }
} catch (err) {
  console.error("❌ Failed to parse FIREBASE_CONFIG JSON:", err.message);
}

if (!admin.apps.length && serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.apps.length ? admin.database() : null;

// Helper: Get user data
async function getUser(userId) {
  if (!db) return null;
  const snapshot = await db.ref(`users/${userId}`).once("value");
  return snapshot.val();
}

// Helper: Save / Update user data
async function saveUser(userId, data) {
  if (!db) return null;
  await db.ref(`users/${userId}`).update(data);
}

// Helper: Get all users (Leaderboard / Admin)
async function getAllUsers() {
  if (!db) return {};
  const snapshot = await db.ref("users").once("value");
  return snapshot.val() || {};
}

module.exports = { admin, db, getUser, saveUser, getAllUsers };
