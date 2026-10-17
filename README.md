# eIPL Official Telegram Bot 🏏

A high-performance Telegram automation bot built with [grammY](https://grammy.dev/) and powered by **Firebase Realtime Database** for persistent user data, points, referrals, daily check-ins, lucky spin rewards, and an admin dashboard.

---

## 🚀 Setting Up Firebase Realtime Database

### Step-by-Step Guide: How to Generate `FIREBASE_CONFIG` JSON

Follow these steps to obtain your Firebase service account credentials JSON:

1. **Open Firebase Console**:
   - Go to [Firebase Console](https://console.firebase.google.com/) and select your project (e.g. `eiplnewbot-e6d21`).
2. **Access Project Settings**:
   - Click the **Gear icon (⚙️)** in the left sidebar next to *Project Overview* and select **Project settings**.
3. **Navigate to Service Accounts**:
   - Click on the **Service accounts** tab in the top navigation bar.
4. **Generate Private Key**:
   - Make sure **Node.js** is selected in the code snippet view.
   - Click the blue button labeled **Generate new private key**.
   - Confirm by clicking **Generate key** in the confirmation popup.
5. **Download and Copy the JSON**:
   - A `.json` file (e.g., `serviceAccountKey.json`) will be downloaded to your computer.
   - Open this file in any text editor (VS Code, Notepad, etc.).
   - Copy the entire JSON content.
6. **Configure Environment Variables**:
   - Set `FIREBASE_CONFIG` as the entire JSON string (or paste it into your deployment platform's Secrets / Environment Variables panel).
   - Set `FIREBASE_DATABASE_URL`:
     ```env
     FIREBASE_DATABASE_URL=https://eiplnewbot-e6d21-default-rtdb.asia-southeast1.firebasedatabase.app
     ```

---

## ⚙️ Environment Variables

Create a `.env` file or set the following in your environment:

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram Bot API token obtained from [@BotFather](https://t.me/BotFather) |
| `ADMIN_ID_1` | Primary Telegram numeric User ID for admin panel access |
| `ADMIN_ID_2` | Secondary Telegram numeric User ID for admin panel access |
| `SUPPORT_LINK` | Support contact link or username (e.g., `https://t.me/eIPL_Support`) |
| `PORT` | Local web server port (default: `3000`) |
| `FIREBASE_DATABASE_URL` | Your Firebase Realtime Database URL |
| `FIREBASE_CONFIG` | Full JSON string of your Firebase service account credentials |

---

## 🛠 Features

- **Direct Firebase Realtime Database Sync**: Automatically persists user balances, points, check-in timestamps, spin cooldowns, and referrals at `/users/{userId}`.
- **Automatic CSV Data Seeding**: Automatically seeds and restores all existing registered users on startup if missing from the database.
- **Gift Code & Promo Code Redemption**: Instant point redemption system saved directly to Firebase (`/promo_codes/{code}` and `/users/{userId}/redeemedCodes`), with duplicate protection, limit verification, and celebratory notifications.
- **Real-time Synchronization**: Maintains an in-memory cache synchronized with Firebase live updates to eliminate memory wipe issues.
- **Error Handling**: Gracefully catches and ignores 403 Forbidden errors when users have blocked the bot, preventing crashes.
- **Single Polling Guard**: Ensures only one active polling instance runs to eliminate Telegram `409 Conflict` errors.
- **Colorful Interactive Buttons & Menus**: Native Telegram keyboard styling for Spin & Win, Roz ka Check-in, Referrals, Leaderboards, and Admin Panel.

---

## 🎁 Active Secret Gift Codes / Promo Codes

Users can claim these promo codes by tapping **🎁 Secret Gift Code** on the menu or by using `/gift <CODE>` or `/redeem <CODE>`:

| Promo Code | Reward Points | Usage Limit | Single-Use per User | Description |
|---|---|---|---|---|
| `EIPLBONUS` | **+9 Points** | 1,000 users | ✅ Yes | VIP Gift Bonus Drop |
| `LUCKY7` | **+7 Points** | 500 users | ✅ Yes | Lucky 7 Exclusive Reward |
| `WELCOME5` | **+5 Points** | 2,000 users | ✅ Yes | Welcome Starter Pack |
| `SPINWIN3` | **+3 Points** | 1,000 users | ✅ Yes | Spin & Win Booster Drop |
| `SUPER10` | **+10 Points** | 500 users | ✅ Yes | Super 10 Mega VIP Drop |

Admins can also dynamically generate additional codes anytime directly inside Telegram via the Admin Panel (**🎟 Create Redeem Code**).

---

## 👥 Cash Refer & Payout System (₹ Real Cash)

A dedicated, fraud-protected cash referral system with real-time stats and instant admin payout processing:

### User Dashboard: `👥 Refer & Earn (₹ Cash)`
- **🔗 My Referral Link**: Generates unique link + shows real-time stats:
  - Total Refers (verified accounts)
  - Pending ₹ (currently in review)
  - Earned & Paid ₹ (completed withdrawals)
  - Available ₹ Balance
- **📊 My Refers List**: Displays the last 5–10 referred users with join dates and verification statuses.
- **💸 Request Payout**:
  - **Rules**: Minimum payout ₹10 (10 refers). If 50+ refers, calculates a **Flat ₹100 Mega Bonus**!
  - **Payment Methods Supported**: UPI ID (`name@upi`), PhonePe, Paytm, Google Pay, QR link.
  - **Duplicate Prevention**: Strictly blocks multiple concurrent requests while one is still `PENDING`.
  - **Confirmation**: Generates a unique tracking `Request ID` (e.g. `PAY-123456-789`) and notifies both user and admins.
- **📜 Payout History**: Displays previous payout requests with statuses (`PENDING`, `PAID`, `REJECTED`), dates, and rejection reasons.

### Admin Controls: `💳 Manage Payouts` (in `/admin`)
- **📋 View Pending Payouts**: Review pending requests with User Name, Telegram ID, Total Refers, Amount, and Payment details.
- **✅ Approve & Paid**:
  - Marks request as `Completed` / `PAID` in Firebase RTDB (`/payout_requests/{requestId}`).
  - Automatically sends congratulatory DM to user: `"🎉 Aapka ₹{Amount} ka payout successfully bhej diya gaya hai! Transaction proof dekhne ke liye support se sampark karein."`
  - Updates user's `totalWithdrawn` in `/users/{userId}/referral_cash`.
- **❌ Reject & Refund Refers**:
  - Prompts admin with quick rejection reasons (or custom text).
  - Marks request as `REJECTED`, alerts the user with the exact reason via DM.
  - Automatically refunds the refers back to the user's available balance!
- **📥 Export Payouts CSV**: 1-click download of all payout requests in an Excel/Google Sheets compatible UTF-8 BOM CSV file.

### 🗄️ Firebase Realtime Database Schema
- `/payout_requests/{requestId}`:
  ```json
  {
    "requestId": "PAY-123456-789",
    "userId": "8838351233",
    "userName": "Aaditya Op",
    "amount": 10,
    "refersCount": 10,
    "paymentDetails": "aaditya@upi",
    "status": "PENDING",
    "timestamp": 1729160000000
  }
  ```
- `/users/{userId}/referral_cash`:
  ```json
  {
    "totalRefers": 15,
    "availableBalance": 5,
    "totalWithdrawn": 10
  }
  ```


