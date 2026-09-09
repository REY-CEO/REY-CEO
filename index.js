const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const crypto = require("crypto");
const TelegramBotApi = require("node-telegram-bot-api");
const TelegramBot = TelegramBotApi.default || TelegramBotApi;

const cfg = require("./config.js");
const axios = require("axios");
const chalk = require("chalk");
const FormData = require("form-data");
const cheerio = require("cheerio");
const os = require("os");

// ==================== BETABOTZ PAYMENT ====================
const { 
    createdQris, 
    cekStatus, 
    cancelTransaction, 
    toRupiah, 
    generateReffId,
    generateCustomOrderId,
    watchPaymentStatus
} = require("./lib/betabotz.js");

// ==================== AM V2 AUTO CREATE ====================
const AM_V2_API_BASE = "https://api.betabotz.eu.org";
const AM_V2_AKSES_KEY = "REYMARKETAKSKEY";

// ==================== AM V2 HELPER FUNCTIONS ====================
const generateRandomString = (length = 10) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(crypto.randomFillSync(new Uint8Array(length)))
        .map((x) => chars[x % chars.length])
        .join('');
};

const generateTempEmailV2 = () => {
    const prefix = generateRandomString(12);
    return {
        prefix: prefix,
        email: `${prefix}@akunlama.com`
    };
};

const getInboxListV2 = async (recipient) => {
    try {
        const response = await axios.get(`https://akunlama.com/api/v1/mail/list?recipient=${recipient}`);
        const messages = response.data;
        if (!Array.isArray(messages) || messages.length === 0) return [];
        
        return messages.map(item => ({
            region: item.storage.region,
            key: item.storage.key,
            timestamp: item.timestamp,
            sender: item.sender,
            subject: item.message.headers.subject,
            from: item.message.headers.from
        }));
    } catch {
        return [];
    }
};

const getInboxContentAndLinksV2 = async (region, key) => {
    try {
        const response = await axios.get(`https://akunlama.com/api/v1/mail/getHtml?region=${region}&key=${key}`);
        const html = response.data;
        
        if (!html || typeof html !== 'string') return { plainText: '', links: [] };
        
        const plainText = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        
        const links = [];
        const hrefRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
        let match;
        
        while ((match = hrefRegex.exec(html)) !== null) {
            links.push(match[1].replace(/&amp;/g, '&'));
        }
        
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        while ((match = urlRegex.exec(plainText)) !== null) {
            const cleanUrl = match[1].replace(/[,.)\]}]+$/, '');
            if (!links.includes(cleanUrl)) links.push(cleanUrl);
        }
        
        return { plainText, links };
    } catch {
        return { plainText: '', links: [] };
    }
};

const getInboxLinkV2 = (prefix) => `https://akunlama.com/inbox/${prefix}`;

// ==================== AM V2 PROSES 1 AKUN ====================
async function processOneAccountV2(accountNumber) {
    const tempEmail = generateTempEmailV2();
    const inboxLink = getInboxLinkV2(tempEmail.prefix);
    
    try {
        const magicResponse = await axios.post(`${AM_V2_API_BASE}/api/tools/am-magicLink`, {
            aksesKey: AM_V2_AKSES_KEY,
            email: tempEmail.email
        });

        if (!magicResponse.data?.status) throw new Error("Gagal kirim magic link");

        let rawUrl = null;
        const existingKeys = [];
        
        for (let retry = 0; retry < 40; retry++) {
            await sleep(5000);
            
            const inboxList = await getInboxListV2(tempEmail.prefix);
            if (inboxList.length === 0) continue;
            
            const newMessages = inboxList.filter(m => !existingKeys.includes(m.key));
            
            for (const msg of newMessages) {
                existingKeys.push(msg.key);
                const { links } = await getInboxContentAndLinksV2(msg.region, msg.key);
                
                rawUrl = links.find(l => 
                    /apple|verify|magic|auth|signin|link/i.test(l)
                );
                
                if (rawUrl) break;
            }
            
            if (rawUrl) break;
        }

        if (!rawUrl) throw new Error("Timeout: Magic link tidak ditemukan");

        const verifyResponse = await axios.post(`${AM_V2_API_BASE}/api/tools/am-verifyMagicLink`, {
            aksesKey: AM_V2_AKSES_KEY,
            email: tempEmail.email,
            rawUrl: rawUrl
        });

        if (!verifyResponse.data?.status) throw new Error("Gagal verifikasi magic link");

        const token = verifyResponse.data.result.token;

        const premiumResponse = await axios.post(`${AM_V2_API_BASE}/api/tools/am-purchasePremium`, {
            aksesKey: AM_V2_AKSES_KEY,
            email: tempEmail.email,
            token: token
        });

        if (!premiumResponse.data?.status) throw new Error("Gagal aktivasi premium");

        const { purchase } = premiumResponse.data.result;
        const expiryDate = new Date(purchase.expiryTimeMillis).toLocaleString("id-ID", { 
            timeZone: "Asia/Jakarta",
            day: '2-digit',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        return {
            success: true,
            number: accountNumber,
            email: tempEmail.email,
            inboxLink,
            expiryDate,
            magicLink: rawUrl,
            token: token
        };

    } catch (error) {
        return {
            success: false,
            number: accountNumber,
            email: tempEmail.email,
            inboxLink,
            error: error.message
        };
    }
}

// ==================== AM V2 BULK PROCESS ====================
async function processBulkV2(count, userId) {
    const results = [];
    let successCount = 0;
    let failedCount = 0;
    let tablesHtml = "";
    let limitUsed = 0;

    for (let i = 1; i <= count; i++) {
        try {
            const result = await processOneAccountV2(i);
            results.push(result);
            
            if (result.success) {
                successCount++;
                limitUsed++;
                logCreateAMSuccess({ id: userId, username: null }, 'AM V2', result.email);
                
                tablesHtml += `<h3>🎉 Akun ${i} dari ${count} Berhasil (V2)</h3>
<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Email</td><td><code>${result.email}</code></td></tr>
  <tr><td>Status</td><td>✅ Premium</td></tr>
  <tr><td>Expired</td><td>${result.expiryDate}</td></tr>
  <tr><td>Inbox Link</td><td><a href="${result.inboxLink}">${result.inboxLink}</a></td></tr>
  <tr><td>Magic Link</td><td><code>${result.magicLink || '-'}</code></td></tr>
</table>
<br/>`;

                if (!db.sessions) db.sessions = {};
                db.sessions[result.email] = {
                    email: result.email,
                    verifiedAt: new Date().toISOString(),
                    status: "verified",
                    link: result.magicLink,
                    loginUrl: result.inboxLink,
                    userId: String(userId),
                    method: 'AM V2'
                };
                saveDatabase();

            } else {
                failedCount++;
                logCreateAMFailed({ id: userId, username: null }, 'AM V2', result.error);
                tablesHtml += `<h3>❌ Akun ${i} dari ${count} Gagal (V2)</h3>
<p>Error: ${result.error}</p>
<hr/>`;
            }
        } catch (error) {
            failedCount++;
            tablesHtml += `<h3>❌ Akun ${i} dari ${count} Gagal (V2)</h3>
<p>Error: ${error.message}</p>
<hr/>`;
        }

        if (i < count) {
            await sleep(5000);
        }
    }

    for (let i = 0; i < successCount; i++) {
        deductUserLimit(userId, 1);
    }

    return {
        successCount,
        failedCount,
        limitUsed,
        tablesHtml,
        results
    };
}

// ==================== RENDER AM V2 RESULT ====================
function renderAMV2Result(count, successCount, failedCount, limitUsed, tablesHtml) {
    return `<h2>✅ AM V2 AUTO CREATE RESULT</h2>

<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>Total</td><td align="center">${count} Akun</td></tr>
  <tr><td>Berhasil</td><td align="center">${successCount} Akun</td></tr>
  <tr><td>Gagal</td><td align="center">${failedCount} Akun</td></tr>
  <tr><td>Limit Terpakai</td><td align="center"><b>${limitUsed}</b> Limit</td></tr>
</table>

<hr/>

${tablesHtml}

<hr/>
<h3>📘 Cara Login / Pakai</h3>
<ol>
  <li>Buka Magic Link atau Inbox Link di atas</li>
  <li>Klik link verifikasi dari email</li>
  <li>Pilih "Buka di Alight Motion" saat muncul pop up</li>
</ol>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@masreymarket</a> | All Rights Reserved</footer>`;
}

// ==================== PACKAGE CONFIG ====================
const DEFAULT_VVIP_PACKAGES = {
    '1': { name: "VVIP 1 Bulan", days: 30, price: 10000, emoji: '1️⃣' },
    '2': { name: "VVIP 3 Bulan", days: 90, price: 30000, emoji: '2️⃣' },
    '3': { name: "VVIP 6 Bulan", days: 180, price: 55000, emoji: '3️⃣' },
    '4': { name: "VVIP 1 Tahun", days: 365, price: 120000, emoji: '4️⃣' }
};

const DEFAULT_RENEW_PACKAGES = {
    '1': { name: "Perpanjang 1 Bulan", days: 30, price: 5000, emoji: '🔄' },
    '2': { name: "Perpanjang 3 Bulan", days: 90, price: 15000, emoji: '🔄' },
    '3': { name: "Perpanjang 6 Bulan", days: 180, price: 25000, emoji: '🔄' },
    '4': { name: "Perpanjang 1 Tahun", days: 365, price: 50000, emoji: '🔄' }
};

const DEFAULT_LIMIT_PACKAGES = {
    '1': { name: "Limit +10", days: 30, price: 5000, limit: 10, emoji: '📦' },
    '2': { name: "Limit +25", days: 30, price: 10000, limit: 25, emoji: '📦' },
    '3': { name: "Limit +50", days: 30, price: 15000, limit: 50, emoji: '📦' },
    '4': { name: "Limit +100", days: 30, price: 25000, limit: 100, emoji: '📦' }
};

// ==========================================================

const bot = new TelegramBot(cfg.botToken, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on("polling_error", (err) => {
  if (err.code === "EFATAL") return;
  console.error("[!] Polling Error:", err.code, err.message);
});

bot.on("error", (err) => {
  console.error("[!] Bot Error:", err.message);
});

process.on("unhandledRejection", (reason) => {
  if (!reason) return;
  const msg = reason?.message || String(reason);
  if (msg.includes("query is too old") || msg.includes("query ID is invalid")) return;
  if (msg.includes("EFATAL") || msg.includes("fetch failed") || msg.includes("ConnectTimeout")) return;
  console.error("[!] Unhandled Rejection:", msg);
});

process.on("uncaughtException", (err) => {
  console.error("[!] Uncaught Exception:", err.message);
});

const CHANNELS = Array.isArray(cfg.channels) ? cfg.channels : [];
const IMAGE_URL = "https://raw.githubusercontent.com/REY-CEO/REY-CEO/main/Image/1788837578030-image_1788837577944.jpg";

// ==================== LOG CHANNEL ====================
const LOG_CHANNEL_ID = -1003966553406;
const GROUP_CHANNEL_ID = -1004437868383;
const GROUP_LINK = "https://t.me/+YkGsEF2M1gw4NGU1";

// ==================== SYSTEM STATUS ====================
function getSystemStatus() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(1);
    
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model || 'Unknown';
    const cpuCores = cpus.length;
    
    let totalIdle = 0;
    let totalTick = 0;
    cpus.forEach(cpu => {
        for (let type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    });
    const cpuUsagePercent = ((1 - (totalIdle / totalTick)) * 100).toFixed(1);
    
    let diskTotal = 'N/A', diskUsed = 'N/A', diskAvail = 'N/A', diskUsage = 'N/A';
    try {
        const disk = execSync('df -h /').toString().split('\n')[1];
        const diskParts = disk?.split(/\s+/) || [];
        diskTotal = diskParts[1] || 'N/A';
        diskUsed = diskParts[2] || 'N/A';
        diskAvail = diskParts[3] || 'N/A';
        diskUsage = diskParts[4] || 'N/A';
    } catch (e) {}
    
    const uptime = process.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const runtimeStr = `${days}d ${hours}h ${minutes}m ${seconds}s`;
    
    return {
        ram: {
            total: formatBytes(totalMem),
            used: formatBytes(usedMem),
            free: formatBytes(freeMem),
            usage: memUsagePercent
        },
        cpu: {
            model: cpuModel,
            cores: cpuCores,
            usage: cpuUsagePercent
        },
        disk: {
            total: diskTotal,
            used: diskUsed,
            available: diskAvail,
            usage: diskUsage
        },
        runtime: runtimeStr,
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch()
    };
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== LOG FUNCTIONS ====================
async function sendActivationLog(userFrom, emailUsed, method) {
  try {
    const username = userFrom.username ? `@${userFrom.username}` : "-";
    const fullName = [userFrom.first_name, userFrom.last_name].filter(Boolean).join(" ") || "Unknown";
    const userId = userFrom.id;
    const timeNow = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    const logHtml = `<h2>🔐 LOG AKTIVASI AM PREMIUM</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>👤 Nama</td><td>${fullName}</td></tr>
  <tr><td>🔗 Username</td><td>${username}</td></tr>
  <tr><td>🆔 User ID</td><td><code>${userId}</code></td></tr>
  <tr><td>📧 Email</td><td><code>${emailUsed}</code></td></tr>
  <tr><td>⚙️ Metode</td><td>${method}</td></tr>
  <tr><td>🕐 Waktu</td><td>${timeNow} WIB</td></tr>
  <tr><td>✅ Status</td><td>Berhasil Aktivasi</td></tr>
</table>

<hr/>
<footer>ᴘᴏᴡᴇʀᴇᴅ ʙʏ <a href="https://t.me/masreymarket">@masreymarket</a></footer>`;

    await sendRichMessage(LOG_CHANNEL_ID, logHtml);
  } catch (e) {
    console.error("[!] Gagal kirim log aktivasi:", e.message);
  }
}

async function sendPurchaseLog(userId, session) {
  try {
    const userInfo = await bot.getChat(userId).catch(() => null);
    const username = userInfo?.username ? `@${userInfo.username}` : "-";
    const fullName = userInfo?.first_name ? [userInfo.first_name, userInfo.last_name].filter(Boolean).join(" ") || "Unknown" : "Unknown";
    const timeNow = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    let detailHtml = '';
    let title = '';

    if (session.type === 'vvip') {
      title = '👑 UPGRADE VVIP';
      const expiry = getVVIPExpiry(userId);
      const expiryDate = expiry ? new Date(expiry).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" }) : '-';
      detailHtml = `
  <tr><td>🎁 Paket</td><td>${session.packageData.name}</td></tr>
  <tr><td>📅 Masa Aktif</td><td>${session.packageData.days} Hari</td></tr>
  <tr><td>⏳ Berlaku Sampai</td><td>${expiryDate}</td></tr>
  <tr><td>👑 Status</td><td>✅ VVIP Active</td></tr>`;
    } else if (session.type === 'renew') {
      title = '🔄 PERPANJANG VVIP';
      const expiry = getVVIPExpiry(userId);
      const expiryDate = expiry ? new Date(expiry).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" }) : '-';
      detailHtml = `
  <tr><td>🔄 Perpanjangan</td><td>${session.packageData.name}</td></tr>
  <tr><td>📅 Tambahan</td><td>${session.packageData.days} Hari</td></tr>
  <tr><td>⏳ Berlaku Sampai</td><td>${expiryDate}</td></tr>
  <tr><td>👑 Status</td><td>✅ VVIP Diperpanjang</td></tr>`;
    } else if (session.type === 'limit') {
      title = '📦 PEMBELIAN LIMIT';
      const bonus = getUserBonusLimit(userId);
      const regular = getUserLimit(userId);
      detailHtml = `
  <tr><td>📦 Paket</td><td>${session.packageData.name}</td></tr>
  <tr><td>➕ Limit Tambahan</td><td>${session.packageData.limit} Limit</td></tr>
  <tr><td>📅 Berlaku</td><td>${session.packageData.days} Hari</td></tr>
  <tr><td>💎 Total Limit</td><td>${bonus + regular} Limit</td></tr>
  <tr><td>✅ Status</td><td>Limit Ditambahkan</td></tr>`;
    }

    const logHtml = `<h2>${title}</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>👤 Nama</td><td>${fullName}</td></tr>
  <tr><td>🔗 Username</td><td>${username}</td></tr>
  <tr><td>🆔 User ID</td><td><code>${userId}</code></td></tr>
  <tr><td>💰 Harga</td><td>${toRupiah(session.packageData.price)}</td></tr>
  <tr><td>🆔 Order ID</td><td><code>${session.customOrderId || session.orderId}</code></td></tr>
  <tr><td>🆔 Reff id</td><td><code>${session.realTransactionId || session.transactionId}</code></td></tr>
  <tr><td>🕐 Waktu</td><td>${timeNow} WIB</td></tr>
  ${detailHtml}
</table>

<hr/>
<footer>⚡ Powered by <a href="https://t.me/masreymarket">@masreymarket</a></footer>`;

    await sendRichMessage(LOG_CHANNEL_ID, logHtml);
  } catch (e) {
    console.error("[!] Gagal kirim log pembelian:", e.message);
  }
}

async function sendPaymentLog(userId, session) {
  try {
    const timeNow = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const logHtml = `<h2>💳 LOG PEMBAYARAN</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>👤 User ID</td><td><code>${userId}</code></td></tr>
  <tr><td>📦 Tipe</td><td>${session.type.toUpperCase()}</td></tr>
  <tr><td>📦 Paket</td><td>${session.packageData.name}</td></tr>
  <tr><td>💰 Harga</td><td>${toRupiah(session.packageData.price)}</td></tr>
  <tr><td>🆔 Order ID</td><td><code>${session.customOrderId || session.orderId}</code></td></tr>
  <tr><td>🆔 Reff id</td><td><code>${session.realTransactionId || session.transactionId}</code></td></tr>
  <tr><td>🕐 Waktu</td><td>${timeNow} WIB</td></tr>
  <tr><td>✅ Status</td><td>PAID - SUCCESS</td></tr>
</table>

<hr/>
<footer>⚡ Powered by <a href="https://t.me/masreymarket">@masreymarket</a></footer>`;

    await sendRichMessage(LOG_CHANNEL_ID, logHtml);
  } catch (e) {
    console.error("[!] Gagal kirim log payment:", e.message);
  }
}

// ==================== LOG AKTIVITAS USER ====================
function logUserActivity(userFrom, action, details = {}) {
    const timestamp = new Date().toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    const username = userFrom.username ? `@${userFrom.username}` : "-";
    const fullName = [userFrom.first_name, userFrom.last_name].filter(Boolean).join(" ") || "Unknown";
    const userId = userFrom.id;
    const chatType = userFrom.is_bot ? "Bot" : "User";

    const logMessage = `
${chalk.cyan('═══════════════════════════════════════════════════')}
${chalk.green('📋 [USER ACTIVITY LOG]')}
${chalk.cyan('───────────────────────────────────────────────────')}
${chalk.yellow('🕐 Waktu    :')} ${timestamp}
${chalk.yellow('👤 Nama     :')} ${fullName}
${chalk.yellow('🔗 Username :')} ${username}
${chalk.yellow('🆔 ID       :')} ${userId}
${chalk.yellow('📱 Tipe     :')} ${chatType}
${chalk.yellow('⚡ Aksi     :')} ${action}
${Object.keys(details).length > 0 ? chalk.yellow('📝 Detail   :') + '\n' + Object.entries(details).map(([key, value]) => `   ${chalk.blue(key)}: ${chalk.white(value)}`).join('\n') : ''}
${chalk.cyan('───────────────────────────────────────────────────')}
`;

    console.log(logMessage);
}

// ==================== DATABASE ====================
const DB_FOLDER = path.join(__dirname, "database");
if (!fs.existsSync(DB_FOLDER)) {
  fs.mkdirSync(DB_FOLDER, { recursive: true });
}

const DB_PATH = path.join(DB_FOLDER, "database.json");
const USERS_PATH = path.join(DB_FOLDER, "users.json");
const LIMIT_PATH = path.join(DB_FOLDER, "limit.json");
const BONUS_LIMIT_PATH = path.join(DB_FOLDER, "bonus_limit.json");
const MAINTENANCE_PATH = path.join(DB_FOLDER, "maintenance.json");
const BOT_PATH = path.join(DB_FOLDER, "bot.json");
const VVIP_PATH = path.join(DB_FOLDER, "vvip.json");
const PAYMENT_PATH = path.join(DB_FOLDER, "payment.json");
const USER_ACTIVITY_PATH = path.join(DB_FOLDER, "user_activity.json");

const DAILY_LIMIT = 5;
const MAX_LIMIT = 100;

let db = { sessions: {} };
let usersList = [];
let userLimits = {};
let bonusLimits = {};
let usernameMap = {};
let maintenance = { status: "off" };
let botOffState = { status: "off", scheduledOff: null, scheduledOffText: null };
let vvipData = {};
let paymentSessions = {};
let userActivity = {};

const userState = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HARDCODED_OWNERS = [8347420543];
const mainOwnerIds = Array.isArray(cfg.ownerId)
  ? [...HARDCODED_OWNERS, ...cfg.ownerId.map(Number)]
  : cfg.ownerId
  ? [...HARDCODED_OWNERS, Number(cfg.ownerId)]
  : HARDCODED_OWNERS;

function isMainOwner(senderId) {
  return mainOwnerIds.includes(Number(senderId));
}

function loadDatabase() {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!db.sessions) db.sessions = {};
    } else {
      db = { sessions: {} };
      saveDatabase();
    }
  } catch (error) {
    db = { sessions: {} };
  }
}

function saveDatabase() {
  try {
    if (!db.sessions) db.sessions = {};
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (error) {}
}

function loadUsersDatabase() {
  try {
    if (fs.existsSync(USERS_PATH)) {
      usersList = JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
    } else {
      usersList = [];
      saveUsersDatabase();
    }
  } catch (error) {
    usersList = [];
  }
}

function saveUsersDatabase() {
  try {
    fs.writeFileSync(USERS_PATH, JSON.stringify(usersList, null, 2));
  } catch (error) {}
}

function loadLimitDatabase() {
  try {
    if (fs.existsSync(LIMIT_PATH)) {
      userLimits = JSON.parse(fs.readFileSync(LIMIT_PATH, "utf8"));
    } else {
      userLimits = {};
      saveLimitDatabase();
    }
  } catch (error) {
    userLimits = {};
  }
}

function saveLimitDatabase() {
  try {
    fs.writeFileSync(LIMIT_PATH, JSON.stringify(userLimits, null, 2));
  } catch (error) {}
}

function loadBonusLimitDatabase() {
  try {
    if (fs.existsSync(BONUS_LIMIT_PATH)) {
      bonusLimits = JSON.parse(fs.readFileSync(BONUS_LIMIT_PATH, "utf8"));
    } else {
      bonusLimits = {};
      saveBonusLimitDatabase();
    }
  } catch (error) {
    bonusLimits = {};
  }
}

function saveBonusLimitDatabase() {
  try {
    fs.writeFileSync(BONUS_LIMIT_PATH, JSON.stringify(bonusLimits, null, 2));
  } catch (error) {}
}

function loadVVIPDatabase() {
  try {
    if (fs.existsSync(VVIP_PATH)) {
      vvipData = JSON.parse(fs.readFileSync(VVIP_PATH, "utf8"));
    } else {
      vvipData = {};
      saveVVIPDatabase();
    }
  } catch (error) {
    vvipData = {};
  }
}

function saveVVIPDatabase() {
  try {
    fs.writeFileSync(VVIP_PATH, JSON.stringify(vvipData, null, 2));
  } catch (error) {}
}

function loadPaymentDatabase() {
  try {
    if (fs.existsSync(PAYMENT_PATH)) {
      paymentSessions = JSON.parse(fs.readFileSync(PAYMENT_PATH, "utf8"));
    } else {
      paymentSessions = {};
      savePaymentDatabase();
    }
  } catch (error) {
    paymentSessions = {};
  }
}

function savePaymentDatabase() {
  try {
    fs.writeFileSync(PAYMENT_PATH, JSON.stringify(paymentSessions, null, 2));
  } catch (error) {}
}

function loadMaintenanceDatabase() {
  try {
    if (fs.existsSync(MAINTENANCE_PATH)) {
      maintenance = JSON.parse(fs.readFileSync(MAINTENANCE_PATH, "utf8"));
    } else {
      maintenance = { status: "off" };
      saveMaintenanceDatabase();
    }
  } catch (error) {
    maintenance = { status: "off" };
  }
}

function saveMaintenanceDatabase() {
  try {
    fs.writeFileSync(MAINTENANCE_PATH, JSON.stringify(maintenance, null, 2));
  } catch (error) {}
}

function loadBotDatabase() {
  try {
    if (fs.existsSync(BOT_PATH)) {
      botOffState = JSON.parse(fs.readFileSync(BOT_PATH, "utf8"));
    } else {
      botOffState = { status: "off", scheduledOff: null, scheduledOffText: null };
      saveBotDatabase();
    }
  } catch (error) {
    botOffState = { status: "off", scheduledOff: null, scheduledOffText: null };
  }
}

function saveBotDatabase() {
  try {
    fs.writeFileSync(BOT_PATH, JSON.stringify(botOffState, null, 2));
  } catch (error) {}
}

// ==================== USER ACTIVITY DATABASE ====================
function loadUserActivityDatabase() {
  try {
    if (fs.existsSync(USER_ACTIVITY_PATH)) {
      userActivity = JSON.parse(fs.readFileSync(USER_ACTIVITY_PATH, "utf8"));
    } else {
      userActivity = {};
      saveUserActivityDatabase();
    }
  } catch (error) {
    userActivity = {};
  }
}

function saveUserActivityDatabase() {
  try {
    fs.writeFileSync(USER_ACTIVITY_PATH, JSON.stringify(userActivity, null, 2));
  } catch (error) {}
}

function trackUserActivity(userId, username, action, details = {}) {
  const key = String(userId);
  const now = Date.now();
  
  if (!userActivity[key]) {
    userActivity[key] = {
      userId: userId,
      username: username || '-',
      firstSeen: now,
      lastSeen: now,
      totalActions: 0,
      actions: []
    };
  }
  
  userActivity[key].username = username || userActivity[key].username || '-';
  userActivity[key].lastSeen = now;
  userActivity[key].totalActions += 1;
  
  userActivity[key].actions.push({
    timestamp: now,
    action: action,
    details: details
  });
  
  if (userActivity[key].actions.length > 50) {
    userActivity[key].actions = userActivity[key].actions.slice(-50);
  }
  
  saveUserActivityDatabase();
}

function getUserActivity(userId = null) {
  if (userId) {
    return userActivity[String(userId)] || null;
  }
  return userActivity;
}

function formatUserActivity(userData) {
  const firstSeen = userData.firstSeen ? new Date(userData.firstSeen).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }) : '-';
  
  const lastSeen = userData.lastSeen ? new Date(userData.lastSeen).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }) : '-';
  
  let actionsHtml = '';
  const recentActions = userData.actions.slice(-10).reverse();
  if (recentActions.length > 0) {
    actionsHtml = '<details><summary><b>📋 Aktivitas Terakhir (10)</b></summary><br/>';
    actionsHtml += '<table bordered striped>';
    actionsHtml += '<tr><th>#</th><th>Waktu</th><th>Aksi</th></tr>';
    recentActions.forEach((act, i) => {
      const time = new Date(act.timestamp).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      });
      const detailText = Object.keys(act.details).length > 0 ? 
        ' (' + Object.entries(act.details).map(([k, v]) => `${k}: ${v}`).join(', ') + ')' : '';
      actionsHtml += `<tr><td>${i+1}</td><td>${time}</td><td>${act.action}${detailText}</td></tr>`;
    });
    actionsHtml += '</table></details>';
  } else {
    actionsHtml = '<p><i>Belum ada aktivitas</i></p>';
  }
  
  return {
    firstSeen,
    lastSeen,
    totalActions: userData.totalActions,
    actionsHtml
  };
}

// ==================== LOG FUNGSI KHUSUS ====================
function logStart(userFrom) {
    logUserActivity(userFrom, '🚀 /start - Membuka Bot', {
        'Status': 'Online',
        'Version': '3.0'
    });
    trackUserActivity(userFrom.id, userFrom.username, '/start', { version: '3.0' });
}

function logCreateAMSuccess(userFrom, method, email) {
    logUserActivity(userFrom, `✅ Create AM Success - ${method}`, {
        'Email': email,
        'Status': 'Berhasil'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Create AM - ${method}`, { email });
}

function logCreateAMFailed(userFrom, method, error) {
    logUserActivity(userFrom, `❌ Create AM Failed - ${method}`, {
        'Error': error,
        'Status': 'Gagal'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Create AM Failed - ${method}`, { error });
}

function logPayment(userFrom, type, packageName, amount) {
    logUserActivity(userFrom, `💳 Payment - ${type}`, {
        'Paket': packageName,
        'Harga': toRupiah(amount),
        'Status': 'Pending'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Payment - ${type}`, { packageName, amount });
}

function logPaymentSuccess(userFrom, type, packageName, transactionId) {
    logUserActivity(userFrom, `✅ Payment Success - ${type}`, {
        'Paket': packageName,
        'Transaction ID': transactionId,
        'Status': 'Lunas'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Payment Success - ${type}`, { packageName, transactionId });
}

function logStoreAccess(userFrom, action) {
    logUserActivity(userFrom, `🛒 Store - ${action}`, {
        'Menu': 'Store'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Store - ${action}`, {});
}

function logHistoryView(userFrom, page = 1) {
    logUserActivity(userFrom, `📋 Lihat Riwayat`, {
        'Halaman': page
    });
    trackUserActivity(userFrom.id, userFrom.username, `Lihat Riwayat`, { page });
}

function logBulkCreate(userFrom, count) {
    logUserActivity(userFrom, `📦 Bulk Create AM`, {
        'Jumlah': count,
        'Status': 'Memproses'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Bulk Create AM`, { count });
}

function logBulkCreateResult(userFrom, count, success, failed) {
    logUserActivity(userFrom, `📦 Bulk Create AM Result`, {
        'Total': count,
        'Berhasil': success,
        'Gagal': failed
    });
    trackUserActivity(userFrom.id, userFrom.username, `Bulk Create AM Result`, { count, success, failed });
}

function logCustomGmail(userFrom, email) {
    logUserActivity(userFrom, `📧 Custom Gmail`, {
        'Email': email,
        'Status': 'Menunggu Verifikasi'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Custom Gmail - Kirim Link`, { email });
}

function logCustomGmailSuccess(userFrom, email) {
    logUserActivity(userFrom, `✅ Custom Gmail Success`, {
        'Email': email,
        'Status': 'Terverifikasi'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Custom Gmail - Verifikasi Berhasil`, { email });
}

function logMaintenance(userFrom, action) {
    logUserActivity(userFrom, `🔧 Maintenance - ${action}`, {
        'Status': action === 'on' ? 'ON' : 'OFF'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Maintenance - ${action}`, {});
}

function logBotControl(userFrom, action, schedule = null) {
    const details = {
        'Aksi': action
    };
    if (schedule) details['Jadwal'] = schedule;
    logUserActivity(userFrom, `🤖 Bot Control - ${action}`, details);
    trackUserActivity(userFrom.id, userFrom.username, `Bot Control - ${action}`, { schedule });
}

function logBroadcast(userFrom, totalUser, success, failed) {
    logUserActivity(userFrom, `📢 Broadcast`, {
        'Total User': totalUser,
        'Berhasil': success,
        'Gagal': failed
    });
    trackUserActivity(userFrom.id, userFrom.username, `Broadcast`, { totalUser, success, failed });
}

function logBackup(userFrom, type) {
    logUserActivity(userFrom, `💾 Backup - ${type}`, {
        'Status': 'Proses'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Backup - ${type}`, {});
}

function logSetLimit(userFrom, newLimit, totalUser) {
    logUserActivity(userFrom, `⚙️ Set Limit`, {
        'Limit Baru': newLimit,
        'Total User': totalUser
    });
    trackUserActivity(userFrom.id, userFrom.username, `Set Limit`, { newLimit, totalUser });
}

function logResetLimit(userFrom, totalUser) {
    logUserActivity(userFrom, `🔄 Reset Limit`, {
        'Total User': totalUser,
        'Limit Default': DAILY_LIMIT
    });
    trackUserActivity(userFrom.id, userFrom.username, `Reset Limit`, { totalUser });
}

function logAddLimit(userFrom, targetId, amount, duration) {
    logUserActivity(userFrom, `➕ Add Limit`, {
        'Target': targetId,
        'Jumlah': amount,
        'Durasi': duration + ' Hari'
    });
    trackUserActivity(userFrom.id, userFrom.username, `Add Limit`, { targetId, amount, duration });
}

function tickBonusLimit(userId) {
  const b = bonusLimits[userId];
  if (!b) return;
  const now = Date.now();
  if (b.expiresAt && now >= b.expiresAt) {
    delete bonusLimits[userId];
    saveBonusLimitDatabase();
    return;
  }
  const nowDate = new Date(now);
  const lastDate = new Date(b.lastReset);
  const sameDay = nowDate.getFullYear() === lastDate.getFullYear() &&
    nowDate.getMonth() === lastDate.getMonth() &&
    nowDate.getDate() === lastDate.getDate();
  if (!sameDay) {
    bonusLimits[userId].remaining = b.dailyLimit;
    bonusLimits[userId].lastReset = now;
    saveBonusLimitDatabase();
  }
}

function getUserBonusLimit(userId) {
  tickBonusLimit(userId);
  const b = bonusLimits[userId];
  if (!b) return 0;
  return b.remaining;
}

function deductBonusLimit(userId, count = 1) {
  tickBonusLimit(userId);
  const b = bonusLimits[userId];
  if (!b || b.remaining < count) return false;
  bonusLimits[userId].remaining -= count;
  saveBonusLimitDatabase();
  return true;
}

function getUserLimit(userId) {
  if (isMainOwner(userId)) return 9999;
  const now = Date.now();
  if (!userLimits[userId]) {
    userLimits[userId] = {
      limit: DAILY_LIMIT,
      lastReset: now
    };
    saveLimitDatabase();
  } else {
    const oneDay = 24 * 60 * 60 * 1000;
    if (now - userLimits[userId].lastReset >= oneDay) {
      userLimits[userId].limit = Math.min(userLimits[userId].limit + DAILY_LIMIT, MAX_LIMIT);
      userLimits[userId].lastReset = now;
      saveLimitDatabase();
    }
  }
  return userLimits[userId].limit;
}

function deductUserLimit(userId, count = 1) {
  if (isMainOwner(userId)) return true;
  const bonusRemaining = getUserBonusLimit(userId);
  if (bonusRemaining >= count) {
    return deductBonusLimit(userId, count);
  }
  const currentLimit = getUserLimit(userId);
  if (currentLimit >= count) {
    userLimits[userId].limit -= count;
    saveLimitDatabase();
    return true;
  }
  return false;
}

function getTotalUserLimit(userId) {
  if (isMainOwner(userId)) return 9999;
  const bonus = getUserBonusLimit(userId);
  const regular = getUserLimit(userId);
  return bonus + regular;
}

function registerUser(userId, username) {
  if (!usersList.includes(userId)) {
    usersList.push(userId);
    saveUsersDatabase();
  }
  if (username) {
    usernameMap[username.toLowerCase().replace(/^@/, "")] = userId;
  }
  getUserLimit(userId);
}

function resolveUserId(target) {
  const t = String(target).trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const uname = t.replace(/^@/, "").toLowerCase();
  return usernameMap[uname] || null;
}

// ==================== VVIP FUNCTIONS ====================
function isVVIP(userId) {
  const data = vvipData[String(userId)];
  if (!data) return false;
  if (data.expiresAt && Date.now() >= data.expiresAt) {
    delete vvipData[String(userId)];
    saveVVIPDatabase();
    return false;
  }
  return true;
}

function getVVIPExpiry(userId) {
  const data = vvipData[String(userId)];
  if (!data) return null;
  if (data.expiresAt && Date.now() >= data.expiresAt) {
    delete vvipData[String(userId)];
    saveVVIPDatabase();
    return null;
  }
  return data.expiresAt;
}

function getVVIPRemainingDays(userId) {
  const expiry = getVVIPExpiry(userId);
  if (!expiry) return 0;
  const diff = expiry - Date.now();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function addVVIP(userId, days) {
  const key = String(userId);
  const now = Date.now();
  const currentExpiry = getVVIPExpiry(userId);
  const newExpiry = currentExpiry && currentExpiry > now ? currentExpiry + (days * 24 * 60 * 60 * 1000) : now + (days * 24 * 60 * 60 * 1000);
  
  vvipData[key] = {
    userId: userId,
    expiresAt: newExpiry,
    activatedAt: now,
    days: days
  };
  saveVVIPDatabase();
  return true;
}

// ==================== PAYMENT FUNCTIONS ====================
async function createPayment(userId, packageType, packageId) {
    let packageData;
    let type;
    
    if (packageType === 'vvip') {
        packageData = DEFAULT_VVIP_PACKAGES[packageId];
        type = 'vvip';
    } else if (packageType === 'renew') {
        packageData = DEFAULT_RENEW_PACKAGES[packageId];
        type = 'renew';
    } else if (packageType === 'limit') {
        packageData = DEFAULT_LIMIT_PACKAGES[packageId];
        type = 'limit';
    } else {
        return null;
    }

    if (!packageData) return null;

    const customOrderId = generateCustomOrderId(type);
    const metadata = {
        orderId: customOrderId,
        chatId: String(userId),
        type: type,
        package: packageId,
        packageName: packageData.name,
        donorName: `User_${userId}`,
        notes: `Pembayaran ${packageData.name} - User ${userId}`
    };

    try {
        console.log(chalk.blue(`[Payment] Creating payment for ${type}: ${packageData.name}`));
        console.log(chalk.blue(`[Payment] Custom Order ID: ${customOrderId}`));
        
        const result = await createdQris(packageData.price, metadata);
        
        if (!result) {
            console.error('[Payment] ❌ Result null from Betabotz');
            return null;
        }

        const realTransactionId = result.transactionId;
        const customOrderIdFinal = result.orderId || customOrderId;

        console.log(chalk.green(`[Payment] ✅ Transaction created: ${realTransactionId}`));
        console.log(chalk.green(`[Payment] ✅ Custom Order ID: ${customOrderIdFinal}`));

        const expiresAt = Date.now() + (5 * 60 * 1000);

        paymentSessions[realTransactionId] = {
            userId: userId,
            type: type,
            packageId: packageId,
            packageData: packageData,
            orderId: customOrderIdFinal,
            transactionId: realTransactionId,
            realTransactionId: realTransactionId,
            customOrderId: customOrderIdFinal,
            accessKey: result.accessKey || '',
            amount: result.jumlah || packageData.price,
            nominal: packageData.price,
            fee: result.fee || 0,
            status: 'PENDING',
            createdAt: Date.now(),
            expiresAt: expiresAt,
            message_id: null,
            chat_id: null,
            invoice_message_id: null,
            _notifiedExpired: false,
            qr_string: result.qr_string || '',
            paymentUrl: result.paymentUrl || '',
            customOrderId: customOrderIdFinal
        };
        savePaymentDatabase();

        return {
            ...result,
            packageData: packageData,
            transactionId: realTransactionId,
            orderId: customOrderIdFinal,
            customOrderId: customOrderIdFinal,
            expiresAt: expiresAt,
            paymentUrl: result.paymentUrl || ''
        };
        
    } catch (error) {
        console.error('[Payment] ❌ Error creating payment:', error.message);
        return null;
    }
}

// ==================== LOADING UNTUK PEMBELIAN ====================
async function showPurchaseLoading(chatId, type, packageName) {
    let typeLabel = '';
    let emoji = '';
    
    if (type === 'vvip') {
        typeLabel = 'UPGRADE VVIP';
        emoji = '👑';
    } else if (type === 'renew') {
        typeLabel = 'PERPANJANGAN VVIP';
        emoji = '🔄';
    } else if (type === 'limit') {
        typeLabel = 'PEMBELIAN LIMIT';
        emoji = '📦';
    } else {
        typeLabel = 'PEMBAYARAN';
        emoji = '💳';
    }

    const msg = await sendRichMessage(chatId, `
<h2>⏳ PROSES ${typeLabel}</h2>
<p>${emoji} Mempersiapkan pembayaran untuk paket <b>${packageName}</b>...</p>
<p>⏰ Mohon tunggu sebentar...</p>
`);

    const frames = [
        `📋 Menyiapkan invoice ${packageName}...`,
        `💳 Menghubungkan ke payment gateway...`,
        `📱 Menghasilkan QRIS...`,
        `✅ Memproses pembayaran...`
    ];
    
    let frameIndex = 0;
    let isStopped = false;
    
    const interval = setInterval(async () => {
        if (isStopped) return;
        frameIndex = (frameIndex + 1) % frames.length;
        try {
            await editRichMessage(chatId, msg.message_id, `
<h2>⏳ PROSES ${typeLabel}</h2>
<p>${emoji} ${frames[frameIndex]}</p>
<p>⏰ Mohon tunggu sebentar...</p>
`);
        } catch (e) {
            clearInterval(interval);
        }
    }, 2000);

    setTimeout(() => {
        if (!isStopped) {
            isStopped = true;
            clearInterval(interval);
        }
    }, 15000);

    return {
        msg: msg,
        stop: () => {
            isStopped = true;
            clearInterval(interval);
        },
        update: async (text) => {
            if (!isStopped) {
                try {
                    await editRichMessage(chatId, msg.message_id, `
<h2>⏳ PROSES ${typeLabel}</h2>
<p>${emoji} ${text}</p>
<p>⏰ Mohon tunggu sebentar...</p>
`);
                } catch (e) {}
            }
        }
    };
}

// ==================== CREATE PAYMENT WITH LOADING ====================
async function createPaymentWithLoading(userId, packageType, packageId, chatId) {
    let packageData;
    let typeLabel;
    
    if (packageType === 'vvip') {
        packageData = DEFAULT_VVIP_PACKAGES[packageId];
        typeLabel = 'vvip';
    } else if (packageType === 'renew') {
        packageData = DEFAULT_RENEW_PACKAGES[packageId];
        typeLabel = 'renew';
    } else if (packageType === 'limit') {
        packageData = DEFAULT_LIMIT_PACKAGES[packageId];
        typeLabel = 'limit';
    } else {
        return null;
    }

    if (!packageData) return null;

    const loading = await showPurchaseLoading(chatId, typeLabel, packageData.name);
    
    try {
        await loading.update(`Menyiapkan invoice untuk ${packageData.name}...`);
        await sleep(1000);
        
        await loading.update(`Menghubungkan ke payment gateway...`);
        await sleep(1000);
        
        const result = await createPayment(userId, packageType, packageId);
        
        await loading.update(`QRIS berhasil dibuat untuk ${packageData.name}!`);
        await sleep(800);
        
        loading.stop();
        
        try {
            await bot.deleteMessage(chatId, loading.msg.message_id);
        } catch (e) {}
        
        return result;
    } catch (error) {
        loading.stop();
        try {
            await bot.deleteMessage(chatId, loading.msg.message_id);
        } catch (e) {}
        throw error;
    }
}

// ==================== UPDATE INVOICE STATUS ====================
async function updateInvoiceStatus(chatId, messageId, transactionId, status, details = {}) {
    const session = paymentSessions[transactionId];
    if (!session) return;

    const statusMap = {
        'PENDING': 'Menunggu Pembayaran',
        'PAID': 'Lunas - Terverifikasi',
        'EXPIRED': 'Expired',
        'CANCELLED': 'Dibatalkan'
    };

    const statusText = statusMap[status] || status;

    const displayOrderId = session.customOrderId || session.orderId || transactionId;
    const realTxId = session.realTransactionId || transactionId;
    const paymentUrl = session.paymentUrl || '';

    const invoiceHtml = `
<h2>🧾 INVOICE PEMBAYARAN</h2>

<table>
  <tr><th>Detail</th><th>Informasi</th></tr>
  <tr><td>📋 ID Transaksi</td><td><code>${displayOrderId}</code></td></tr>
  <tr><td>🆔 Reff id</td><td><code>${realTxId}</code></td></tr>
  <tr><td>📦 Paket</td><td><b>${session.packageData.name}</b></td></tr>
  <tr><td>💰 Harga</td><td>${toRupiah(session.packageData.price)}</td></tr>
  <tr><td>💵 Total Bayar</td><td><b>${toRupiah(session.amount || session.nominal)}</b></td></tr>
  ${details.paidAt ? `<tr><td>🕐 Dibayar</td><td>${new Date(details.paidAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</td></tr>` : ''}
  <tr><td>🔄 Status</td><td><b>${statusText}</b></td></tr>
  ${paymentUrl ? `<tr><td>🔗 Link Bayar</td><td><a href="${paymentUrl}">${paymentUrl}</a></td></tr>` : ''}
</table>

<hr/>
${status === 'PAID' ? '<p>🎉 Pembayaran berhasil! Paket Anda telah aktif.</p>' : ''}
${status === 'EXPIRED' ? '<p>⏰ Waktu pembayaran telah habis. Silakan buat transaksi baru.</p>' : ''}
${status === 'CANCELLED' ? '<p>❌ Transaksi dibatalkan. QRIS telah dihapus.</p>' : ''}

<footer>⚡ Powered by <a href="https://t.me/masreymarket">@masreymarket</a></footer>
`;

    const buttons = {
        inline_keyboard: []
    };

    if (status === 'PENDING') {
        buttons.inline_keyboard.push([
            { text: '🔄 Cek Pembayaran', callback_data: `check_payment_${realTxId}`, style: "primary" },
            { text: '❌ Batalkan', callback_data: `cancel_payment_${realTxId}`, style: "danger" }
        ]);
    }

    buttons.inline_keyboard.push([
        { text: '↺ Kembali ke Menu', callback_data: 'back_menu', style: "danger" }
    ]);

    try {
        await sendRichMessage(chatId, invoiceHtml, buttons);
        
        if (session.message_id && session.chat_id) {
            try {
                await bot.deleteMessage(session.chat_id, session.message_id);
            } catch (e) {}
        }
        
        if (session.invoice_message_id) {
            try {
                await bot.deleteMessage(chatId, session.invoice_message_id);
            } catch (e) {}
        }
        
        session.message_id = null;
        session.invoice_message_id = null;
        savePaymentDatabase();
        
    } catch (e) {
        console.error('[Invoice] Failed to update:', e.message);
    }
}

async function checkPaymentStatus(transactionId) {
    const session = paymentSessions[transactionId];
    if (!session) {
        return { success: false, status: 'NOT_FOUND', message: '❌ Transaksi tidak ditemukan' };
    }

    if (session.expiresAt && Date.now() >= session.expiresAt) {
        session.status = 'EXPIRED';
        savePaymentDatabase();
        await deleteQRISMessage(session);
        if (session.message_id && session.chat_id) {
            await updateInvoiceStatus(session.chat_id, session.message_id, transactionId, 'EXPIRED');
        }
        return { success: false, status: 'EXPIRED', message: '⏰ Waktu pembayaran telah habis (kadaluarsa)' };
    }

    if (session.status === 'CANCELLED') {
        return { success: false, status: 'CANCELLED', message: '❌ Transaksi telah dibatalkan' };
    }

    if (session.status === 'PAID') {
        return { success: true, status: 'PAID', data: session };
    }

    try {
        console.log(`[Payment] 🔍 Checking status for order: ${transactionId}`);
        
        const result = await cekStatus(session.transactionId, session.accessKey);
        console.log('[Payment] 📊 Status result:', JSON.stringify(result, null, 2));
        
        if (result) {
            if (result.status === 'PAID' || result.status === 'paid' || result.success === true) {
                session.status = 'PAID';
                session.paidAt = Date.now();
                savePaymentDatabase();
                
                await processPayment(session);
                await deleteQRISMessage(session);
                
                if (session.message_id && session.chat_id) {
                    await updateInvoiceStatus(session.chat_id, session.message_id, transactionId, 'PAID', { 
                        paidAt: session.paidAt 
                    });
                }
                
                setTimeout(() => {
                    if (paymentSessions[transactionId]) {
                        delete paymentSessions[transactionId];
                        savePaymentDatabase();
                    }
                }, 5000);
                
                return { success: true, status: 'PAID', data: session };
            }
            
            if (result.status === 'EXPIRED' || result.status === 'expired') {
                session.status = 'EXPIRED';
                savePaymentDatabase();
                await deleteQRISMessage(session);
                if (session.message_id && session.chat_id) {
                    await updateInvoiceStatus(session.chat_id, session.message_id, transactionId, 'EXPIRED');
                }
                return { success: false, status: 'EXPIRED', message: '⏰ Waktu pembayaran telah habis (kadaluarsa)' };
            }
            
            if (result.status === 'CANCELLED' || result.status === 'cancelled') {
                session.status = 'CANCELLED';
                savePaymentDatabase();
                await deleteQRISMessage(session);
                if (session.message_id && session.chat_id) {
                    await updateInvoiceStatus(session.chat_id, session.message_id, transactionId, 'CANCELLED');
                }
                return { success: false, status: 'CANCELLED', message: '❌ Transaksi telah dibatalkan' };
            }
        }
        
        return { success: true, status: 'PENDING', data: session };
        
    } catch (error) {
        console.error('[Payment] ❌ Error checking status:', error.message);
        return { success: true, status: 'PENDING', data: session };
    }
}

async function cancelPayment(transactionId, userId = null) {
    const session = paymentSessions[transactionId];
    if (!session) {
        return { success: false, message: '❌ Transaksi tidak ditemukan' };
    }

    if (session.status === 'PAID') {
        return { success: false, message: '❌ Transaksi sudah lunas, tidak dapat dibatalkan!' };
    }

    if (session.status === 'CANCELLED' || session.status === 'EXPIRED') {
        return { success: false, message: `❌ Transaksi sudah ${session.status === 'CANCELLED' ? 'dibatalkan' : 'kadaluarsa'}` };
    }

    try {
        console.log(`[Payment] ❌ Cancelling transaction: ${transactionId}`);
        await cancelTransaction(session.transactionId);
    } catch (error) {
        console.error('[Payment] ❌ Error cancelling transaction (dilewati untuk hapus lokal):', error.message);
    }
        
    session.status = 'CANCELLED';
    session.cancelledAt = Date.now();
    savePaymentDatabase();
    
    await deleteQRISMessage(session);
    
    if (session.message_id && session.chat_id) {
        await updateInvoiceStatus(session.chat_id, session.message_id, transactionId, 'CANCELLED');
    }
    
    delete paymentSessions[transactionId];
    savePaymentDatabase();
    
    console.log(`[Payment] ✅ Transaction cancelled and QRIS deleted: ${transactionId}`);
    return { success: true, message: '✅ Transaksi berhasil dibatalkan' };
}

async function deleteQRISMessage(session) {
    if (session && session.message_id && session.chat_id) {
        try {
            await bot.deleteMessage(session.chat_id, session.message_id);
            console.log('[Payment] ✅ QRIS message deleted');
        } catch (e) {
            console.error('[Payment] Error deleting QRIS message:', e.message);
        }
    }
}

async function processPayment(session) {
    const userId = session.userId;
    const type = session.type;
    const packageData = session.packageData;

    if (type === 'vvip') {
        addVVIP(userId, packageData.days);
    } else if (type === 'renew') {
        addVVIP(userId, packageData.days);
    } else if (type === 'limit') {
        const key = String(userId);
        const now = Date.now();
        if (!bonusLimits[key]) {
            bonusLimits[key] = {
                dailyLimit: packageData.limit,
                remaining: packageData.limit,
                lastReset: now,
                expiresAt: now + (packageData.days * 24 * 60 * 60 * 1000)
            };
        } else {
            bonusLimits[key].dailyLimit += packageData.limit;
            bonusLimits[key].remaining += packageData.limit;
            bonusLimits[key].expiresAt = bonusLimits[key].expiresAt ? 
                bonusLimits[key].expiresAt + (packageData.days * 24 * 60 * 60 * 1000) : 
                now + (packageData.days * 24 * 60 * 60 * 1000);
        }
        saveBonusLimitDatabase();
    }

    const successMsg = getPaymentSuccessMessage(userId, type, packageData);
    await sendRichMessage(userId, successMsg);
    
    await sendPaymentLog(userId, session);
    await sendPurchaseLog(userId, session);
}

function getPaymentSuccessMessage(userId, type, packageData) {
    const username = `User_${userId}`;
    const timeNow = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    
    let detail = '';
    if (type === 'vvip') {
        const expiry = getVVIPExpiry(userId);
        const expiryDate = expiry ? new Date(expiry).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" }) : '-';
        detail = `
  <tr><td>🎁 Paket</td><td>${packageData.name}</td></tr>
  <tr><td>📅 Masa Aktif</td><td>${packageData.days} Hari</td></tr>
  <tr><td>⏳ Berlaku Sampai</td><td>${expiryDate}</td></tr>
  <tr><td>👑 Status</td><td>✅ VVIP Active</td></tr>`;
    } else if (type === 'renew') {
        const expiry = getVVIPExpiry(userId);
        const expiryDate = expiry ? new Date(expiry).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" }) : '-';
        detail = `
  <tr><td>🔄 Perpanjangan</td><td>${packageData.name}</td></tr>
  <tr><td>📅 Tambahan</td><td>${packageData.days} Hari</td></tr>
  <tr><td>⏳ Berlaku Sampai</td><td>${expiryDate}</td></tr>
  <tr><td>👑 Status</td><td>✅ VVIP Diperpanjang</td></tr>`;
    } else if (type === 'limit') {
        const bonus = getUserBonusLimit(userId);
        const regular = getUserLimit(userId);
        detail = `
  <tr><td>📦 Paket</td><td>${packageData.name}</td></tr>
  <tr><td>➕ Limit Tambahan</td><td>${packageData.limit} Limit</td></tr>
  <tr><td>📅 Berlaku</td><td>${packageData.days} Hari</td></tr>
  <tr><td>💎 Total Limit</td><td>${bonus + regular} Limit</td></tr>`;
    }

    return `<h2>✅ PEMBAYARAN BERHASIL!</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>👤 User</td><td>${username}</td></tr>
  <tr><td>🕐 Waktu</td><td>${timeNow} WIB</td></tr>
  ${detail}
</table>

<hr/>
<p>Terima kasih telah melakukan pembayaran! 🎉</p>
<footer>⚡ Powered by <a href="https://t.me/masreymarket">@masreymarket</a></footer>`;
}

// ==================== CHECK EXPIRED PAYMENTS ====================
async function checkExpiredPayments() {
    const now = Date.now();
    let expiredCount = 0;
    
    for (const [transactionId, session] of Object.entries(paymentSessions)) {
        if (session.expiresAt && now >= session.expiresAt && session.status === 'PENDING') {
            session.status = 'EXPIRED';
            savePaymentDatabase();
            
            await deleteQRISMessage(session);
            
            if (session.message_id && session.chat_id) {
                await updateInvoiceStatus(session.chat_id, session.message_id, transactionId, 'EXPIRED');
            }
            
            const userId = session.userId;
            const totalPayment = session.amount || session.nominal || 0;
            const paymentUrl = session.paymentUrl || '';
            const displayOrderId = session.customOrderId || session.orderId || transactionId;
            
            const expiredText = `
<h2>⏰ INVOICE KADALUWARSA</h2>

<table bordered striped>
  <tr><th>Detail</th><th>Informasi</th></tr>
  <tr><td>📋 ID Transaksi</td><td><code>${displayOrderId}</code></td></tr>
  <tr><td>📦 Paket</td><td>${session.packageData?.name || '-'}</td></tr>
  <tr><td>💰 Total</td><td>${toRupiah(totalPayment)}</td></tr>
  <tr><td>⏰ Status</td><td>🔴 Kadaluarsa</td></tr>
  ${paymentUrl ? `<tr><td>🔗 Link Bayar</td><td><a href="${paymentUrl}">${paymentUrl}</a></td></tr>` : ''}
</table>

<hr/>
<p>⏰ Waktu pembayaran telah habis. Silakan buat transaksi baru.</p>
<p>💡 Klik tombol di bawah untuk kembali ke Store.</p>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@masreymarket</a></footer>
`;
            
            try {
                await sendRichMessage(userId, expiredText, {
                    inline_keyboard: [
                        [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }]
                    ]
                });
            } catch (e) {
                console.error('[Payment] Failed to send expired notification:', e.message);
            }
            
            delete paymentSessions[transactionId];
            savePaymentDatabase();
            
            expiredCount++;
            console.log(`[Payment] ⏰ Invoice ${transactionId} expired, notified user ${userId}`);
        }
    }
    
    if (expiredCount > 0) {
        console.log(`[Payment] 🧹 Cleaned up ${expiredCount} expired sessions`);
    }
}

// ==================== HANDLE PAYMENT TEXT ====================
async function handleCheckPaymentText(chatId, senderId) {
    let activeTransactionId = null;
    let activeSession = null;
    
    for (const [transactionId, session] of Object.entries(paymentSessions)) {
        if (String(session.userId) === String(senderId) && session.status === 'PENDING') {
            activeTransactionId = transactionId;
            activeSession = session;
            break;
        }
    }
    
    if (!activeSession) {
        const textNoOrder = `<h3>❌ Tidak Ada Transaksi Aktif</h3>
<p>Anda tidak memiliki transaksi pembayaran yang sedang berlangsung.</p>
<p>Silakan buat transaksi baru melalui menu <b>Store</b>.</p>`;
        await sendRichMessage(chatId, textNoOrder, {
            inline_keyboard: [
                [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }]
            ]
        });
        return true;
    }
    
    if (activeSession.expiresAt && Date.now() >= activeSession.expiresAt) {
        activeSession.status = 'EXPIRED';
        savePaymentDatabase();
        await deleteQRISMessage(activeSession);
        
        if (activeSession.message_id && activeSession.chat_id) {
            await updateInvoiceStatus(activeSession.chat_id, activeSession.message_id, activeTransactionId, 'EXPIRED');
        }
        
        const totalPayment = activeSession.amount || activeSession.nominal || 0;
        const paymentUrl = activeSession.paymentUrl || '';
        const displayOrderId = activeSession.customOrderId || activeSession.orderId || activeTransactionId;
        
        const expiredText = `
<h2>⏰ INVOICE EXPIRED</h2>

<table bordered striped>
  <tr><th>Detail</th><th>Informasi</th></tr>
  <tr><td>📋 ID Transaksi</td><td><code>${displayOrderId}</code></td></tr>
  <tr><td>📦 Paket</td><td>${activeSession.packageData?.name || '-'}</td></tr>
  <tr><td>💰 Total</td><td>${toRupiah(totalPayment)}</td></tr>
  <tr><td>⏰ Status</td><td>🔴 Kadaluarsa</td></tr>
  ${paymentUrl ? `<tr><td>🔗 Link Bayar</td><td><a href="${paymentUrl}">${paymentUrl}</a></td></tr>` : ''}
</table>

<hr/>
<p>⏰ Waktu pembayaran telah habis. Silakan buat transaksi baru.</p>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>
`;
        await sendRichMessage(chatId, expiredText, {
            inline_keyboard: [
                [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }]
            ]
        });
        return true;
    }
    
    const loadingMsg = await sendRichMessage(chatId, `<h2>⏳ Mengecek Status Pembayaran...</h2>
<p>🔄 Transaksi: <code>${activeSession.customOrderId || activeSession.orderId}</code></p>
<p>🔄 Reff id: <code>${activeTransactionId}</code></p>
<p>⏰ Mohon tunggu sebentar...</p>`);
    
    const result = await checkPaymentStatus(activeTransactionId);
    
    if (loadingMsg && loadingMsg.message_id) {
        try {
            await bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (e) {}
    }
    
    if (result.success && result.status === 'PAID') {
        await deleteQRISMessage(activeSession);
        
        const text = `<h2>✅ PEMBAYARAN BERHASIL!</h2>
<p>🎉 Paket Anda telah berhasil diaktifkan!</p>
<table bordered striped>
    <tr><th>Field</th><th>Detail</th></tr>
    <tr><td>📦 Paket</td><td>${activeSession.packageData.name}</td></tr>
    <tr><td>💰 Total</td><td>${toRupiah(activeSession.amount || activeSession.nominal)}</td></tr>
    <tr><td>🆔 Transaksi</td><td><code>${activeSession.customOrderId || activeSession.orderId}</code></td></tr>
    <tr><td>🆔 Reff id</td><td><code>${activeTransactionId}</code></td></tr>
</table>
<p>Silakan kembali ke menu utama untuk menggunakan fitur baru Anda.</p>`;
        await sendRichMessage(chatId, text, {
            inline_keyboard: [
                [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "success" }]
            ]
        });
        return true;
        
    } else if (result.status === 'PENDING' || result.success === true) {
        if (loadingMsg && loadingMsg.message_id) {
            try {
                await bot.deleteMessage(chatId, loadingMsg.message_id);
            } catch (e) {}
        }
        
        await reshowQRISPayment(chatId, activeTransactionId);
        return true;
        
    } else {
        if (result.status === 'CANCELLED' || result.status === 'EXPIRED') {
            await deleteQRISMessage(activeSession);
        }
        
        const statusText = result.status === 'CANCELLED' ? '❌ Transaksi Dibatalkan' : 
                          result.status === 'EXPIRED' ? '⏰ Pembayaran Kadaluarsa' : 
                          '❌ Pembayaran Gagal';
        
        const text = `<h2>${statusText}</h2>
<p>${result.message || 'Terjadi kesalahan. Silakan buat transaksi baru.'}</p>
<p>🆔 Transaksi: <code>${activeSession.customOrderId || activeSession.orderId}</code></p>`;
        await sendRichMessage(chatId, text, {
            inline_keyboard: [
                [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }],
                [{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]
            ]
        });
        return true;
    }
}

async function handleCancelPaymentText(chatId, senderId) {
    let activeTransactionId = null;
    let activeSession = null;
    
    for (const [transactionId, session] of Object.entries(paymentSessions)) {
        if (String(session.userId) === String(senderId) && session.status === 'PENDING') {
            activeTransactionId = transactionId;
            activeSession = session;
            break;
        }
    }
    
    if (!activeSession) {
        const textNoOrder = `<h3>❌ Tidak Ada Transaksi Aktif</h3>
<p>Anda tidak memiliki transaksi pembayaran yang sedang berlangsung untuk dibatalkan.</p>`;
        await sendRichMessage(chatId, textNoOrder, {
            inline_keyboard: [
                [{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]
            ]
        });
        return true;
    }
    
    if (activeSession.expiresAt && Date.now() >= activeSession.expiresAt) {
        activeSession.status = 'EXPIRED';
        savePaymentDatabase();
        await deleteQRISMessage(activeSession);
        
        if (activeSession.message_id && activeSession.chat_id) {
            await updateInvoiceStatus(activeSession.chat_id, activeSession.message_id, activeTransactionId, 'EXPIRED');
        }
        
        const totalPayment = activeSession.amount || activeSession.nominal || 0;
        const paymentUrl = activeSession.paymentUrl || '';
        const displayOrderId = activeSession.customOrderId || activeSession.orderId || activeTransactionId;
        
        const text = `
<h2>⏰ INVOICE EXPIRED</h2>

<table bordered striped>
  <tr><th>Detail</th><th>Informasi</th></tr>
  <tr><td>📋 ID Transaksi</td><td><code>${displayOrderId}</code></td></tr>
  <tr><td>📦 Paket</td><td>${activeSession.packageData?.name || '-'}</td></tr>
  <tr><td>💰 Total</td><td>${toRupiah(totalPayment)}</td></tr>
  <tr><td>⏰ Status</td><td>🔴 Kadaluarsa</td></tr>
  ${paymentUrl ? `<tr><td>🔗 Link Bayar</td><td><a href="${paymentUrl}">${paymentUrl}</a></td></tr>` : ''}
</table>

<hr/>
<p>⏰ Waktu pembayaran telah habis. Silakan buat transaksi baru.</p>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>
`;
        await sendRichMessage(chatId, text, {
            inline_keyboard: [
                [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }]
            ]
        });
        return true;
    }
    
    const displayOrderId = activeSession.customOrderId || activeSession.orderId || activeTransactionId;
    
    const confirmText = `<h3>⚠️ Konfirmasi Pembatalan</h3>
<p>Apakah Anda yakin ingin membatalkan transaksi ini?</p>
<table bordered striped>
    <tr><th>Field</th><th>Detail</th></tr>
    <tr><td>📦 Paket</td><td>${activeSession.packageData.name}</td></tr>
    <tr><td>💰 Total</td><td>${toRupiah(activeSession.amount || activeSession.nominal)}</td></tr>
    <tr><td>🆔 Transaksi</td><td><code>${displayOrderId}</code></td></tr>
    <tr><td>🆔 Referensi</td><td><code>${activeTransactionId}</code></td></tr>
</table>
<p>⚠️ Transaksi akan dibatalkan dan QRIS akan dihapus.</p>`;
    
    await sendRichMessage(chatId, confirmText, {
        inline_keyboard: [
            [
                { text: "✅ Ya, Batalkan", callback_data: `cancel_confirm_${activeTransactionId}`, style: "danger" },
                { text: "❌ Tidak", callback_data: `cancel_back_${activeTransactionId}`, style: "primary" }
            ]
        ]
    });
    return true;
}

// ==================== SHOW QRIS PAYMENT WITH INVOICE ====================
async function showQRISPayment(ctx, payment, paymentResult, type = 'vvip') {
    try {
        const chatId = ctx.chat.id;
        const packageName = paymentResult.packageName || 'Paket';
        const realTransactionId = paymentResult.transactionId;
        const customOrderId = paymentResult.customOrderId || paymentResult.orderId || realTransactionId;
        const typeLabel = paymentResult.typeLabel || '';
        const paymentUrl = payment.paymentUrl || paymentResult.paymentUrl || '';
        
        const qrBuffer = await genQrBuffer(payment.qr_string);
        
        if (!qrBuffer) {
            return ctx.reply('❌ Gagal generate QR Code. Silakan coba lagi.', { parse_mode: 'HTML' });
        }
        
        let fee = payment.fee || 0;
        let total = payment.jumlah || 0;
        let expiredAt = payment.expiresAt || Date.now() + 300000;
        let price = paymentResult.price || payment.nominal || 0;
        
        let qrImageUrl = '';
        try {
            qrImageUrl = await uploadtop4top(qrBuffer, `qris_${realTransactionId}.png`);
            console.log(chalk.green(`[QRIS] ✅ QRIS uploaded to Top4Top: ${qrImageUrl}`));
        } catch (uploadError) {
            console.error('[QRIS] Failed to upload QRIS:', uploadError.message);
            const base64 = qrBuffer.toString('base64');
            qrImageUrl = `data:image/png;base64,${base64}`;
        }
        
        const expiredDateObj = new Date(expiredAt);
        const remainingMs = expiredAt - Date.now();
        const remainingMinutes = Math.max(0, Math.floor(remainingMs / 60000));
        const remainingSeconds = Math.max(0, Math.floor((remainingMs % 60000) / 1000));
        
        let timeText = '';
        if (remainingMinutes > 0) {
            timeText = `${remainingMinutes} menit`;
        } else {
            timeText = `${remainingSeconds} detik`;
        }
        
        const typeText = typeLabel || (type === 'vvip' ? '👑 Upgrade VVIP' : type === 'renew' ? '🔄 Perpanjang VVIP' : '📦 Tambah Limit');

        const fullHtml = `
<img src="${qrImageUrl}"/>

<h2># BOT CREATE ALIGHT MOTION V2</h2>

<hr/>

<h3>💸 invoice pembayaran</h3>

<table bordered striped>
  <tr><th>Gateway</th><td>QRIS</td></tr>
  <tr><td>Order ID</td><td><code>${customOrderId}</code></td></tr>
  <tr><td>Nominal Deposit</td><td>${toRupiah(price)}</td></tr>
  <tr><td>Total Bayar</td><td><b>${toRupiah(total)}</b></td></tr>
  <tr><td>Status</td><td><b>🟡 Menunggu pembayaran</b></td></tr>
  <tr><td>Masa Berlaku</td><td>${timeText}</td></tr>
  ${paymentUrl ? `<tr><td>🔗 Link Bayar</td><td><a href="${paymentUrl}">${paymentUrl}</a></td></tr>` : ''}
</table>

<hr/>
<p>Scan QRIS pada media di atas dan bayar tepat sesuai Total Bayar. Saldo masuk otomatis setelah pembayaran terverifikasi.</p>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>
`;

        const result = await sendRichMessage(chatId, fullHtml, {
            inline_keyboard: [
                [{ text: '🔄 Cek Pembayaran', callback_data: `check_payment_${realTransactionId}`, style: "primary" }],
                [{ text: '❌ Batalkan Deposit', callback_data: `cancel_payment_${realTransactionId}`, style: "danger" }]
            ]
        });
        
        if (result && result.message_id && paymentSessions[realTransactionId]) {
            paymentSessions[realTransactionId].chat_id = chatId;
            paymentSessions[realTransactionId].message_id = result.message_id;
            paymentSessions[realTransactionId].invoice_message_id = null;
            savePaymentDatabase();
            console.log(`[Payment] ✅ QRIS message data tersimpan: Chat=${chatId}, Msg=${result.message_id}`);
        }
        
        watchPaymentStatus(realTransactionId, payment.accessKey || '', 5000, 60).then((monitorResult) => {
            if (monitorResult.success && monitorResult.status === 'PAID') {
                console.log(`[Payment] ✅ Real-time: Payment confirmed for ${realTransactionId}`);
                if (paymentSessions[realTransactionId] && paymentSessions[realTransactionId].status !== 'PAID') {
                    processPayment(paymentSessions[realTransactionId]);
                }
            }
        }).catch(err => {
            console.error('[Payment] Real-time monitor error:', err.message);
        });
        
        return result;
        
    } catch (error) {
        console.error('[QRIS] showQRISPayment error:', error.message);
        return sendRichMessage(chatId, '❌ Terjadi kesalahan saat menampilkan QRIS. Silakan coba lagi.', {
            inline_keyboard: [
                [{ text: '↺ Kembali ke Store', callback_data: 'store_menu' }]
            ]
        });
    }
}

// ==================== RESHOW QRIS PAYMENT ====================
async function reshowQRISPayment(chatId, transactionId) {
    try {
        const session = paymentSessions[transactionId];
        if (!session) {
            return await sendRichMessage(chatId, `<h3>❌ Transaksi Tidak Ditemukan</h3>`, {
                inline_keyboard: [[{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]]
            });
        }

        if (session.status === 'PAID') {
            return await sendRichMessage(chatId, `<h3>✅ Transaksi Sudah Lunas</h3>
<p>Paket Anda sudah aktif. Tidak perlu membatalkan.</p>`, {
                inline_keyboard: [[{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "success" }]]
            });
        }

        if (session.status === 'CANCELLED' || session.status === 'EXPIRED') {
            return await sendRichMessage(chatId, `<h3>❌ Transaksi Sudah ${session.status === 'CANCELLED' ? 'Dibatalkan' : 'Kadaluarsa'}</h3>
<p>Silakan buat transaksi baru di Store.</p>`, {
                inline_keyboard: [
                    [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }]
                ]
            });
        }

        const paymentData = {
            qr_string: session.qr_string || '',
            fee: session.fee || 0,
            jumlah: session.amount || session.nominal || 0,
            expiresAt: session.expiresAt || Date.now() + 300000,
            nominal: session.nominal || 0,
            paymentUrl: session.paymentUrl || ''
        };

        if (paymentData.qr_string) {
            const qrBuffer = await genQrBuffer(paymentData.qr_string);
            if (qrBuffer) {
                let qrImageUrl = '';
                try {
                    qrImageUrl = await uploadtop4top(qrBuffer, `qris_${transactionId}.png`);
                } catch (uploadError) {
                    const base64 = qrBuffer.toString('base64');
                    qrImageUrl = `data:image/png;base64,${base64}`;
                }

                const expiredDateObj = new Date(paymentData.expiresAt);
                const remainingMs = paymentData.expiresAt - Date.now();
                const remainingMinutes = Math.max(0, Math.floor(remainingMs / 60000));
                const remainingSeconds = Math.max(0, Math.floor((remainingMs % 60000) / 1000));
                
                let timeText = '';
                if (remainingMinutes > 0) {
                    timeText = `${remainingMinutes} menit`;
                } else {
                    timeText = `${remainingSeconds} detik`;
                }

                const typeText = session.type === 'vvip' ? '👑 Upgrade VVIP' : session.type === 'renew' ? '🔄 Perpanjang VVIP' : '📦 Tambah Limit';
                const packageName = session.packageData.name || 'Paket';
                const paymentUrl = paymentData.paymentUrl || '';
                const customOrderId = session.customOrderId || session.orderId || transactionId;

                const fullHtml = `
<img src="${qrImageUrl}"/>

<h2># BOT CREATE ALIGHT MOTION V2</h2>

<hr/>

<h3>💸 invoice pembayaran</h3>

<table bordered striped>
  <tr><th>Gateway</th><td>QRIS</td></tr>
  <tr><td>Order ID</td><td><code>${customOrderId}</code></td></tr>
  <tr><td>Nominal Deposit</td><td>${toRupiah(paymentData.nominal)}</td></tr>
  <tr><td>Total Bayar</td><td><b>${toRupiah(paymentData.jumlah)}</b></td></tr>
  <tr><td>Status</td><td><b>🟡 Menunggu pembayaran</b></td></tr>
  <tr><td>Masa Berlaku</td><td>${timeText}</td></tr>
  ${paymentUrl ? `<tr><td>🔗 Link Bayar</td><td><a href="${paymentUrl}">${paymentUrl}</a></td></tr>` : ''}
</table>

<hr/>
<p>Scan QRIS pada media di atas dan bayar tepat sesuai Total Bayar. Saldo masuk otomatis setelah pembayaran terverifikasi.</p>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>
`;

                const result = await sendRichMessage(chatId, fullHtml, {
                    inline_keyboard: [
                        [{ text: '🔄 Cek Pembayaran', callback_data: `check_payment_${transactionId}`, style: "primary" }],
                        [{ text: '❌ Batalkan Deposit', callback_data: `cancel_payment_${transactionId}`, style: "danger" }]
                    ]
                });

                if (result && result.message_id) {
                    session.chat_id = chatId;
                    session.message_id = result.message_id;
                    savePaymentDatabase();
                }

                return result;
            }
        }

        return await sendRichMessage(chatId, `<h3>⚠️ QRIS Tidak Ditemukan</h3>
<p>Silakan buat transaksi baru di Store.</p>`, {
            inline_keyboard: [
                [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }]
            ]
        });

    } catch (error) {
        console.error('[QRIS] reshowQRISPayment error:', error.message);
        return await sendRichMessage(chatId, `<h3>❌ Gagal Menampilkan QRIS</h3>
<p>${error.message}</p>`, {
            inline_keyboard: [
                [{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]
            ]
        });
    }
}

// ==================== CLEANUP PAYMENT ====================
function cleanupPayments() {
    const now = Date.now();
    let removedCount = 0;
    
    for (const [transactionId, session] of Object.entries(paymentSessions)) {
        if (session.status === 'PAID') {
            delete paymentSessions[transactionId];
            removedCount++;
            continue;
        }
        
        if (session.expiresAt && now >= session.expiresAt) {
            deleteQRISMessage(session);
            
            if (!session._notifiedExpired) {
                session._notifiedExpired = true;
                savePaymentDatabase();
                
                if (session.message_id && session.chat_id) {
                    updateInvoiceStatus(session.chat_id, session.message_id, transactionId, 'EXPIRED');
                }
                
                const userId = session.userId;
                const totalPayment = session.amount || session.nominal || 0;
                const paymentUrl = session.paymentUrl || '';
                const displayOrderId = session.customOrderId || session.orderId || transactionId;
                
                const expiredText = `
<h2>⏰ INVOICE KADALUWARSA</h2>

<table bordered striped>
  <tr><th>Detail</th><th>Informasi</th></tr>
  <tr><td>📋 ID Transaksi</td><td><code>${displayOrderId}</code></td></tr>
  <tr><td>📦 Paket</td><td>${session.packageData?.name || '-'}</td></tr>
  <tr><td>💰 Total</td><td>${toRupiah(totalPayment)}</td></tr>
  <tr><td>⏰ Status</td><td>🔴 Kadaluarsa</td></tr>
  ${paymentUrl ? `<tr><td>🔗 Link Bayar</td><td><a href="${paymentUrl}">${paymentUrl}</a></td></tr>` : ''}
</table>

<hr/>
<p>⏰ Waktu pembayaran telah habis. Silakan buat transaksi baru.</p>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>
`;
                
                try {
                    sendRichMessage(userId, expiredText, {
                        inline_keyboard: [
                            [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }]
                        ]
                    });
                } catch (e) {
                    console.error('[Payment] Failed to send expired notification:', e.message);
                }
            }
            
            delete paymentSessions[transactionId];
            removedCount++;
            continue;
        }
        
        if (session.status === 'CANCELLED') {
            delete paymentSessions[transactionId];
            removedCount++;
            continue;
        }
    }
    
    if (removedCount > 0) {
        savePaymentDatabase();
        console.log(`[Payment] 🧹 Cleaned up ${removedCount} expired/cancelled/paid sessions`);
    }
}

// ==================== LOAD DATABASES ====================
loadDatabase();
loadUsersDatabase();
loadLimitDatabase();
loadBonusLimitDatabase();
loadMaintenanceDatabase();
loadBotDatabase();
loadVVIPDatabase();
loadPaymentDatabase();
loadUserActivityDatabase();

// ==================== QRIS PAYMENT FUNCTIONS ====================
const BTZPAYGATE_BASE_URL = 'https://web.btzpay.my.id';

async function genQrBuffer(qrisString) {
    try {
        if (!qrisString) return null;
        
        const res = await fetch(`${BTZPAYGATE_BASE_URL}/api/qris/create-qr-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: qrisString,
                size: '500x500',
                style: '4',
                color: '0f1056',
                format: 'png',
                pngMode: 'styled',
                viewer: '0'
            })
        });
        
        if (!res.ok) {
            console.error('[QRIS] Generate QR error:', res.status);
            return null;
        }
        
        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        console.error('[QRIS] genQrBuffer error:', error.message);
        return null;
    }
}

async function uploadtop4top(buffer, filename = 'image.jpg') {
    if (!buffer) throw new Error('Buffer kosong');

    const form = new FormData();
    form.append('file_1_', buffer, filename);
    form.append('submitr', '[ رفع الملفات ]');

    try {
        const res = await axios.post('https://top4top.io/index.php', form, {
            headers: {
                ...form.getHeaders(),
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'user-agent': 'Mozilla/5.0'
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        const $ = cheerio.load(res.data);
        const url = $('div.alert.alert-warning ul li span a').attr('href');

        if (!url) throw new Error('Link Top4Top tidak ditemukan');
        return url;
    } catch (e) {
        console.error('Top4Top Error:', e);
        throw new Error('Gagal upload gambar ke Top4Top');
    }
}

// ==================== SERVER STATUS HELPER ====================
function formatSize(bytes) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = bytes;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

function getDiskInfo() {
    try {
        const out = execSync('df -kP /', { timeout: 3000 }).toString().trim().split('\n');
        const r = out.slice(1).map(l => l.trim().split(/\s+/))[0];
        if (!r) return null;
        const total = +r[1] * 1024, used = +r[2] * 1024;
        return {
            total,
            used,
            free: total - used,
            percent: +(used / total * 100).toFixed(1)
        };
    } catch {
        return null;
    }
}

function getSwapInfo() {
    try {
        const f = fs.readFileSync('/proc/meminfo', 'utf8');
        const total = (f.match(/^SwapTotal:\s+(\d+)/) || [0, 0])[1] * 1024;
        const free = (f.match(/^SwapFree:\s+(\d+)/) || [0, 0])[1] * 1024;
        if (!total) return null;
        const used = total - free;
        return {
            total,
            used,
            free,
            percent: +(used / total * 100).toFixed(1)
        };
    } catch {
        return null;
    }
}

function getCPUUsagePercent() {
    try {
        const cpus = os.cpus();
        let totalIdle = 0, totalTick = 0;
        for (const cpu of cpus) {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        }
        const idle = totalIdle / cpus.length;
        const total = totalTick / cpus.length;
        return +(((total - idle) / total) * 100).toFixed(1);
    } catch {
        return 0;
    }
}

function getUptimeText(seconds) {
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    
    let parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
}

// ==================== GET SERVER STATUS TEXT ====================
function getServerStatusText() {
    const sysStatus = getSystemStatus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramPercent = +((usedMem / totalMem) * 100).toFixed(1);
    const cpuPercent = getCPUUsagePercent();
    const disk = getDiskInfo();
    const swap = getSwapInfo();
    const cores = os.cpus().length;
    const cpuModel = os.cpus()[0]?.model?.replace(/\(R\)|\(TM\)/g, '').trim() || 'Unknown';
    const runtime = process.uptime();
    const sysUptime = os.uptime();
    const isBun = typeof Bun !== 'undefined';
    const heap = process.memoryUsage();

    return `<h2>📊 SERVER STATUS</h2>

<h3>💻 CPU</h3>
<table bordered>
  <tr><td>Model</td><td><code>${cpuModel}</code></td></tr>
  <tr><td>Cores</td><td><b>${cores}</b> Core</td></tr>
  <tr><td>Usage</td><td><b>${cpuPercent}%</b></td></tr>
  <tr><td>Load Avg</td><td><code>${os.loadavg().map(v => v.toFixed(2)).join(' · ')}</code></td></tr>
</table>

<h3>🧠 MEMORY</h3>
<table bordered>
  <tr><td>RAM Used</td><td><b>${formatSize(usedMem)} / ${formatSize(totalMem)} (${ramPercent}%)</b></td></tr>
  <tr><td>RAM Free</td><td><b>${formatSize(freeMem)}</b></td></tr>
  ${swap ? `<tr><td>Swap Used</td><td><b>${formatSize(swap.used)} / ${formatSize(swap.total)} (${swap.percent}%)</b></td></tr>` : ''}
  <tr><td>Heap Used</td><td><b>${formatSize(heap.heapUsed)}</b></td></tr>
  <tr><td>RSS</td><td><b>${formatSize(heap.rss)}</b></td></tr>
</table>

${disk ? `
<h3>💾 DISK</h3>
<table bordered>
  <tr><td>Used</td><td><b>${formatSize(disk.used)} / ${formatSize(disk.total)} (${disk.percent}%)</b></td></tr>
  <tr><td>Free</td><td><b>${formatSize(disk.free)}</b></td></tr>
</table>
` : ''}

<h3>🌐 SYSTEM</h3>
<table bordered>
  <tr><td>Platform</td><td><b>${os.type()} ${os.release()}</b></td></tr>
  <tr><td>Architecture</td><td><b>${os.arch()}</b></td></tr>
</table>

<h3>⏱️ UPTIME</h3>
<table bordered>
  <tr><td>Bot Runtime</td><td><b>${getUptimeText(runtime)}</b></td></tr>
  <tr><td>System Uptime</td><td><b>${getUptimeText(sysUptime)}</b></td></tr>
</table>

<h3>⚙️ RUNTIME</h3>
<table bordered>
  <tr><td>Runtime</td><td><b>${isBun ? `Bun ${Bun.version}` : `Node ${process.version}`}</b></td></tr>
  <tr><td>Engine</td><td><b>${isBun ? 'JavaScriptCore' : `V8 ${process.versions.v8}`}</b></td></tr>
  <tr><td>Total Users</td><td><b>${usersList.length}</b></td></tr>
</table>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@masreymarket</a> | All Rights Reserved</footer>`;
}

// ==================== BACKUP FUNCTIONS ====================
function startAutoBackupCron() {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    createScriptBackup();
  }, TWENTY_FOUR_HOURS);
}

async function createScriptBackup(targetChatId = null) {
  const targetId = targetChatId || mainOwnerIds[0];
  if (!targetId) return;

  const zipFileName = `backup-script-${Date.now()}.zip`;

  try {
    const files = fs.readdirSync(__dirname);
    const lsFiles = files.filter(
      (pe) =>
        pe !== "node_modules" &&
        pe !== ".git" &&
        pe !== ".npm" &&
        pe !== "package-lock.json" &&
        pe !== "yarn.lock" &&
        pe !== zipFileName &&
        pe !== "" &&
        !pe.startsWith(".")
    );

    let zipCommand = 'zip';
    try {
      execSync('which zip', { stdio: 'ignore' });
    } catch (e) {
      zipCommand = 'tar';
    }

    if (zipCommand === 'zip') {
      execSync(`zip -r ${zipFileName} ${lsFiles.join(" ")}`);
    } else {
      execSync(`tar -czf ${zipFileName} ${lsFiles.join(" ")}`);
    }

    const filePath = path.join(__dirname, zipFileName);
    
    let attempts = 0;
    while (!fs.existsSync(filePath) && attempts < 10) {
      await sleep(1000);
      attempts++;
    }

    if (!fs.existsSync(filePath)) {
      throw new Error('File backup tidak ditemukan setelah dibuat');
    }

    const fileStream = fs.createReadStream(filePath);

    await bot.sendDocument(
      targetId,
      fileStream,
      {
        caption: `📦 <b>AUTO BACKUP SCRIPT SUCCESS</b>\n\n📅 <i>${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB</i>\n🤖 Bot: Alight Motion Activator`,
        parse_mode: "HTML"
      },
      { filename: zipFileName, contentType: "application/zip" }
    );

    setTimeout(() => {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
      }
    }, 5000);

  } catch (err) {
    console.error(chalk.red("[!] Error Auto Backup Script:"), err.message);
    if (targetChatId) {
      await sendRichMessage(
        targetChatId,
        `<h3>❌ Gagal Backup Script</h3><p>Pastikan server/Termux mendukung command <code>zip</code> atau <code>tar</code>!</p><pre>${err.message}</pre>`
      );
    }
  }
}

// ==================== AUTO OFF ====================
function startAutoOffCron() {
  setInterval(async () => {
    if (botOffState.scheduledOff) {
      const now = new Date();
      const targetDate = new Date(botOffState.scheduledOff);

      if (now >= targetDate) {
        botOffState.status = "on";
        const timeFormatted = botOffState.scheduledOffText || targetDate.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        
        botOffState.scheduledOff = null;
        botOffState.scheduledOffText = null;
        saveBotDatabase();

        console.log(chalk.red.bold(`[!] BOT OTOMATIS OFFLINE SESUAI JADWAL: ${timeFormatted}`));

        const ownerId = mainOwnerIds[0];
        if (ownerId) {
          const notifyText = `<h2>🔴 BOT OTOMATIS MATI (OFFLINE)</h2>
<p>Bot telah dinonaktifkan secara otomatis sesuai jadwal yang kamu atur!</p>

<table bordered striped>
  <tr><th>Detail</th><th>Keterangan</th></tr>
  <tr><td>Waktu Eksekusi</td><td>${timeFormatted}</td></tr>
  <tr><td>Status Bot</td><td>🔴 Offline</td></tr>
</table>

<hr/>
<footer>© powered by - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

          try {
            await sendRichMessage(ownerId, notifyText);
          } catch (e) {}
        }
      }
    }
  }, 30000);
}

// ==================== UPLOAD FUNCTIONS ====================
async function uploadCatbox(buffer, filename = 'file.mp4') {
    if (!buffer) throw new Error('Buffer kosong');

    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', buffer, filename);

    try {
        const res = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: { ...form.getHeaders() },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        if (!res.data || typeof res.data !== 'string' || !res.data.startsWith('https://')) {
            throw new Error('Response Catbox tidak valid');
        }

        return res.data.trim();
    } catch (e) {
        console.error('Catbox Error:', e);
        throw new Error('Gagal upload video ke Catbox.moe');
    }
}

// ==================== ALIGHT MOTION AUTH ====================
class AlightMotionAuth {
    constructor() {
        this.ORDER_ID = "MASREY";
        this.API_KEY = "AIzaSyDtG1AU22ErnQD60AzBAcaknySiz9_CEq0";
        this.PRODUCT_ID = "am.full.sub.annual.19q4";
        this.TOKEN = "mmgaobamlahbbeccfplmbkbb.AO-J1OzqG0or_GJJIx-ms8GrTm-jaglCRfhQSRPUZKpl2YspYS-oN7_94uv8RC5vQbvd_Ios2pPDStZ2n7F0hLE3FiOU7HS3R6Fquulv5xLXFECSv4ctElw";
        this.SKU_TYPE = "subs";
        this.FIREBASE_INSTANCE_ID_TOKEN = "cSDnCyp3T-uwp07z3tL86T:APA91bFkmvvsHw5nnqa1SBFci-99DRsKClLiETdRrVcJjS5yBx1v_FbCb1d8WhBuea_zmwnYBktyTIzcRhN4b6uNOUur9wPc0gKXmJDoZic0LhNq5V2s0xI";
        this.HEADERS = {
            "Content-Type": "application/json",
            "X-Android-Package": "com.alightcreative.motion",
            "X-Android-Cert": "ECA6BF91B8715A6F810ED0BBFC65B6CD578F52A8",
            "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 15; 23127PN0CC Build/BP1A.250505.005)"
        };
    }

    generateCodeOrder() {
        return crypto.randomInt(10000, 99999).toString();
    }

    extractOobCode(fullUrl) {
        if (!fullUrl) return null;
        try {
            let cleanUrl = fullUrl.replace(/&amp;/g, '&');
            try { cleanUrl = decodeURIComponent(cleanUrl); } catch(e) {}
            
            try {
                const urlObj = new URL(cleanUrl);
                let oobCode = urlObj.searchParams.get('oobCode');
                if (!oobCode) {
                    const nestedLink = urlObj.searchParams.get('link') || urlObj.searchParams.get('q') || urlObj.searchParams.get('url');
                    if (nestedLink) {
                        try {
                            const innerUrlObj = new URL(nestedLink);
                            oobCode = innerUrlObj.searchParams.get('oobCode');
                        } catch (e) {}
                    }
                }
                if (oobCode) return oobCode.replace(/[^a-zA-Z0-9_-]/g, '');
            } catch (e) {}

            const match = cleanUrl.match(/[?&]oobCode=([a-zA-Z0-9_-]+)/i) || cleanUrl.match(/oobCode=([a-zA-Z0-9_-]+)/i);
            if (match && match[1]) {
                return match[1];
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async sendMagicLink(email) {
        try {
            await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/createAuthUri?key=${this.API_KEY}`, { identifier: email, continueUri: "http://localhost" }, { headers: this.HEADERS });
            await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getOobConfirmationCode?key=${this.API_KEY}`, {
                requestType: 6,
                email: email,
                androidInstallApp: true,
                canHandleCodeInApp: true,
                continueUrl: "https://alightcreative.com?ui_sid=0366624874&ui_sd=0",
                iosBundleId: "com.alightcreative.motion",
                androidPackageName: "com.alightcreative.motion",
                androidMinimumVersion: "585",
                clientType: "CLIENT_TYPE_ANDROID"
            }, { headers: this.HEADERS });
            return { status: true, message: "Link berhasil dikirim." };
        } catch (error) {
            const errData = error.response?.data ? (typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data) : error.message;
            return { status: false, message: errData };
        }
    }

    async verifyAndApplyPremium(email, rawLink) {
        try {
            const oobCode = this.extractOobCode(rawLink);
            if (!oobCode) throw new Error("Gagal mengekstrak oobCode.");
            
            const signinRes = await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/emailLinkSignin?key=${this.API_KEY}`, {
                email: email,
                oobCode: oobCode,
                clientType: "CLIENT_TYPE_ANDROID"
            }, { headers: this.HEADERS });

            const idToken = signinRes.data.idToken;
            const accountRes = await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${this.API_KEY}`, { idToken }, { headers: this.HEADERS });
            const user = accountRes.data.users[0];

            const codeorder = this.generateCodeOrder();
            const url = 'https://us-central1-alight-creative.cloudfunctions.net/verifyPurchase';
            const headers = {
                "authorization": "Bearer " + idToken,
                "firebase-instance-id-token": this.FIREBASE_INSTANCE_ID_TOKEN,
                "content-type": "application/json; charset=utf-8",
                "accept-encoding": "gzip",
                "user-agent": "okhttp/3.12.1"
            };
            const response = await axios.post(url, {
                data: {
                    productId: this.PRODUCT_ID,
                    token: this.TOKEN,
                    skuType: this.SKU_TYPE,
                    orderId: this.ORDER_ID + "-" + codeorder
                }
            }, { headers: headers });

            return { 
                status: true, 
                message: "Verifikasi berhasil! Sesi Alight Motion Premium aktif.",
                data: {
                    email: user.email || email,
                    duration: "1 Tahun",
                    purchaseResult: response.data
                }
            };
        } catch (error) {
            const errData = error.response?.data ? (typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data) : error.message;
            return { status: false, message: errData };
        }
    }
}

const amAuth = new AlightMotionAuth();

async function safeSendLink(email) {
    return await amAuth.sendMagicLink(email);
}

async function safeVerifyLink(email, link) {
    return await amAuth.verifyAndApplyPremium(email, link);
}

// ==================== GENERATOR EMAIL ====================
const BASE_URL = 'https://generator.email';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class GeneratorEmail {
    constructor(options = {}) {
        this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
        this.apiToken = null;
        this.cookies = {};
    }

    _storeCookies(response) {
        if (!response || !response.headers) return;
        const rawCookies = response.headers.getSetCookie 
            ? response.headers.getSetCookie() 
            : [response.headers.get('set-cookie')].filter(Boolean);

        for (const cookieStr of rawCookies) {
            if (!cookieStr) continue;
            const parts = cookieStr.split(';')[0].split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const val = parts.slice(1).join('=').trim();
                this.cookies[key] = val;
            }
        }
    }

    _getCookieHeader(extraCookies = {}) {
        const merged = { ...this.cookies, ...extraCookies };
        return Object.entries(merged)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }

    async initSession() {
        try {
            const res = await fetch(BASE_URL + '/', {
                headers: {
                    'User-Agent': this.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });
            this._storeCookies(res);
            const html = await res.text();
            const tokenMatch = html.match(/<meta\s+name="api-token"\s+content="([^"]+)"/);
            if (tokenMatch) {
                this.apiToken = tokenMatch[1];
                return true;
            }
        } catch (err) {}
        return false;
    }

    async getDomains() {
        if (!this.apiToken) {
            await this.initSession();
        }

        if (!this.apiToken) {
            return ['dichvuxe24h.com', 'jiangwy.one', 'submitreports.com', 'user.com'];
        }

        try {
            const res = await fetch(`${BASE_URL}/api/domains.php`, {
                headers: {
                    'User-Agent': this.userAgent,
                    'X-API-Token': this.apiToken,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': BASE_URL + '/',
                    'Cookie': this._getCookieHeader()
                }
            });
            this._storeCookies(res);
            const data = await res.json();
            const domains = data.filter(item => item && item.display).map(item => item.display);
            return domains.length > 0 ? domains : ['dichvuxe24h.com', 'jiangwy.one', 'submitreports.com'];
        } catch (err) {
            return ['dichvuxe24h.com', 'jiangwy.one', 'submitreports.com'];
        }
    }

    async generateEmail(targetDomain = null, customUsername = null) {
        let domain = targetDomain;
        if (!domain) {
            const domains = await this.getDomains();
            domain = domains[Math.floor(Math.random() * domains.length)] || 'dichvuxe24h.com';
        }

        const username = customUsername 
          ? customUsername.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '')
          : Math.random().toString(36).substring(2, 10);
          
        return `${username}@${domain}`;
    }

    async checkInbox(email) {
        if (!email || !email.includes('@')) {
            throw new Error('Format email salah! Gunakan username@domain');
        }

        const [username, domain] = email.split('@');
        const customCookies = {
            'inbox_ctx': `${encodeURIComponent(domain)}%2F${encodeURIComponent(username)}%2F`,
            'embx': `[%22${encodeURIComponent(email)}%22]`,
            'sug': encodeURIComponent(domain)
        };

        try {
            const res = await fetch(`${BASE_URL}/${email}`, {
                headers: {
                    'User-Agent': this.userAgent,
                    'Cookie': this._getCookieHeader(customCookies),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Referer': BASE_URL + '/'
                }
            });
            this._storeCookies(res);
            const html = await res.text();
            return this._parseInboxHtml(email, html);
        } catch (err) {
            return { email, magicLink: null };
        }
    }

    _parseInboxHtml(email, htmlContent) {
        const amRegex = /https:\/\/alight-creative\.firebaseapp\.com[^\s"']+/i;
        const magicMatch = htmlContent.match(amRegex);
        const magicLink = magicMatch ? magicMatch[0].replace(/\\/g, '') : null;

        return {
            email,
            magicLink
        };
    }
}

const GUIDE_DETAILS_HTML = `<details>
  <summary><b>📘 Cara Login / Pakai</b></summary>
  <ol>
    <li>Copy Magic Link di atas. Kirim ke WhatsApp / Telegram</li>
    <li>Buka pesan tersebut. Klik link nya dari dalam WhatsApp / Telegram</li>
    <li>Pilih "Buka di Alight Motion" saat muncul pop up</li>
  </ol>
</details>`;

function cleanHtmlText(text) {
  if (!text) return "";
  return String(text).replace(/<\/?tg-thinking>/gi, "").trim();
}

async function sendRichMessage(chatId, htmlContent, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    rich_message: {
      html: cleanHtmlText(htmlContent)
    }
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  return (await axios.post(`https://api.telegram.org/bot${cfg.botToken}/sendRichMessage`, payload)).data?.result;
}

async function editRichMessage(chatId, messageId, htmlContent, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    rich_message: {
      html: cleanHtmlText(htmlContent)
    }
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  return (await axios.post(`https://api.telegram.org/bot${cfg.botToken}/editMessageText`, payload)).data?.result;
}

async function deleteMessage(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (e) {}
}

async function answerCb(queryId, options = {}) {
  try {
    await bot.answerCallbackQuery(queryId, options);
  } catch (e) {
    if (e?.message?.includes("query is too old") || e?.message?.includes("query ID is invalid")) return;
    console.error("[!] answerCb Error:", e.message);
  }
}

// ==================== RUN AUTO TEMPMAIL ====================
async function runAutoTempmailProcess(targetDomain = null, customUsername = null, userId = null) {
  const gen = new GeneratorEmail();
  const tempEmail = await gen.generateEmail(targetDomain, customUsername);
  const loginUrl = `https://generator.email/${tempEmail}`;

  const sendRes = await safeSendLink(tempEmail);
  if (!sendRes?.status) {
    throw new Error(sendRes?.message || "Gagal mengirim link verifikasi AM.");
  }

  let magicLink = "";
  for (let i = 1; i <= 30; i++) {
    try {
      const inboxData = await gen.checkInbox(tempEmail);
      if (inboxData.magicLink) {
        magicLink = inboxData.magicLink;
        break;
      }
    } catch (e) {}
    await sleep(4000);
  }

  if (!magicLink) {
    throw new Error(`Timeout: Email verifikasi tidak masuk ke inbox ${tempEmail}`);
  }

  await sleep(2000);

  const verifRes = await safeVerifyLink(tempEmail, magicLink);
  if (!verifRes?.status) {
    throw new Error(verifRes?.message || "Gagal verifikasi Magic Link.");
  }

  const expiredText = verifRes.data?.duration || "1 Tahun";

  if (!db.sessions) db.sessions = {};
  db.sessions[tempEmail] = {
    email: tempEmail,
    verifiedAt: new Date().toISOString(),
    status: "verified",
    link: magicLink,
    loginUrl: loginUrl,
    userId: userId ? String(userId) : null
  };
  saveDatabase();

  return {
    email: tempEmail,
    loginUrl: loginUrl,
    status: "Premium ✨",
    expired: expiredText,
    magicLink: magicLink
  };
}

// ==================== CHECK CHANNEL & GROUP ====================
async function isChannelAndGroupMember(userId) {
  for (const channel of CHANNELS) {
    try {
      const member = await bot.getChatMember(channel, userId);
      const isOk = ["member", "administrator", "creator"].includes(member.status);
      if (!isOk) return { success: false, type: 'channel' };
    } catch (error) {
      return { success: false, type: 'channel' };
    }
  }
  
  try {
    const member = await bot.getChatMember(GROUP_CHANNEL_ID, userId);
    const isOk = ["member", "administrator", "creator"].includes(member.status);
    if (!isOk) return { success: false, type: 'group' };
  } catch (error) {
    return { success: false, type: 'group' };
  }
  
  return { success: true };
}

// ==================== RENDER FUNCTIONS ====================
function renderSessionPage(page = 1) {
  if (!db.sessions) db.sessions = {};
  const sessions = Object.values(db.sessions);
  const itemsPerPage = 25;
  const totalItems = sessions.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
  const pageSessions = sessions.slice(startIndex, endIndex);

  let rowsHtml = "";
  pageSessions.forEach((s, i) => {
    rowsHtml += `<tr><td align="center">${startIndex + i + 1}</td><td>${s.email}</td><td align="center">${s.verifiedAt ? "Verified" : "Pending"}</td></tr>`;
  });

  const text = `<h2>🍙 DAFTAR SESSION ALIGHT</h2>

<table bordered striped>
  <tr><th align="center">No</th><th align="center">Email</th><th align="center">Status</th></tr>
  ${rowsHtml}
</table>

<p>Page ${page} dari ${totalPages} | Total Session: ${totalItems}</p>`;

  const navButtons = [];
  if (page > 1) {
    navButtons.push({ text: "⬅️", callback_data: `am_menu_page_${page - 1}`, style: "primary" });
  }
  navButtons.push({ text: `Hal ${page}/${totalPages}`, callback_data: "ignore_page", style: "primary" });
  if (page < totalPages) {
    navButtons.push({ text: "➡️", callback_data: `am_menu_page_${page + 1}`, style: "primary" });
  }

  const inline_keyboard = [];
  if (navButtons.length > 0) {
    inline_keyboard.push(navButtons);
  }
  inline_keyboard.push([{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]);

  return { text, replyMarkup: { inline_keyboard } };
}

function renderUserHistory(userId, page = 1) {
  if (!db.sessions) db.sessions = {};
  const allSessions = Object.values(db.sessions);

  const sessions = isMainOwner(userId)
    ? allSessions
    : allSessions.filter(s => s.userId === String(userId));

  const itemsPerPage = 10;
  const totalItems = sessions.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
  const pageSessions = sessions.slice(startIndex, endIndex);

  let rowsHtml = "";
  pageSessions.forEach((s, i) => {
    const tgl = s.verifiedAt
      ? new Date(s.verifiedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : "-";
    const statusIcon = s.status === "verified" ? "✅" : "⏳";
    rowsHtml += `<tr><td align="center">${startIndex + i + 1}</td><td><code>${s.email}</code></td><td align="center">${statusIcon}</td><td align="center">${tgl}</td></tr>`;
  });

  const emptyRow = totalItems === 0
    ? `<tr><td colspan="4" align="center"><i>Belum ada riwayat aktivasi</i></td></tr>`
    : "";

  const text = `<h2>📋 RIWAYAT AKTIVASI</h2>

<table bordered striped>
  <tr><th align="center">No</th><th align="center">Email</th><th align="center">Status</th><th align="center">Tanggal</th></tr>
  ${rowsHtml || emptyRow}
</table>

<p>Page ${page} dari ${totalPages} | Total: <b>${totalItems}</b> Aktivasi</p>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

  const navButtons = [];
  if (page > 1) {
    navButtons.push({ text: "⬅️", callback_data: `history_page_${page - 1}`, style: "primary" });
  }
  navButtons.push({ text: `${page}/${totalPages}`, callback_data: "ignore_page", style: "primary" });
  if (page < totalPages) {
    navButtons.push({ text: "➡️", callback_data: `history_page_${page + 1}`, style: "primary" });
  }

  const inline_keyboard = [];
  if (navButtons.length > 1 || totalPages > 1) {
    inline_keyboard.push(navButtons);
  }
  inline_keyboard.push([{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]);

  return { text, replyMarkup: { inline_keyboard } };
}

// ==================== MAIN MENU ====================
function getMainMenuText(msgFrom) {
  const username = msgFrom.username ? `@${msgFrom.username}` : "-";
  const nickname = [msgFrom.first_name, msgFrom.last_name].filter(Boolean).join(" ") || "User";
  const id = String(msgFrom.id);
  const isOwner = isMainOwner(msgFrom.id);
  const isVvip = isVVIP(msgFrom.id);
  const status = isOwner ? "developer" : isVvip ? "vvip" : "user";
  const userLimit = isOwner ? "∞ (Unlimited)" : getTotalUserLimit(msgFrom.id);
  const vvipDays = isVvip ? getVVIPRemainingDays(msgFrom.id) : 0;

  let vvipInfo = "";
  if (isVvip) {
    vvipInfo = `<tr><td>VVIP Expired</td><td>${vvipDays} hari tersisa</td></tr>`;
  }

  const sysStatus = getSystemStatus();
  
  // Cek status bot
  const botStatus = botOffState.status === "on" ? "OFFLINE" : "ONLINE";
  const botStatusColor = botOffState.status === "on" ? "🔴" : "🟢";

  return `<tg-collage>
  <img src="${IMAGE_URL}"/>
</tg-collage>

<h2>⊰─「 ALIGHT MOTION PREMIUM 」─⊱</h2>
<p>⚡ Bot Aktivasi Alight Motion Premium tercepat &amp; termudah!</p>

<blockquote>
<b>🔥 Selamat Datang di Bot Alight Motion Premium Activator!</b>
Bot ini adalah solusi terbaik untuk mengaktifkan Alight Motion Premium secara otomatis dan mudah. Dengan sistem yang kami bangun, Anda dapat menikmati fitur premium Alight Motion tanpa ribet dan tanpa perlu mengeluarkan biaya mahal. Bot ini mendukung berbagai metode aktivasi mulai dari Auto Temp-Mail hingga Custom Gmail manual, serta metode terbaru <b>AM V2 Auto Create</b> yang menggunakan API canggih untuk aktivasi lebih cepat dan stabil. Sistem kami sudah teruji dan stabil, didukung oleh teknologi terkini untuk memastikan setiap aktivasi berhasil dengan sempurna. Tunggu apa lagi? Aktifkan Alight Motion Premium Anda sekarang juga!
</blockquote>

<hr/>

<h3>BOT INFO</h3>
<table bordered>
  <tr><th>Detail</th><th>Info</th></tr>
  <tr><td>Developer</td><td><a href="https://t.me/masreymarket">@masreymarket</a></td></tr>
  <tr><td>Version</td><td>3.0</td></tr>
  <tr><td>Status</td><td>${botStatusColor} ${botStatus}</td></tr>
  <tr><td>Node</td><td>${sysStatus.nodeVersion}</td></tr>
  <tr><td>Platform</td><td>${sysStatus.platform} ${sysStatus.arch}</td></tr>
  <tr><td>Runtime</td><td>${sysStatus.runtime}</td></tr>
  <tr><td>Total User</td><td><b>${usersList.length}</b> User</td></tr>
</table>

<h3>USER INFO</h3>
<table bordered>
  <tr><th>Detail</th><th>Info</th></tr>
  <tr><td>Nama</td><td>${nickname}</td></tr>
  <tr><td>Username</td><td>${username}</td></tr>
  <tr><td>ID</td><td><code>${id}</code></td></tr>
  <tr><td>Status</td><td>${status}</td></tr>
  ${vvipInfo}
  <tr><td>Sisa Limit</td><td><b>${userLimit}</b></td></tr>
</table>

<hr/>

<p></p>

<hr/>
<audio src="https://files.catbox.moe/581g2o.mp3"></audio>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@masreymarket</a> | All Rights Reserved</footer>`;
}

function getMainMenuButtons(senderId) {
  const keyboard = [
    [
      { text: "「 ➕ 」Create AM", callback_data: "am_create_options", style: "primary" },
      { text: "「 📋 」Riwayat", callback_data: "history_page_1", style: "primary" }
    ]
  ];

  keyboard.push([
    { text: "📊 Server Status", callback_data: "show_server_status", style: "primary" },
    { text: "📖 Panduan", callback_data: "show_guide", style: "primary" }
  ]);

  keyboard.push([
    { text: "❓ FAQ", callback_data: "show_faq", style: "primary" }
  ]);

  if (isMainOwner(senderId)) {
    keyboard.push([
      { text: "「 📊 」AM Menu", callback_data: "am_menu_page_1", style: "primary" },
      { text: "「 🕷 」Owner Menu", callback_data: "owner_menu", style: "success" }
    ]);
  } else {
    keyboard.push([
      { text: "「 🛒 」Store", callback_data: "store_menu", style: "success" }
    ]);
    keyboard.push([
      { text: "「 🕸 」Owner Bot", url: "https://t.me/masreymarket", style: "success" }
    ]);
  }

  keyboard.push([
    { text: "「 📢 」Channel Info", url: "https://t.me/nokoswavirtual", style: "danger" }
  ]);

  return { inline_keyboard: keyboard };
}

function getChannelGroupButtons() {
  return {
    inline_keyboard: [
      [{ text: "📢 Join Channel", url: "https://t.me/nokoswavirtual", style: "primary" }],
      [{ text: "🔥 Join Group", url: GROUP_LINK, style: "primary" }],
      [{ text: "✅ Sudah Follow & Join", callback_data: "check_follow_group", style: "success" }]
    ]
  };
}

function getAllFiles(dirPath, arrayOfFiles = [], ignoreList = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    const relativePath = path.relative(__dirname, fullPath).replace(/\\/g, "/");

    if (ignoreList.some((ignore) => relativePath.startsWith(ignore) || file === ignore)) {
      return;
    }

    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles, ignoreList);
    } else {
      arrayOfFiles.push({
        fullPath: fullPath,
        relativePath: relativePath
      });
    }
  });

  return arrayOfFiles;
}

function getGuideText() {
  return `<h2>📖 PANDUAN PENGGUNAAN</h2>

<details>
  <summary><b>✉️ Cara Aktivasi dengan Temp-Mail (Otomatis)</b></summary>
  <ol>
    <li>Klik tombol <b>"« ➕ »Create AM"</b> di menu</li>
    <li>Pilih <b>"Temp-Mail"</b> sebagai metode</li>
    <li>Pilih <b>"Auto"</b> atau <b>"Custom Domain"</b></li>
    <li>Sistem akan otomatis membuat email dan verifikasi</li>
    <li>Dapatkan Magic Link dan login ke Alight Motion</li>
  </ol>
</details>

<details>
  <summary><b>📧 Cara Aktivasi dengan Custom Gmail (Manual)</b></summary>
  <ol>
    <li>Klik tombol <b>"« ➕ »Create AM"</b> di menu</li>
    <li>Pilih <b>"Custom Gmail"</b> sebagai metode</li>
    <li>Masukkan email Gmail Anda</li>
    <li>Cek inbox/Spam, klik link verifikasi dari Alight Motion</li>
    <li>Salin URL dan kirimkan ke bot</li>
  </ol>
</details>

<details>
  <summary><b>⚡ Cara Aktivasi dengan AM V2 (Auto - Premium)</b></summary>
  <ol>
    <li>Klik tombol <b>"« ➕ »Create AM"</b> di menu</li>
    <li>Pilih <b>"AM V2"</b> sebagai metode</li>
    <li>Pilih <b>"Single"</b> atau <b>"Bulk"</b></li>
    <li>Sistem akan otomatis membuat email dan verifikasi via API</li>
    <li>Dapatkan Magic Link dan login ke Alight Motion</li>
  </ol>
</details>

<details>
  <summary><b>📦 Cara Bulk Creator</b></summary>
  <ol>
    <li>Klik tombol <b>"« ➕ »Create AM"</b> di menu</li>
    <li>Pilih <b>"Temp-Mail"</b> atau <b>"AM V2"</b> lalu <b>"Bulk"</b></li>
    <li>Masukkan jumlah akun yang diinginkan (1-10)</li>
    <li>Tunggu proses otomatis selesai</li>
    <li>Dapatkan semua akun premium sekaligus</li>
  </ol>
</details>

<details>
  <summary><b>👑 Cara Upgrade VVIP</b></summary>
  <ol>
    <li>Klik tombol <b>"« 🛒 »Store"</b> di menu</li>
    <li>Pilih <b>"VVIP"</b> untuk upgrade atau <b>"Perpanjang"</b></li>
    <li>Pilih paket yang tersedia (1 Bulan, 3 Bulan, 6 Bulan, 1 Tahun)</li>
    <li>Lakukan pembayaran melalui QRIS</li>
    <li>Dapatkan limit unlimited dan akses eksklusif</li>
  </ol>
</details>

<details>
  <summary><b>📦 Cara Tambah Limit Harian</b></summary>
  <ol>
    <li>Klik tombol <b>"« 🛒 »Store"</b> di menu</li>
    <li>Pilih <b>"Limit"</b></li>
    <li>Pilih paket limit (10, 25, 50, atau 100 Limit)</li>
    <li>Lakukan pembayaran melalui QRIS</li>
    <li>Limit akan langsung bertambah di akun Anda</li>
  </ol>
</details>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@masreymarket</a> | All Rights Reserved</footer>`;
}

function getFaqText() {
  return `<h2>❓ FAQ (Frequently Asked Questions)</h2>

<details>
  <summary><b>🔰 Apa itu Alight Motion Premium?</b></summary>
  <p>Alight Motion Premium adalah versi berbayar dari aplikasi editing video dan animasi populer yang memberikan akses ke semua fitur premium, tanpa watermark, dan efek-efek eksklusif.</p>
</details>

<details>
  <summary><b>🔰 Apakah bot ini aman digunakan?</b></summary>
  <p>Ya, bot ini menggunakan metode aktivasi resmi dan aman. Tidak ada risiko banned atau masalah keamanan karena menggunakan jalur verifikasi email resmi dari Google.</p>
</details>

<details>
  <summary><b>🔰 Berapa lama proses aktivasi?</b></summary>
  <p>Untuk metode Auto Temp-Mail, proses memakan waktu sekitar 30-60 detik. Untuk Custom Gmail, tergantung seberapa cepat Anda menerima email verifikasi. Untuk AM V2, proses lebih cepat sekitar 20-40 detik.</p>
</details>

<details>
  <summary><b>🔰 Kenapa limit saya habis?</b></summary>
  <p>Setiap pengguna mendapatkan ${DAILY_LIMIT} limit per hari. Jika habis, Anda bisa membeli limit tambahan melalui Store atau menunggu reset besok.</p>
</details>

<details>
  <summary><b>🔰 Bagaimana cara mendapatkan Magic Link?</b></summary>
  <p>Magic Link akan muncul otomatis di chat setelah proses aktivasi selesai. Untuk Custom Gmail, Magic Link didapat dari email verifikasi yang dikirim.</p>
</details>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@masreymarket</a> | All Rights Reserved</footer>`;
}

// ==================== CHECK MAINTENANCE ====================
async function checkMaintenance(chatId, senderId) {
  if (isMainOwner(senderId)) return false;

  const timeNow = new Date().toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  if (botOffState.status === "on") {
    const textOff = `<h2>🔴 BOT SEDANG OFFLINE</h2>

<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>Status Bot</td><td>🔴 Offline</td></tr>
  <tr><td>Waktu Server</td><td>${timeNow} WIB</td></tr>
  <tr><td>Fitur Aktivasi</td><td>Dinonaktifkan Sementara</td></tr>
</table>

<aside>
  Bot sedang di-nonaktifkan sementara oleh Owner. Silakan tunggu hingga bot diaktifkan kembali!
</aside>

<footer>© powered by  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    const buttons = {
      inline_keyboard: [
        [{ text: "Hubungi Admin", url: "https://t.me/masreymarket", style: "primary" }]
      ]
    };

    await sendRichMessage(chatId, textOff, buttons);
    return true;
  }

  if (maintenance.status === "on") {
    const textMaint = `<h2>⛔ BOT SEDANG MAINTENANCE</h2>

<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>Status Bot</td><td>🟡 Maintenance</td></tr>
  <tr><td>Waktu Server</td><td>${timeNow} WIB</td></tr>
  <tr><td>Fitur Aktivasi</td><td>Pemeliharaan Sistem</td></tr>
</table>

<aside>
  Bot sedang dalam peningkatan performa & pemeliharaan sistem. Semua fitur aktivasi di-nonaktifkan sementara waktu hingga perbaikan selesai.
</aside>

<footer>© powered by  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    const buttons = {
      inline_keyboard: [
        [{ text: "Hubungi Admin", url: "https://t.me/masreymarket", style: "primary" }]
      ]
    };

    await sendRichMessage(chatId, textMaint, buttons);
    return true;
  }

  return false;
}

// ==================== START BOT DISPLAY ====================
function startBot() {
  const steps = 20;
  let progress = 0;

  const interval = setInterval(() => {
    const percent = Math.floor((progress / steps) * 100);
    const filled = "█".repeat(progress);
    const empty = "░".repeat(steps - progress);

    let color;
    if (percent < 30) color = chalk.greenBright;
    else if (percent < 60) color = chalk.yellowBright;
    else if (percent < 90) color = chalk.magentaBright;
    else color = chalk.redBright;

    console.clear();
    console.log(chalk.bold("🔥 Memulai Bot Telegram...\n"));
    console.log(color(`${filled}${empty} ${percent}%`));

    progress++;

    if (progress > steps) {
      clearInterval(interval);
      console.clear();
      console.log(
        chalk.cyan(`
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░"░▓▓
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒░ ¡░┐▓▓
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░▒▒░┐░┐░┐▓▓
▓▓▓▓▓▓░▒▒▒▓▓▓▓▓▓▓▓░░░┐░┐░░░▓▓
▓▓▓▓▓░░░▒▒▒▒▒▒▓▓▓▓░░░░░░░░▓▓
▓▓▓▓▓░░░░▒▒▒▒▒▒▒▒▒▒░░░░░░░▓▓
▓▓▓▓▓░░░░░░░▒▒▒▒▒▒▒▒▒░░░░░░▓▓
▓▓▓▓▓░░░░░░░░░░▒▒▒▒▒▒▒░░░░░▓▓
▓░░░░░░░░░░░░░░░░░░░▒▒▒░░░░░▓▓
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓
▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓
▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓
▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓
▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓
▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓
▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░▓
▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░▓
▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░▓
    `)
  );

      const label = (text) => chalk.cyan.bold(text.padEnd(16));

      console.log(`${label("   ❯ Developer")} : ${chalk.blue("t.me/masreymarket")}`);
      console.log(`${label("   ❯ Version")} : ${chalk.yellow("3.0")}`);
      console.log(`${label("   ❯ Information")} : ${chalk.magenta("https://t.me/masreymarket")}`);
    }
  }, 150);
}

// ==================== BOT COMMAND HANDLERS ====================

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  registerUser(senderId, msg.from.username);
  
  logStart(msg.from);

  if (await checkMaintenance(chatId, senderId)) return;

  const memberCheck = await isChannelAndGroupMember(senderId);

  if (!memberCheck.success) {
    let text = `<h2>⊰─「 Akses Dibatasi 」─⊱</h2>
<p>Wajib Follow Channel dan Join Group di bawah ini untuk menggunakan bot!</p>`;

    if (memberCheck.type === 'channel') {
      text += `<p>❌ Anda belum mengikuti <b>Channel</b> kami!</p>`;
    } else if (memberCheck.type === 'group') {
      text += `<p>❌ Anda belum bergabung ke <b>Group</b> kami!</p>`;
    }

    text += `<hr/><footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    return sendRichMessage(chatId, text, getChannelGroupButtons());
  }

  const randomDraftId = Math.floor(100000 + Math.random() * 900000);
  try {
    await axios.post(`https://api.telegram.org/bot${cfg.botToken}/sendRichMessageDraft`, {
      chat_id: chatId,
      draft_id: randomDraftId,
      rich_message: {
        html: `<tg-thinking>⚙️ Sedang memuat menu utama...</tg-thinking>`
      }
    });
    await sleep(3000);
  } catch (e) {}

  const htmlText = getMainMenuText(msg.from);
  const buttons = getMainMenuButtons(senderId);

  await sendRichMessage(chatId, htmlText, buttons);
});

// ==================== BOT COMMANDS (Owner) ====================

// /bot
bot.onText(/\/(bot|offline)(?:\s+(off|on))?(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  const option = match[2] ? match[2].toLowerCase() : null;
  const timeString = match[3] ? match[3].trim() : null;

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  if (option === "on") {
    botOffState.status = "off";
    botOffState.scheduledOff = null;
    botOffState.scheduledOffText = null;
    saveBotDatabase();

    logBotControl(msg.from, 'Hidupkan');

    return sendRichMessage(chatId, "<h2>🟢 BOT BERHASIL DIHIDUPKAN</h2><p>Bot sekarang dalam kondisi Online & Siap digunakan kembali.</p>");
  }

  if (option === "off" && timeString) {
    const regex = /^(\d{2}):(\d{2}):(\d{2})(?:\s*WIB)?\s*-\s*(\d{2})-(\d{2})-(\d{4})$/i;
    const matchTime = timeString.match(regex);

    if (!matchTime) {
      const errFormat = `<h3>❌ Format Jadwal Off Salah</h3>
<p>Gunakan format berikut:</p>
<pre>/bot off HH:mm:ss WIB - DD-MM-YYYY</pre>
<p><b>Contoh:</b></p>
<code>/bot off 07:00:00 WIB - 22-08-2026</code>`;
      return sendRichMessage(chatId, errFormat);
    }

    const [, hours, minutes, seconds, day, month, year] = matchTime;
    const targetIsoString = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+07:00`;
    const targetDate = new Date(targetIsoString);

    if (isNaN(targetDate.getTime())) {
      return sendRichMessage(chatId, "<h3>❌ Jam / Tanggal Tidak Valid!</h3>");
    }

    if (targetDate <= new Date()) {
      return sendRichMessage(chatId, "<h3>❌ Jam & Tanggal Harus di Masa Depan!</h3>");
    }

    botOffState.scheduledOff = targetDate.toISOString();
    botOffState.scheduledOffText = `${hours}:${minutes}:${seconds} WIB - ${day}-${month}-${year}`;
    saveBotDatabase();

    logBotControl(msg.from, 'Jadwalkan Mati', botOffState.scheduledOffText);

    const successText = `<h2>⏱️ JADWAL AUTO-OFF BOT BERHASIL SET</h2>
<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Status Auto-Off</td><td>🟢 Scheduled</td></tr>
  <tr><td>Waktu Mati Otomatis</td><td><b>${botOffState.scheduledOffText}</b></td></tr>
</table>
<aside>Bot akan secara otomatis mati (OFF) saat jam & tanggal tersebut tiba.</aside>
<hr/>
<footer>© powered by - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    return sendRichMessage(chatId, successText);
  }

  if (option === "off" && !timeString) {
    botOffState.status = "on";
    botOffState.scheduledOff = null;
    botOffState.scheduledOffText = null;
    saveBotDatabase();

    logBotControl(msg.from, 'Matikan Sekarang');

    return sendRichMessage(chatId, "<h2>🔴 BOT BERHASIL DIMATIKAN</h2><p>Bot sekarang dalam kondisi Offline.</p>");
  }

  const currentStatus = botOffState.status === "on" ? "🔴 Offline" : "🟢 Online";
  const scheduledInfo = botOffState.scheduledOffText ? botOffState.scheduledOffText : "Tidak Ada";

  const text = `<h2>🤖 FITUR BOT OFFLINE CONTROL</h2>
<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Status Bot</td><td>${currentStatus}</td></tr>
  <tr><td>Jadwal Auto-Off</td><td>${scheduledInfo}</td></tr>
</table>

<hr/>
<h3>📌 Format Command:</h3>
<ul>
  <li><code>/bot off</code> (Matikan bot sekarang)</li>
  <li><code>/bot off 07:00:00 WIB - 22-08-2026</code> (Jadwalkan mati)</li>
  <li><code>/bot on</code> (Hidupkan bot & batalkan jadwal)</li>
</ul>
<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

  return sendRichMessage(chatId, text);
});

// /maintenance
bot.onText(/\/maintenance(?:\s+(on|off))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  const option = match[1] ? match[1].toLowerCase() : null;

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  if (option === "off") {
    maintenance.status = "off";
    saveMaintenanceDatabase();

    logMaintenance(msg.from, 'off');

    const timeNow = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const broadcastText = `<h2>⛔ BOT SEDANG AKTIF</h2>
<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>Status</td><td>🟢 Online</td></tr>
  <tr><td>Waktu</td><td>${timeNow} WIB</td></tr>
  <tr><td>Aktivasi AM</td><td>Normal / Siap Digunakan</td></tr>
</table>
<aside>Bot sudah selesai dari Maintenance. Silakan gunakan bot kembali!</aside>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    const noticeText = `<h2>⏳ PERUBAHAN MODE MAINTENANCE</h2><p>Mode maintenance diubah menjadi <b>OFF</b>. Memulai Auto-Broadcast ke ${usersList.length} user...</p>`;
    const processMsg = await sendRichMessage(chatId, noticeText);

    let successCount = 0;
    let failedCount = 0;

    for (const targetId of usersList) {
      try {
        await sendRichMessage(targetId, broadcastText);
        successCount++;
      } catch (e) {
        failedCount++;
      }
    }

    const reportText = `<h2>✅ Mode Maintenance Di-Matikan!</h2>
<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Status Mode</td><td>🟢 ONLINE</td></tr>
  <tr><td>Berhasil Dikirimi</td><td>${successCount} User</td></tr>
  <tr><td>Gagal Dikirimi</td><td>${failedCount} User</td></tr>
</table>
<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    return editRichMessage(chatId, processMsg.message_id, reportText);
  }

  if (option === "on") {
    maintenance.status = "on";
    saveMaintenanceDatabase();

    logMaintenance(msg.from, 'on');

    const timeNow = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const broadcastText = `<h2>⛔ BOT SEDANG MAINTENANCE</h2>
<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>Status</td><td>🟡 Maintenance Mode</td></tr>
  <tr><td>Waktu</td><td>${timeNow} WIB</td></tr>
  <tr><td>Aktivasi AM</td><td>Nonaktif Sementara</td></tr>
</table>
<aside>Bot sedang dalam pemeliharaan sistem. Semua fitur nonaktif sementara waktu.</aside>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    const noticeText = `<h2>⏳ PERUBAHAN MODE MAINTENANCE</h2><p>Mode maintenance diubah menjadi <b>ON</b>. Memulai Auto-Broadcast ke ${usersList.length} user...</p>`;
    const processMsg = await sendRichMessage(chatId, noticeText);

    let successCount = 0;
    let failedCount = 0;

    for (const targetId of usersList) {
      try {
        await sendRichMessage(targetId, broadcastText);
        successCount++;
      } catch (e) {
        failedCount++;
      }
    }

    const reportText = `<h2>✅ Mode Maintenance Berhasil Diaktifkan!</h2>
<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Status Mode</td><td>🟡 MAINTENANCE (ON)</td></tr>
  <tr><td>Berhasil Dikirimi</td><td>${successCount} User</td></tr>
  <tr><td>Gagal Dikirimi</td><td>${failedCount} User</td></tr>
</table>
<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    return editRichMessage(chatId, processMsg.message_id, reportText);
  }

  const currentStatus = maintenance.status === "on" ? "🟡 Maintenance" : "🟢 Online";

  const text = `<h2>⚙️ FITUR MAINTENANCE CONTROL</h2>
<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Status Bot</td><td>${currentStatus}</td></tr>
</table>

<hr/>
<h3>📌 Format Command:</h3>
<ul>
  <li><code>/maintenance on</code> (Matikan fitur untuk maintenance)</li>
  <li><code>/maintenance off</code> (Hidupkan fitur kembali)</li>
</ul>
<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

  return sendRichMessage(chatId, text);
});

// /broadcast
bot.onText(/\/(bc|broadcast)(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  
  let broadcastText = match[2] ? match[2].trim() : "";

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  let mediaType = null;
  let mediaUrl = null;

  if (msg.reply_to_message) {
    const replyMsg = msg.reply_to_message;

    if (!broadcastText && replyMsg.caption) {
      broadcastText = replyMsg.caption;
    }

    if (replyMsg.photo || replyMsg.video) {
      const isPhoto = !!replyMsg.photo;
      const fileId = isPhoto ? replyMsg.photo[replyMsg.photo.length - 1].file_id : replyMsg.video.file_id;
      const fileExt = isPhoto ? 'jpg' : 'mp4';
      mediaType = isPhoto ? 'image' : 'video';

      const uploaderName = isPhoto ? 'Top4Top' : 'Catbox';
      const processMsg = await sendRichMessage(chatId, `<h2>⏳ PROSES UPLOAD MEDIA</h2><p>Mengunduh ${mediaType} dari Telegram & mengunggah ke ${uploaderName}...</p>`);
      
      try {
        const fileLink = await bot.getFileLink(fileId);
        const fileStream = await axios.get(fileLink, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(fileStream.data);
        
        if (isPhoto) {
          mediaUrl = await uploadtop4top(buffer, `broadcast_${Date.now()}.${fileExt}`);
        } else {
          mediaUrl = await uploadCatbox(buffer, `broadcast_${Date.now()}.${fileExt}`);
        }

        await deleteMessage(chatId, processMsg.message_id);
      } catch (err) {
        await editRichMessage(chatId, processMsg.message_id, `<h3>❌ Upload Media Gagal</h3><p>${err.message}</p>`);
        return;
      }
    }
  }

  if (!broadcastText) {
    const usageText = `<h3>📢 Format Broadcast Salah</h3>
<p>Gunakan perintah:</p>
<pre>/bc &lt;pesan&gt;</pre>
<p><i>Atau reply Foto/Video dengan perintah <code>/bc</code></i></p>`;
    return sendRichMessage(chatId, usageText);
  }

  if (usersList.length === 0) {
    return sendRichMessage(chatId, "<h3>📭 Database User Kosong</h3>");
  }

  const startBcText = `<h2>📢 PROSES BROADCAST</h2><p>Sedang memproses pengiriman pesan Rich HTML ke ${usersList.length} user...</p>`;
  const processMsg = await sendRichMessage(chatId, startBcText);

  let successCount = 0;
  let failedCount = 0;

  let finalRichHtml = "";
  if (mediaUrl) {
    if (mediaType === 'image') {
      finalRichHtml += `<tg-collage>\n  <img src="${mediaUrl}"/>\n</tg-collage>\n\n`;
    } else if (mediaType === 'video') {
      finalRichHtml += `<video src="${mediaUrl}"></video>\n\n`;
    }
  }

  finalRichHtml += `<h2>📢 BROADCAST ANNOUNCEMENT</h2>\n<p>${broadcastText.replace(/\n/g, "<br/>")}</p>\n<hr/>\n<footer>© Broadcast from Owner - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

  for (const targetId of usersList) {
    try {
      await sendRichMessage(targetId, finalRichHtml);
      successCount++;
    } catch (e) {
      failedCount++;
    }
  }

  logBroadcast(msg.from, usersList.length, successCount, failedCount);

  const reportText = `<h2>✅ Broadcast Selesai!</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Total User</td><td align="center">${usersList.length}</td></tr>
  <tr><td>Berhasil</td><td align="center">${successCount}</td></tr>
  <tr><td>Gagal</td><td align="center">${failedCount}</td></tr>
</table>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

  await editRichMessage(chatId, processMsg.message_id, reportText);
});

// /backup
bot.onText(/\/backup(?:\s+([\s\S]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const senderId = msg.from.id;
  const inputData = match[1] ? match[1].trim() : "";

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  if (!inputData || inputData.toLowerCase() === "script" || inputData.toLowerCase() === "zip") {
    const processMsg = await sendRichMessage(chatId, "<h2>⏳ PROSES BACKUP SCRIPT</h2><p>Sedang mengompresi source code ke file .zip...</p>");
    
    logBackup(msg.from, 'Script Backup');
    await createScriptBackup(chatId);
    
    if (processMsg && processMsg.message_id) {
      try {
        await bot.deleteMessage(chatId, processMsg.message_id);
      } catch (e) {}
    }
    return;
  }

  if (!inputData.includes("|")) {
    const usageText = `<h3>📌 Format Backup Salah</h3>
<p><b>1. Backup Chat (Zip):</b></p>
<pre>/backup script</pre>

<p><b>2. Backup GitHub:</b></p>
<pre>/backup token_github|username_github|nama_repo</pre>`;
    return sendRichMessage(chatId, usageText);
  }

  const parts = inputData.split("|");
  if (parts.length < 3) {
    return sendRichMessage(chatId, "<h3>📌 Format Backup GitHub Tidak Lengkap</h3>");
  }

  const token = parts[0].trim();
  const owner = parts[1].trim();
  const repo = parts[2].trim();

  await deleteMessage(chatId, messageId);

  const startBackupText = `<h2>⏳ SINKRONISASI BACKUP GITHUB</h2><p>Memproses upload file utama ke repository GitHub...</p>`;
  const processMsg = await sendRichMessage(chatId, startBackupText);

  logBackup(msg.from, 'GitHub Backup');

  try {
    try {
      await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Authorization: `token ${token}` }
      });
    } catch (e) {
      await axios.post(
        "https://api.github.com/user/repos",
        { name: repo, private: false, auto_init: false },
        {
          headers: {
            Authorization: `token ${token}`,
            "Content-Type": "application/json"
          }
        }
      );
    }

    const allowedFiles = [
      "config.js",
      "index.js",
      "package.json",
      "database/database.json",
      "database/users.json",
      "database/limit.json",
      "database/maintenance.json",
      "database/bot.json",
      "database/vvip.json",
      "database/payment.json",
      "lib/betabotz.js"
    ];

    const allFiles = getAllFiles(__dirname, [], ["node_modules", ".git", ".npm", ".npm-cache"]);
    const filesToBackup = allFiles.filter((fileItem) =>
      allowedFiles.includes(fileItem.relativePath)
    );

    let uploadedCount = 0;
    let failedCount = 0;

    for (const fileItem of filesToBackup) {
      try {
        const fileData = fs.readFileSync(fileItem.fullPath);
        const base64Content = fileData.toString("base64");
        const filePath = fileItem.relativePath;
        const encodedPath = filePath.split("/").map((v) => encodeURIComponent(v)).join("/");
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

        let sha = null;
        try {
          const check = await axios.get(url, {
            headers: { Authorization: `token ${token}` }
          });
          sha = check.data.sha;
        } catch (error) {}

        await axios.put(
          url,
          {
            message: sha ? `Update ${filePath}` : `Add ${filePath}`,
            content: base64Content,
            sha: sha || undefined
          },
          {
            headers: {
              Authorization: `token ${token}`,
              "Content-Type": "application/json"
            }
          }
        );

        uploadedCount++;
      } catch (err) {
        failedCount++;
      }
    }

    const resultText = `<h2>✅ Backup ke GitHub Berhasil!</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Repository</td><td><code>${owner}/${repo}</code></td></tr>
  <tr><td>File Ter-backup</td><td>${uploadedCount} dari ${allowedFiles.length} File Utama</td></tr>
  <tr><td>Gagal</td><td>${failedCount} File</td></tr>
  <tr><td>Link Repo</td><td><a href="https://github.com/${owner}/${repo}">Klik Di Sini</a></td></tr>
</table>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    await editRichMessage(chatId, processMsg.message_id, resultText);
  } catch (error) {
    await editRichMessage(chatId, processMsg.message_id, `<h3>❌ Backup Gagal!</h3><p>${error.response?.data?.message || error.message}</p>`);
  }
});

// /setlimit
bot.onText(/\/setlimit(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  const input = match[1] ? parseInt(match[1], 10) : NaN;

  if (isNaN(input) || input < 1 || input > MAX_LIMIT) {
    return sendRichMessage(chatId, `<h3>❌ Format Salah</h3>
<p>Gunakan: <code>/setlimit &lt;angka&gt;</code></p>
<pre>Contoh: /setlimit 10</pre>
<p>Angka harus antara <b>1</b> sampai <b>${MAX_LIMIT}</b>.</p>`);
  }

  const now = Date.now();
  let setCount = 0;

  for (const userId of usersList) {
    if (isMainOwner(userId)) continue;
    userLimits[userId] = { limit: input, lastReset: now };
    setCount++;
  }
  saveLimitDatabase();

  logSetLimit(msg.from, input, setCount);

  return sendRichMessage(chatId, `<h2>✅ Set Limit Berhasil!</h2>

<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>User Di-update</td><td><b>${setCount}</b> User</td></tr>
  <tr><td>Limit Baru</td><td><b>${input}</b> Limit / User</td></tr>
</table>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`);
});

// /resetlimit
bot.onText(/\/resetlimit/, async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  const now = Date.now();
  let resetCount = 0;

  for (const userId of usersList) {
    if (isMainOwner(userId)) continue;
    if (bonusLimits[userId] && bonusLimits[userId].remaining > 0) continue;
    userLimits[userId] = { limit: DAILY_LIMIT, lastReset: now };
    resetCount++;
  }
  saveLimitDatabase();

  logResetLimit(msg.from, resetCount);

  return sendRichMessage(chatId, `<h2>🔄 Reset Limit Berhasil!</h2>

<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>User Di-reset</td><td><b>${resetCount}</b> User</td></tr>
  <tr><td>Limit Sekarang</td><td><b>${DAILY_LIMIT}</b> Limit / User</td></tr>
</table>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`);
});

// /addlimit
bot.onText(/\/addlimit(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  const args = (match[1] || "").trim().split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

  if (args.length < 2) {
    return sendRichMessage(chatId, `<h3>❌ Format Salah</h3>
<p>Gunakan: <code>/addlimit &lt;id|@username&gt; &lt;jumlah&gt; [durasi]</code></p>
<pre>Contoh:
/addlimit 193838938 100
/addlimit 193838938 100 30d
/addlimit @username 50 7d</pre>
<p>Durasi: 1d, 7d, 30d, dst. Jika tidak diisi = 1 hari.</p>`);
  }

  let targetRaw = args[0];
  const jumlah = parseInt(args[1], 10);
  const durasiStr = args[2] || "1d";

  if (isNaN(jumlah) || jumlah < 1) {
    return sendRichMessage(chatId, "<h3>❌ Format Salah</h3><p>Jumlah limit harus angka positif.</p>");
  }

  const durasiMatch = durasiStr.match(/^(\d+)d$/i);
  if (!durasiMatch) {
    return sendRichMessage(chatId, "<h3>❌ Format Durasi Salah</h3><p>Gunakan format: <code>30d</code>, <code>7d</code>, <code>1d</code></p>");
  }
  const durasiHari = parseInt(durasiMatch[1], 10);
  const now = Date.now();
  const expiresAt = now + durasiHari * 24 * 60 * 60 * 1000;

  const targetId = resolveUserId(targetRaw);

  if (!targetId) {
    return sendRichMessage(chatId, `<h3>❌ User Tidak Ditemukan</h3><p>Username <code>${targetRaw}</code> belum pernah pakai bot ini, atau ID salah.</p><p>Pastikan user sudah pernah /start dulu.</p>`);
  }

  const key = String(targetId);

  if (bonusLimits[key] && bonusLimits[key].expiresAt && now < bonusLimits[key].expiresAt) {
    bonusLimits[key].dailyLimit += jumlah;
    bonusLimits[key].remaining += jumlah;
    bonusLimits[key].expiresAt = expiresAt;
  } else {
    bonusLimits[key] = {
      dailyLimit: jumlah,
      remaining: jumlah,
      lastReset: now,
      expiresAt: expiresAt
    };
  }
  saveBonusLimitDatabase();

  logAddLimit(msg.from, targetId, jumlah, durasiHari);

  const expiresDate = new Date(expiresAt).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });

  return sendRichMessage(chatId, `<h2>✅ Tambah Limit Berhasil!</h2>

<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>Target</td><td><code>${key}</code></td></tr>
  <tr><td>Limit Ditambah</td><td><b>${jumlah}</b> Limit / Hari</td></tr>
  <tr><td>Durasi</td><td><b>${durasiHari} Hari</b></td></tr>
  <tr><td>Berlaku Sampai</td><td>${expiresDate}</td></tr>
  <tr><td>Reset</td><td>Setiap hari jam 00.00</td></tr>
</table>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`);
});

// /users - Melihat daftar pengguna (HANYA OWNER)
bot.onText(/\/users(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  const page = match[1] ? parseInt(match[1], 10) : 1;
  const users = Object.values(userActivity);
  const totalUsers = users.length;
  const itemsPerPage = 10;
  const totalPages = Math.ceil(totalUsers / itemsPerPage) || 1;
  
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  
  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalUsers);
  const pageUsers = users.slice(startIndex, endIndex);
  
  let rowsHtml = '';
  if (pageUsers.length === 0) {
    rowsHtml = `<tr><td colspan="4" align="center"><i>Belum ada pengguna</i></td></tr>`;
  } else {
    pageUsers.forEach((user, i) => {
      const username = user.username || '-';
      const firstSeen = user.firstSeen ? new Date(user.firstSeen).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      }) : '-';
      rowsHtml += `<tr>
        <td>${startIndex + i + 1}</td>
        <td><code>${user.userId}</code></td>
        <td>${username}</td>
        <td>${firstSeen}</td>
        <td>${user.totalActions}</td>
      </tr>`;
    });
  }

  const text = `<h2>📊 DAFTAR PENGGUNA BOT</h2>

<table bordered striped>
  <tr><th>#</th><th>User ID</th><th>Username</th><th>Start Bot</th><th>Total Aksi</th></tr>
  ${rowsHtml}
</table>

<p>Halaman ${page} dari ${totalPages} | Total Pengguna: <b>${totalUsers}</b></p>

<hr/>
<footer>© running since 2026 - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

  const navButtons = [];
  if (page > 1) {
    navButtons.push({ text: "⬅️", callback_data: `users_page_${page - 1}`, style: "primary" });
  }
  navButtons.push({ text: `${page}/${totalPages}`, callback_data: "ignore_page", style: "primary" });
  if (page < totalPages) {
    navButtons.push({ text: "➡️", callback_data: `users_page_${page + 1}`, style: "primary" });
  }

  const inline_keyboard = [];
  if (navButtons.length > 0) {
    inline_keyboard.push(navButtons);
  }
  inline_keyboard.push([{ text: "↺ Kembali ke Owner Menu", callback_data: "owner_menu", style: "danger" }]);

  return sendRichMessage(chatId, text, { inline_keyboard });
});

// /userdetail - Melihat detail pengguna (HANYA OWNER)
bot.onText(/\/userdetail(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (!isMainOwner(senderId)) {
    return sendRichMessage(chatId, "<h3>❌ Akses Ditolak</h3><p>Perintah ini hanya dapat digunakan oleh Owner!</p>");
  }

  const targetId = match[1] ? parseInt(match[1], 10) : null;
  
  if (!targetId) {
    const text = `<h3>❌ Format Salah</h3>
<p>Gunakan: <code>/userdetail &lt;user_id&gt;</code></p>
<pre>Contoh: /userdetail 8347420543</pre>`;
    return sendRichMessage(chatId, text);
  }

  const userData = getUserActivity(targetId);
  if (!userData) {
    return sendRichMessage(chatId, `<h3>❌ User Tidak Ditemukan</h3><p>User ID <code>${targetId}</code> belum terdaftar.</p>`);
  }

  const info = formatUserActivity(userData);
  const isVvip = isVVIP(targetId);
  const vvipDays = isVvip ? getVVIPRemainingDays(targetId) : 0;
  const totalLimit = getTotalUserLimit(targetId);

  const text = `<h2>👤 DETAIL PENGGUNA</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>🆔 User ID</td><td><code>${userData.userId}</code></td></tr>
  <tr><td>🔗 Username</td><td>${userData.username || '-'}</td></tr>
  <tr><td>📅 Start Bot</td><td>${info.firstSeen}</td></tr>
  <tr><td>🕐 Terakhir Aktif</td><td>${info.lastSeen}</td></tr>
  <tr><td>📊 Total Aksi</td><td><b>${info.totalActions}</b></td></tr>
  <tr><td>👑 Status VVIP</td><td>${isVvip ? `✅ Active (${vvipDays} hari)` : '❌ Tidak Aktif'}</td></tr>
  <tr><td>📦 Sisa Limit</td><td><b>${totalLimit}</b></td></tr>
</table>

<hr/>
${info.actionsHtml}

<hr/>
<footer>© running since 2026 - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

  const buttons = {
    inline_keyboard: [
      [{ text: "📊 Daftar Pengguna", callback_data: "users_page_1", style: "primary" }],
      [{ text: "↺ Kembali ke Owner Menu", callback_data: "owner_menu", style: "danger" }]
    ]
  };

  return sendRichMessage(chatId, text, buttons);
});

// ==================== CALLBACK QUERY ====================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const senderId = query.from.id;
  const action = query.data;

  if (await checkMaintenance(chatId, senderId)) {
    return answerCb(query.id, { text: "⚠️ Bot sedang maintenance / offline!", show_alert: true });
  }

  try {
    if (action === "ignore_page") {
      return answerCb(query.id);
    }

    if (action === "check_follow_group") {
      const memberCheck = await isChannelAndGroupMember(senderId);
      
      if (!memberCheck.success) {
        let errorMsg = "❌ ";
        if (memberCheck.type === 'channel') {
          errorMsg += "Kamu belum follow semua channel!";
        } else if (memberCheck.type === 'group') {
          errorMsg += "Kamu belum join group!";
        }
        return answerCb(query.id, { text: errorMsg, show_alert: true });
      }

      await answerCb(query.id, { text: "✅ Verifikasi berhasil!" });

      await deleteMessage(chatId, messageId);

      const randomDraftId = Math.floor(100000 + Math.random() * 900000);
      try {
        await axios.post(`https://api.telegram.org/bot${cfg.botToken}/sendRichMessageDraft`, {
          chat_id: chatId,
          draft_id: randomDraftId,
          rich_message: {
            html: `<tg-thinking>Verifikasi sukses, memuat menu...</tg-thinking>`
          }
        });
        await sleep(3000);
      } catch (e) {}

      const htmlText = getMainMenuText(query.from);
      const buttons = getMainMenuButtons(senderId);

      return sendRichMessage(chatId, htmlText, buttons);
    }

    // ==================== OWNER MENU ====================
    if (action === "owner_menu") {
      if (!isMainOwner(senderId)) {
        return answerCb(query.id, { text: "❌ Fitur ini hanya untuk Owner!", show_alert: true });
      }

      await answerCb(query.id);

      const ownerText = `<h2>§ Owner Menu</h2>
<p>Selamat datang di menu Owner dari bot Alight Motion Premium Activator! Ini adalah daftar command khusus Owner untuk pengelolaan bot:</p>

<hr/>
<h3>🤖 BOT INFORMATION</h3>
<table bordered striped>
  <tr><th>Information</th><th>Detail</th></tr>
  <tr><td>Author</td><td>t.me/masreymarket</td></tr>
  <tr><td>Version</td><td>3.0</td></tr>
  <tr><td>Status</td><td>🟢 Online</td></tr>
  <tr><td>Language</td><td>JavaScript</td></tr>
</table>

<hr/>
<h3>👥 USER MANAGEMENT</h3>
<table bordered striped>
  <tr><th>Command</th><th>Fungsi</th></tr>
  <tr><td><code>/users</code></td><td>Lihat daftar semua pengguna bot</td></tr>
  <tr><td><code>/userdetail &lt;id&gt;</code></td><td>Lihat detail aktivitas pengguna</td></tr>
</table>

<hr/>
<details>
  <summary><b>🔑 Owner Commands</b></summary>
  <br/>
  <table bordered striped>
    <tr><th>Command</th><th>Fungsi</th></tr>
    <tr><td><code>/broadcast pesan</code></td><td>Broadcast pesan ke seluruh user</td></tr>
    <tr><td><code>/maintenance &lt;on/off&gt;</code></td><td>Aktifkan / Matikan mode maintenance</td></tr>
    <tr><td><code>/bot &lt;off/on&gt;</code></td><td>Nonaktifkan / Aktifkan Bot</td></tr>
    <tr><td><code>/backup script</code></td><td>Backup source code (.zip) ke private chat</td></tr>
    <tr><td><code>/setlimit &lt;angka&gt;</code></td><td>Set limit semua user ke angka tertentu</td></tr>
    <tr><td><code>/resetlimit</code></td><td>Reset limit semua user ke ${DAILY_LIMIT} (skip user bonus)</td></tr>
    <tr><td><code>/addlimit &lt;id&gt; &lt;jumlah&gt; [durasi]</code></td><td>Tambah bonus limit ke user tertentu</td></tr>
    <tr><td><code>/users</code></td><td>Lihat daftar semua pengguna bot</td></tr>
    <tr><td><code>/userdetail &lt;id&gt;</code></td><td>Lihat detail aktivitas pengguna</td></tr>
  </table>
</details>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const buttons = {
        inline_keyboard: [
          [{ text: "📊 Daftar Pengguna", callback_data: "users_page_1", style: "primary" }],
          [{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]
        ]
      };

      return editRichMessage(chatId, messageId, ownerText, buttons);
    }

    // ==================== USERS PAGE ====================
    if (action === "users_page_1" || action.startsWith("users_page_")) {
      if (!isMainOwner(senderId)) {
        await answerCb(query.id, { text: "❌ Fitur ini hanya untuk Owner!", show_alert: true });
        return;
      }

      await answerCb(query.id);

      const targetPage = action === "users_page_1" ? 1 : parseInt(action.replace("users_page_", ""), 10) || 1;
      
      const users = Object.values(userActivity);
      const totalUsers = users.length;
      const itemsPerPage = 10;
      const totalPages = Math.ceil(totalUsers / itemsPerPage) || 1;
      
      const page = Math.min(Math.max(targetPage, 1), totalPages);
      
      const startIndex = (page - 1) * itemsPerPage;
      const endIndex = Math.min(startIndex + itemsPerPage, totalUsers);
      const pageUsers = users.slice(startIndex, endIndex);
      
      let rowsHtml = '';
      if (pageUsers.length === 0) {
        rowsHtml = `<tr><td colspan="4" align="center"><i>Belum ada pengguna</i></td></tr>`;
      } else {
        pageUsers.forEach((user, i) => {
          const username = user.username || '-';
          const firstSeen = user.firstSeen ? new Date(user.firstSeen).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
          }) : '-';
          rowsHtml += `<tr>
            <td>${startIndex + i + 1}</td>
            <td><code>${user.userId}</code></td>
            <td>${username}</td>
            <td>${firstSeen}</td>
            <td>${user.totalActions}</td>
          </tr>`;
        });
      }

      const text = `<h2>📊 DAFTAR PENGGUNA BOT</h2>

<table bordered striped>
  <tr><th>#</th><th>User ID</th><th>Username</th><th>Start Bot</th><th>Total Aksi</th></tr>
  ${rowsHtml}
</table>

<p>Halaman ${page} dari ${totalPages} | Total Pengguna: <b>${totalUsers}</b></p>

<hr/>
<footer>© running since 2026 - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const navButtons = [];
      if (page > 1) {
        navButtons.push({ text: "⬅️", callback_data: `users_page_${page - 1}`, style: "primary" });
      }
      navButtons.push({ text: `${page}/${totalPages}`, callback_data: "ignore_page", style: "primary" });
      if (page < totalPages) {
        navButtons.push({ text: "➡️", callback_data: `users_page_${page + 1}`, style: "primary" });
      }

      const inline_keyboard = [];
      if (navButtons.length > 1 || totalPages > 1) {
        inline_keyboard.push(navButtons);
      }
      inline_keyboard.push([{ text: "↺ Kembali ke Owner Menu", callback_data: "owner_menu", style: "danger" }]);

      return editRichMessage(chatId, messageId, text, { inline_keyboard });
    }

    // ==================== SHOW SERVER STATUS ====================
    if (action === "show_server_status") {
      await answerCb(query.id);
      
      const text = getServerStatusText();
      const buttons = {
        inline_keyboard: [
          [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
        ]
      };
      
      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== SHOW GUIDE ====================
    if (action === "show_guide") {
      await answerCb(query.id);
      
      const text = getGuideText();
      const buttons = {
        inline_keyboard: [
          [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
        ]
      };
      
      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== SHOW FAQ ====================
    if (action === "show_faq") {
      await answerCb(query.id);
      
      const text = getFaqText();
      const buttons = {
        inline_keyboard: [
          [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
        ]
      };
      
      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== STORE MENU ====================
    if (action === "store_menu") {
      await answerCb(query.id);
      logStoreAccess(query.from, 'Buka Store');

      const isVvip = isVVIP(senderId);
      const vvipDays = isVvip ? getVVIPRemainingDays(senderId) : 0;
      const limitTotal = getTotalUserLimit(senderId);

      let vvipStatus = isVvip ? `✅ Active (${vvipDays} hari)` : "❌ Tidak Aktif";

      const text = `<h2>🛒 STORE / PREMIUM SHOP</h2>

<p>🛍️ Pilih paket untuk meningkatkan pengalamanmu!</p>

<table bordered>
  <tr><th>📌 Status</th><th>Info</th></tr>
  <tr><td>👑 VVIP</td><td>${vvipStatus}</td></tr>
  <tr><td>💎 Limit</td><td><b>${limitTotal}</b> Limit</td></tr>
</table>

<hr/>
<h3>📦 KATEGORI PAKET</h3>
<table bordered>
  <tr><th>Paket</th><th>Keterangan</th></tr>
  <tr><td>👑 Beli VVIP</td><td>Upgrade ke VVIP (Unlimited Limit + Eksklusif)</td></tr>
  <tr><td>🔄 Beli Perpanjang</td><td>Perpanjang masa aktif VVIP</td></tr>
  <tr><td>📦 Beli Limit</td><td>Tambah limit harian</td></tr>
</table>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const buttons = {
        inline_keyboard: [
          [
            { text: "👑 Beli VVIP", callback_data: "store_vvip", style: "primary" },
            { text: "🔄 Beli Perpanjang", callback_data: "store_renew", style: "primary" }
          ],
          [
            { text: "📦 Beli Limit", callback_data: "store_limit", style: "primary" }
          ],
          [
            { text: "↺ Kembali", callback_data: "back_menu", style: "danger" }
          ]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== STORE VVIP ====================
    if (action === "store_vvip") {
      await answerCb(query.id);
      logStoreAccess(query.from, 'Beli VVIP Packages');

      let packagesHtml = "";
      for (const [key, pkg] of Object.entries(DEFAULT_VVIP_PACKAGES)) {
        packagesHtml += `<tr>
          <td>${pkg.emoji}</td>
          <td><b>${pkg.name}</b></td>
          <td>${toRupiah(pkg.price)}</td>
          <td>${pkg.days} Hari</td>
        </tr>`;
      }

      const text = `<h2>👑 BELI VVIP PACKAGES</h2>
<p>💎 Pilih paket VVIP untuk limit unlimited &amp; fitur eksklusif!</p>

<table bordered>
  <tr><th>#</th><th>Paket</th><th>Harga</th><th>Durasi</th></tr>
  ${packagesHtml}
</table>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const buttons = {
        inline_keyboard: [
          [
            { text: "1️⃣ 1 Bulan", callback_data: "pay_vvip_1", style: "primary" },
            { text: "2️⃣ 3 Bulan", callback_data: "pay_vvip_2", style: "primary" }
          ],
          [
            { text: "3️⃣ 6 Bulan", callback_data: "pay_vvip_3", style: "primary" },
            { text: "4️⃣ 1 Tahun", callback_data: "pay_vvip_4", style: "primary" }
          ],
          [
            { text: "↺ Kembali", callback_data: "store_menu", style: "danger" }
          ]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== STORE PERPANJANG ====================
    if (action === "store_renew") {
      await answerCb(query.id);
      logStoreAccess(query.from, 'Beli Perpanjang Packages');

      if (!isVVIP(senderId)) {
        const text = `<h3>❌ Anda Belum VVIP!</h3>
<p>Silakan upgrade ke VVIP terlebih dahulu sebelum melakukan perpanjangan.</p>`;
        const buttons = {
          inline_keyboard: [
            [{ text: "👑 Beli VVIP", callback_data: "store_vvip", style: "primary" }],
            [{ text: "↺ Kembali", callback_data: "store_menu", style: "danger" }]
          ]
        };
        return editRichMessage(chatId, messageId, text, buttons);
      }

      const remainingDays = getVVIPRemainingDays(senderId);
      let packagesHtml = "";
      for (const [key, pkg] of Object.entries(DEFAULT_RENEW_PACKAGES)) {
        packagesHtml += `<tr>
          <td>${pkg.emoji}</td>
          <td><b>${pkg.name}</b></td>
          <td>${toRupiah(pkg.price)}</td>
          <td>${pkg.days} Hari</td>
        </tr>`;
      }

      const text = `<h2>🔄 BELI PERPANJANG PACKAGES</h2>
<p>⏳ Sisa masa aktif: <b>${remainingDays} hari</b></p>

<table bordered>
  <tr><th>#</th><th>Paket</th><th>Harga</th><th>Tambahan</th></tr>
  ${packagesHtml}
</table>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const buttons = {
        inline_keyboard: [
          [
            { text: "🔄 1 Bulan", callback_data: "pay_renew_1", style: "primary" },
            { text: "🔄 3 Bulan", callback_data: "pay_renew_2", style: "primary" }
          ],
          [
            { text: "🔄 6 Bulan", callback_data: "pay_renew_3", style: "primary" },
            { text: "🔄 1 Tahun", callback_data: "pay_renew_4", style: "primary" }
          ],
          [
            { text: "↺ Kembali", callback_data: "store_menu", style: "danger" }
          ]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== STORE LIMIT ====================
    if (action === "store_limit") {
      await answerCb(query.id);
      logStoreAccess(query.from, 'Beli Limit Packages');

      let packagesHtml = "";
      for (const [key, pkg] of Object.entries(DEFAULT_LIMIT_PACKAGES)) {
        packagesHtml += `<tr>
          <td>${pkg.emoji}</td>
          <td><b>${pkg.name}</b></td>
          <td>${toRupiah(pkg.price)}</td>
          <td>+${pkg.limit}</td>
          <td>${pkg.days} Hari</td>
        </tr>`;
      }

      const text = `<h2>📦 BELI LIMIT PACKAGES</h2>
<p>📈 Tambah limit harian Anda!</p>

<table bordered>
  <tr><th>#</th><th>Paket</th><th>Harga</th><th>Limit</th><th>Berlaku</th></tr>
  ${packagesHtml}
</table>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const buttons = {
        inline_keyboard: [
          [
            { text: "📦 +10", callback_data: "pay_limit_1", style: "primary" },
            { text: "📦 +25", callback_data: "pay_limit_2", style: "primary" }
          ],
          [
            { text: "📦 +50", callback_data: "pay_limit_3", style: "primary" },
            { text: "📦 +100", callback_data: "pay_limit_4", style: "primary" }
          ],
          [
            { text: "↺ Kembali", callback_data: "store_menu", style: "danger" }
          ]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== PAYMENT HANDLERS ====================
    if (action.startsWith("pay_")) {
      const parts = action.split("_");
      const type = parts[1];
      const packageId = parts[2];

      await answerCb(query.id, { text: "⏳ Membuat pembayaran..." });

      const pkg = type === 'vvip' ? DEFAULT_VVIP_PACKAGES[packageId] : 
                  type === 'renew' ? DEFAULT_RENEW_PACKAGES[packageId] : 
                  DEFAULT_LIMIT_PACKAGES[packageId];
      
      logPayment(query.from, type, pkg.name, pkg.price);

      try {
        console.log(chalk.blue(`[Payment] User ${senderId} requesting ${type} package ${packageId}`));
        
        const paymentResult = await createPaymentWithLoading(senderId, type, packageId, chatId);
        
        if (!paymentResult || !paymentResult.transactionId) {
          const errText = `<h3>❌ Gagal Membuat Pembayaran</h3>
<p>Terjadi kesalahan saat membuat QRIS. Silakan coba lagi nanti.</p>`;
          await sendRichMessage(chatId, errText, {
            inline_keyboard: [[{ text: "↺ Kembali", callback_data: "store_menu", style: "danger" }]]
          });
          return;
        }

        const pkgData = paymentResult.packageData;
        
        let typeLabel = '';
        if (type === 'vvip') typeLabel = '👑 Upgrade VVIP';
        else if (type === 'renew') typeLabel = '🔄 Perpanjang VVIP';
        else if (type === 'limit') typeLabel = '📦 Tambah Limit';
        
        const paymentData = {
            qr_string: paymentResult.qr_string,
            fee: paymentResult.fee || 0,
            jumlah: paymentResult.jumlah || pkgData.price,
            expiresAt: paymentResult.expiresAt || Date.now() + 300000,
            nominal: pkgData.price,
            accessKey: paymentResult.accessKey || '',
            paymentUrl: paymentResult.paymentUrl || ''
        };
        
        const resultData = {
            transactionId: paymentResult.transactionId,
            customOrderId: paymentResult.customOrderId || paymentResult.orderId,
            orderId: paymentResult.orderId,
            packageName: pkgData.name,
            price: pkgData.price,
            typeLabel: typeLabel,
            paymentUrl: paymentResult.paymentUrl || ''
        };
        
        if (paymentSessions[paymentResult.transactionId]) {
            paymentSessions[paymentResult.transactionId].chat_id = chatId;
            paymentSessions[paymentResult.transactionId].paymentUrl = paymentResult.paymentUrl || '';
            savePaymentDatabase();
        }
        
        const ctx = {
            chat: { id: chatId },
            reply: async (text, options) => {
                return await sendRichMessage(chatId, text, options?.reply_markup);
            },
            replyWithPhoto: async (photo, options) => {
                const photoUrl = typeof photo === 'object' && photo.url ? photo.url : photo;
                const caption = options?.caption || '';
                const parse_mode = options?.parse_mode || 'HTML';
                const reply_markup = options?.reply_markup || null;
                
                const result = await bot.sendPhoto(chatId, photoUrl, {
                    caption: caption,
                    parse_mode: parse_mode,
                    reply_markup: reply_markup
                });
                
                return result;
            },
            telegram: bot.telegram
        };
        
        await showQRISPayment(ctx, paymentData, resultData, type);
        
      } catch (error) {
        console.error('[Payment] ❌ Error in pay handler:', error.message);
        const errText = `<h3>❌ Error Pembayaran</h3>
<p>${error.message || 'Terjadi kesalahan. Silakan coba lagi nanti.'}</p>`;
        await sendRichMessage(chatId, errText, {
            inline_keyboard: [[{ text: "↺ Kembali", callback_data: "store_menu", style: "danger" }]]
        });
      }
    }

    // ==================== CHECK PAYMENT ====================
    if (action.startsWith("check_payment_")) {
      const transactionId = action.replace("check_payment_", "");
      
      try {
        const session = paymentSessions[transactionId];
        if (!session) {
          await answerCb(query.id, { text: "❌ Transaksi tidak ditemukan!", show_alert: true });
          const text = `<h3>❌ Transaksi Tidak Ditemukan</h3>
<p>Session pembayaran sudah tidak aktif atau telah dihapus.</p>`;
          const buttons = {
            inline_keyboard: [
              [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }]
            ]
          };
          return editRichMessage(chatId, messageId, text, buttons);
        }

        await answerCb(query.id, { 
          text: "⏳ Pembayaran Belum Terdeteksi\n\nInvoice masih pending. Sistem akan terus memeriksa pembayaran secara otomatis.", 
          show_alert: true 
        });

        const result = await checkPaymentStatus(transactionId);

        if (result.success && result.status === 'PAID') {
          logPaymentSuccess(query.from, session.type, session.packageData.name, transactionId);
          await deleteQRISMessage(session);
          await deleteMessage(chatId, messageId);
          
          const text = `<h2>✅ PEMBAYARAN BERHASIL!</h2>
<p>Paket Anda telah berhasil diaktifkan! 🎉</p>
<p>Silakan kembali ke menu utama untuk menggunakan fitur baru Anda.</p>`;
          const buttons = {
            inline_keyboard: [
              [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "success" }]
            ]
          };
          return sendRichMessage(chatId, text, buttons);
          
        } else if (result.status === 'PENDING' || result.success === true) {
          await deleteMessage(chatId, messageId);
          await reshowQRISPayment(chatId, transactionId);
          return;
          
        } else {
          if (result.status === 'CANCELLED' || result.status === 'EXPIRED') {
            await deleteQRISMessage(session);
            if (paymentSessions[transactionId]) {
              delete paymentSessions[transactionId];
              savePaymentDatabase();
            }
          }
          
          await deleteMessage(chatId, messageId);
          const text = `<h3>❌ ${result.status === 'CANCELLED' ? 'Transaksi Dibatalkan' : result.status === 'EXPIRED' ? 'Pembayaran Kadaluarsa' : 'Pembayaran Gagal'}</h3>
<p>${result.message || 'Terjadi kesalahan. Silakan buat transaksi baru.'}</p>`;
          const buttons = {
            inline_keyboard: [
              [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }],
              [{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]
            ]
          };
          return sendRichMessage(chatId, text, buttons);
        }
      } catch (error) {
        console.error('[Payment] ❌ Error in check payment callback:', error.message);
        const text = `<h3>❌ Gagal Mengecek Status</h3>
<p>Terjadi kesalahan: ${error.message}</p>`;
        const buttons = {
          inline_keyboard: [
            [{ text: "🔄 Coba Lagi", callback_data: `check_payment_${transactionId}`, style: "primary" }],
            [{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]
          ]
        };
        return editRichMessage(chatId, messageId, text, buttons);
      }
    }

    // ==================== CANCEL PAYMENT ====================
    if (action.startsWith("cancel_payment_")) {
      const transactionId = action.replace("cancel_payment_", "");
      
      const session = paymentSessions[transactionId];
      if (!session) {
        await answerCb(query.id, { text: "❌ Transaksi tidak ditemukan!", show_alert: true });
        const text = `<h3>❌ Transaksi Tidak Ditemukan</h3>`;
        return editRichMessage(chatId, messageId, text, {
          inline_keyboard: [[{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]]
        });
      }
      
      if (session.status === 'PAID') {
        await answerCb(query.id, { text: "❌ Transaksi sudah lunas!", show_alert: true });
        return;
      }
      
      if (session.status === 'CANCELLED' || session.status === 'EXPIRED') {
        await answerCb(query.id, { text: `❌ Transaksi sudah ${session.status === 'CANCELLED' ? 'dibatalkan' : 'kadaluarsa'}!`, show_alert: true });
        return;
      }
      
      await answerCb(query.id);
      
      const displayOrderId = session.customOrderId || session.orderId || transactionId;
      
      const confirmText = `<h3>⚠️ Konfirmasi Pembatalan</h3>
<p>Apakah Anda yakin ingin membatalkan transaksi ini?</p>
<table bordered striped>
    <tr><th>Field</th><th>Detail</th></tr>
    <tr><td>📦 Paket</td><td>${session.packageData.name}</td></tr>
    <tr><td>💰 Total</td><td>${toRupiah(session.amount || session.nominal)}</td></tr>
    <tr><td>🆔 Transaksi</td><td><code>${displayOrderId}</code></td></tr>
    <tr><td>🆔 Referensi</td><td><code>${transactionId}</code></td></tr>
</table>
<p>⚠️ Transaksi akan dibatalkan dan QRIS akan dihapus.</p>`;
      
      const buttons = {
        inline_keyboard: [
            [
                { text: "✅ Ya, Batalkan", callback_data: `cancel_confirm_${transactionId}`, style: "danger" },
                { text: "❌ Tidak", callback_data: `cancel_back_${transactionId}`, style: "primary" }
            ]
        ]
      };
      
      return editRichMessage(chatId, messageId, confirmText, buttons);
    }

    // ==================== CANCEL CONFIRM ====================
    if (action.startsWith("cancel_confirm_")) {
        const transactionId = action.replace("cancel_confirm_", "");
        
        const session = paymentSessions[transactionId];
        if (!session) {
            await answerCb(query.id, { text: "❌ Transaksi tidak ditemukan!", show_alert: true });
            return editRichMessage(chatId, messageId, `<h3>❌ Transaksi Tidak Ditemukan</h3>`, {
                inline_keyboard: [[{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]]
            });
        }
        
        if (session.status === 'PAID') {
            await answerCb(query.id, { text: "❌ Transaksi sudah lunas!", show_alert: true });
            return;
        }
        
        if (session.status === 'CANCELLED' || session.status === 'EXPIRED') {
            await answerCb(query.id, { text: `❌ Transaksi sudah ${session.status === 'CANCELLED' ? 'dibatalkan' : 'kadaluarsa'}!`, show_alert: true });
            return;
        }
        
        const result = await cancelPayment(transactionId, senderId);
        
        if (result.success) {
            await answerCb(query.id, { text: "✅ Transaksi dan QRIS berhasil dihapus!", show_alert: true });
            
            const displayOrderId = session.customOrderId || session.orderId || transactionId;
            
            const text = `<h2>✅ Transaksi Berhasil Dibatalkan</h2>
<table bordered striped>
    <tr><th>Field</th><th>Detail</th></tr>
    <tr><td>📦 Paket</td><td>${session.packageData.name}</td></tr>
    <tr><td>💰 Total</td><td>${toRupiah(session.amount || session.nominal)}</td></tr>
    <tr><td>🆔 Transaksi</td><td><code>${displayOrderId}</code></td></tr>
    <tr><td>🆔 Referensi</td><td><code>${transactionId}</code></td></tr>
</table>
<p>QRIS telah dihapus. Silakan buat transaksi baru jika ingin melanjutkan.</p>`;
            
            const buttons = {
                inline_keyboard: [
                    [{ text: "🛒 Buka Store", callback_data: "store_menu", style: "primary" }],
                    [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
                ]
            };
            
            return editRichMessage(chatId, messageId, text, buttons);
            
        } else {
            await answerCb(query.id, { text: "❌ Gagal membatalkan!", show_alert: true });
            
            const text = `<h3>❌ Gagal Membatalkan Transaksi</h3>
<p>${result.message}</p>`;
            return editRichMessage(chatId, messageId, text, {
                inline_keyboard: [
                    [{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]
                ]
            });
        }
    }

    // ==================== CANCEL BACK ====================
    if (action.startsWith("cancel_back_")) {
        const transactionId = action.replace("cancel_back_", "");
        
        const session = paymentSessions[transactionId];
        if (!session) {
            await answerCb(query.id, { text: "❌ Transaksi tidak ditemukan!", show_alert: true });
            const text = `<h3>❌ Transaksi Tidak Ditemukan</h3>`;
            return editRichMessage(chatId, messageId, text, {
                inline_keyboard: [[{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]]
            });
        }
        
        if (session.status === 'PAID') {
            await answerCb(query.id, { text: "❌ Transaksi sudah lunas!", show_alert: true });
            return;
        }
        
        if (session.status === 'CANCELLED' || session.status === 'EXPIRED') {
            await answerCb(query.id, { text: `❌ Transaksi sudah ${session.status === 'CANCELLED' ? 'dibatalkan' : 'kadaluarsa'}!`, show_alert: true });
            return;
        }
        
        await answerCb(query.id);
        
        await deleteMessage(chatId, messageId);
        
        await reshowQRISPayment(chatId, transactionId);
    }

    // ==================== AM CREATE OPTIONS ====================
    if (action === "am_create_options") {
      await answerCb(query.id);
      logUserActivity(query.from, '📋 Buka Menu Create AM');

      const userLimit = isMainOwner(senderId) ? "∞" : getTotalUserLimit(senderId);
      const isVvip = isVVIP(senderId);

      let vvipInfo = "";
      if (isVvip) {
        vvipInfo = `<tr><td>👑 VVIP</td><td>✅ Unlimited Limit</td></tr>`;
      }

      const text = `<h2>✨ PILIH METODE CREATION ✨</h2>

<p>Sisa Limit Kamu: <b>${userLimit}</b> Limit</p>

<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  ${vvipInfo}
</table>

<hr/>
<p><b>1. Temp-Mail (Otomatis):</b></p>
<p>Sistem akan membuat email sementara secara instan & verifikasi otomatis tanpa perlu memasukkan email pribadi.</p>

<p><b>2. Custom Gmail (Manual):</b></p>
<p>Gunakan email Gmail pribadi kamu. Kamu perlu memverifikasi dengan menempelkan link verifikasi yang dikirim ke inbox.</p>

<p><b>⚡ 3. AM V2 (Auto - Premium):</b></p>
<p>Metode terbaru menggunakan API canggih untuk aktivasi lebih cepat & stabil. Dukungan Single & Bulk.</p>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const buttons = {
        inline_keyboard: [
          [
            { text: "✉️ Temp-Mail", callback_data: "mode_tempmail", style: "primary" },
            { text: "📧 Custom Gmail", callback_data: "mode_custom_gmail", style: "primary" }
          ],
          [
            { text: "⚡ AM V2", callback_data: "am_v2_menu", style: "success" }
          ],
          [
            { text: "↺ Kembali", callback_data: "back_menu", style: "danger" }
          ]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== AM V2 MENU ====================
    if (action === "am_v2_menu") {
      await answerCb(query.id);
      logUserActivity(query.from, '📋 Buka Menu AM V2');

      const userLimit = isMainOwner(senderId) ? "∞" : getTotalUserLimit(senderId);

      const text = `<h2>⚡ AM V2 AUTO CREATE</h2>

<p>Metode terbaru untuk aktivasi Alight Motion Premium menggunakan API V2!</p>
<p>Sisa Limit Kamu: <b>${userLimit}</b> Limit</p>

<hr/>
<p><b>1. Single Create (1 Akun):</b></p>
<p>Membuat 1 akun AM Premium V2 (Membutuhkan 1 Limit).</p>

<p><b>2. Bulk Create (Masal):</b></p>
<p>Membuat banyak akun sekaligus (1 Limit / Akun).</p>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@masreymarket</a> | All Rights Reserved</footer>`;

      const buttons = {
        inline_keyboard: [
          [{ text: "⚡ Single V2", callback_data: "am_v2_single", style: "success" }],
          [{ text: "📦 Bulk V2", callback_data: "am_v2_bulk", style: "primary" }],
          [{ text: "↺ Kembali", callback_data: "am_create_options", style: "danger" }]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== AM V2 SINGLE ====================
    if (action === "am_v2_single") {
      const userLimit = getTotalUserLimit(senderId);
      if (userLimit < 1) {
        return answerCb(query.id, {
          text: "❌ Limit harian kamu habis! Silakan tunggu reset besok.",
          show_alert: true
        });
      }

      await answerCb(query.id);

      const startText = `<h2>⏳ PROSES AM V2 SINGLE</h2>
<p>Sedang membuat akun Alight Motion Premium V2...</p>`;
      await editRichMessage(chatId, messageId, startText);

      try {
        const result = await processOneAccountV2(1);
        deductUserLimit(senderId, 1);

        if (result.success) {
          logCreateAMSuccess(query.from, 'AM V2', result.email);

          if (!db.sessions) db.sessions = {};
          db.sessions[result.email] = {
            email: result.email,
            verifiedAt: new Date().toISOString(),
            status: "verified",
            link: result.magicLink,
            loginUrl: result.inboxLink,
            userId: String(senderId),
            method: 'AM V2'
          };
          saveDatabase();

          const remainingLimit = isMainOwner(senderId) ? "∞" : getUserLimit(senderId);

          const richText = `<h2>🎉 AM V2 Berhasil!</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Email</td><td><code>${result.email}</code></td></tr>
  <tr><td>Status</td><td>✅ Premium</td></tr>
  <tr><td>Expired</td><td>${result.expiryDate}</td></tr>
  <tr><td>Inbox Link</td><td><a href="${result.inboxLink}">${result.inboxLink}</a></td></tr>
  <tr><td>Magic Link</td><td><code>${result.magicLink}</code></td></tr>
  <tr><td>Sisa Limit</td><td><b>${remainingLimit}</b> Limit</td></tr>
</table>

<hr/>
<h3>📘 Cara Login / Pakai</h3>
<ol>
  <li>Buka Magic Link atau Inbox Link di atas</li>
  <li>Klik link verifikasi dari email</li>
  <li>Pilih "Buka di Alight Motion" saat muncul pop up</li>
</ol>

<hr/>
<footer>© 2026 <a href="https://t.me/masreymarket">@masreymarket</a> | All Rights Reserved</footer>`;

          const backButton = {
            inline_keyboard: [
              [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
            ]
          };
          await editRichMessage(chatId, messageId, richText, backButton);

          await sendActivationLog(query.from, result.email, "AM V2");
        } else {
          throw new Error(result.error);
        }
      } catch (err) {
        logCreateAMFailed(query.from, 'AM V2', err.message);
        const failText = `<h3>❌ AM V2 Gagal</h3>
<p>${err.message}</p>`;
        const backButton = {
          inline_keyboard: [
            [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
          ]
        };
        await editRichMessage(chatId, messageId, failText, backButton);
      }
      return;
    }

    // ==================== AM V2 BULK ====================
    if (action === "am_v2_bulk") {
      userState[senderId] = { step: "wait_bulk_v2_count" };
      await answerCb(query.id);

      const userLimit = isMainOwner(senderId) ? "∞" : getTotalUserLimit(senderId);

      const text = `<h3>⏳ BULK AM V2 CREATOR</h3>
<p>Masukkan jumlah akun yang ingin dibuat!</p>
<p>Sisa Limit Kamu: <b>${userLimit}</b> Limit</p>
<hr/>
<pre>Maksimal: 10 Akun (1 Limit / Akun)</pre>
<p>Kirimkan angka saja (Contoh: <b>5</b>)</p>`;

      return editRichMessage(chatId, messageId, text, {
        inline_keyboard: [[{ text: "↺ Kembali", callback_data: "am_create_options", style: "danger" }]]
      });
    }

    // ==================== MODE TEMPMAIL ====================
    if (action === "mode_tempmail") {
      await answerCb(query.id);
      logUserActivity(query.from, '📋 Buka Menu Temp-Mail');

      const userLimit = isMainOwner(senderId) ? "∞" : getTotalUserLimit(senderId);

      const text = `<h2>✉️ OPSI TEMP-MAIL CREATOR ✉️</h2>

<p>Sisa Limit Kamu: <b>${userLimit}</b> Limit</p>

<hr/>
<p><b>1. Auto Temp-Mail (Single):</b></p>
<p>Membuat 1 akun AM Premium (Membutuhkan 1 Limit).</p>

<p><b>2. Bulk Temp-Mail (Masal):</b></p>
<p>Membuat banyak akun sekaligus (1 Limit / Akun).</p>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const buttons = {
        inline_keyboard: [
          [
            { text: "⚡ Auto", callback_data: "auto_mode_select", style: "success" },
            { text: "📦 Bulk", callback_data: "input_bulk_count", style: "primary" }
          ],
          [
            { text: "↺ Kembali", callback_data: "am_create_options", style: "danger" }
          ]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== AUTO MODE SELECT ====================
    if (action === "auto_mode_select") {
      await answerCb(query.id);

      const text = `<h2>⏳ PILIH OPSI AUTO TEMP-MAIL</h2>

<p><b>1. Custom Domain:</b></p>
<p>Pilih domain temp-mail sendiri dari daftar domain yang tersedia.</p>

<p><b>2. Random Domain:</b></p>
<p>Sistem akan memilihkan domain secara acak dan otomatis.</p>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const buttons = {
        inline_keyboard: [
          [
            { text: "🎨 Custom", callback_data: "select_custom_domain", style: "primary" },
            { text: "🎲 Random", callback_data: "run_auto_tempmail", style: "success" }
          ],
          [
            { text: "↺ Kembali", callback_data: "mode_tempmail", style: "danger" }
          ]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== SELECT CUSTOM DOMAIN ====================
    if (action === "select_custom_domain") {
      await answerCb(query.id, { text: "🔄 Mengambil daftar domain..." });

      try {
        const gen = new GeneratorEmail();
        const domains = await gen.getDomains();

        const domainButtons = domains.map((domain) => [
          { text: `@${domain}`, callback_data: `pick_domain_${domain}`, style: "primary" }
        ]);

        domainButtons.push([
          { text: "↺ Kembali", callback_data: "auto_mode_select", style: "danger" }
        ]);

        const text = `<h2>🌐 PILIH DOMAIN TEMP-MAIL</h2>
<p>Silakan pilih salah satu domain di bawah ini untuk akun kamu!</p>

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

        return editRichMessage(chatId, messageId, text, { inline_keyboard: domainButtons });
      } catch (err) {
        return answerCb(query.id, { text: "❌ Gagal mengambil domain!", show_alert: true });
      }
    }

    // ==================== PICK DOMAIN ====================
    if (action.startsWith("pick_domain_")) {
      const selectedDomain = action.replace("pick_domain_", "");
      userState[senderId] = { step: "wait_custom_username", domain: selectedDomain };

      await answerCb(query.id);

      const text = `<h3>📝 MASUKKAN USERNAME EMAIL</h3>
<p>Domain Terpilih: <b>@${selectedDomain}</b></p>

<p>Kirimkan nama/username yang ingin kamu gunakan di bawah ini!</p>
<pre>Contoh: dapjisync</pre>`;

      return editRichMessage(chatId, messageId, text);
    }

    // ==================== RUN AUTO TEMPMAIL ====================
    if (action === "run_auto_tempmail") {
      const userLimit = getTotalUserLimit(senderId);
      if (userLimit < 1) {
        return answerCb(query.id, {
          text: "❌ Limit harian kamu habis! Silakan tunggu reset besok atau kumpulkan limit.",
          show_alert: true
        });
      }

      await answerCb(query.id);

      const startAutoText = `<h2>⏳ PROSES AUTO TEMP-MAIL</h2>
<p>Sedang membuat email sementara & menunggu link verifikasi masuk ke inbox...</p>`;
      await editRichMessage(chatId, messageId, startAutoText);

      try {
        const itemResult = await runAutoTempmailProcess(null, null, senderId);
        deductUserLimit(senderId, 1);

        logCreateAMSuccess(query.from, 'Auto Temp-Mail', itemResult.email);

        const remainingLimit = isMainOwner(senderId) ? "∞" : getUserLimit(senderId);

        const richTableText = `<h2>🎉 Auto Temp-Mail Berhasil!</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Email</td><td><code>${itemResult.email}</code></td></tr>
  <tr><td>Status</td><td>${itemResult.status}</td></tr>
  <tr><td>Expired</td><td>${itemResult.expired}</td></tr>
  <tr><td>Link Login</td><td><a href="${itemResult.loginUrl}">${itemResult.loginUrl}</a></td></tr>
  <tr><td>Magic Link</td><td><code>${itemResult.magicLink}</code></td></tr>
  <tr><td>Sisa Limit</td><td><b>${remainingLimit}</b> Limit</td></tr>
</table>

<hr/>
${GUIDE_DETAILS_HTML}

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

        const backButton = {
          inline_keyboard: [
            [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
          ]
        };
        await editRichMessage(chatId, messageId, richTableText, backButton);

        await sendActivationLog(query.from, itemResult.email, "Auto Temp-Mail");
      } catch (err) {
        logCreateAMFailed(query.from, 'Auto Temp-Mail', err.message);

        const failText = `<h3>❌ Auto Temp-Mail Gagal</h3>
<p>${err.message}</p>`;
        const backButton = {
          inline_keyboard: [
            [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
          ]
        };
        await editRichMessage(chatId, messageId, failText, backButton);
      }
      return;
    }

    // ==================== INPUT BULK COUNT ====================
    if (action === "input_bulk_count") {
      userState[senderId] = { step: "wait_bulk_count" };
      await answerCb(query.id);

      const userLimit = isMainOwner(senderId) ? "∞" : getTotalUserLimit(senderId);

      const text = `<h3>⏳ BULK TEMPMAIL ACTIVATOR</h3>
<p>Masukkan jumlah akun Tempmail yang ingin dibuat otomatis!</p>
<p>Sisa Limit Kamu: <b>${userLimit}</b> Limit</p>
<hr/>
<pre>Maksimal: 10 Akun (1 Limit / Akun)</pre>
<p>Kirimkan angka saja (Contoh: <b>5</b>)</p>`;

      return editRichMessage(chatId, messageId, text, {
        inline_keyboard: [[{ text: "↺ Kembali", callback_data: "mode_tempmail", style: "danger" }]]
      });
    }

    // ==================== AM MENU PAGE ====================
    if (action.startsWith("am_menu_page_")) {
      if (!isMainOwner(senderId)) {
        return answerCb(query.id, { text: "❌ Hanya Owner!", show_alert: true });
      }

      await answerCb(query.id);

      if (!db.sessions) db.sessions = {};
      const sessions = Object.values(db.sessions);
      if (sessions.length === 0) {
        const text = `<h3>📭 Belum Ada Session</h3>
<p>Belum ada session Alight Motion yang terdaftar.</p>`;

        return editRichMessage(chatId, messageId, text, {
          inline_keyboard: [[{ text: "↺ Kembali", callback_data: "back_menu", style: "danger" }]]
        });
      }

      const targetPage = parseInt(action.replace("am_menu_page_", ""), 10) || 1;
      const { text, replyMarkup } = renderSessionPage(targetPage);

      return editRichMessage(chatId, messageId, text, replyMarkup);
    }

    // ==================== HISTORY PAGE ====================
    if (action.startsWith("history_page_")) {
      await answerCb(query.id);

      const targetPage = parseInt(action.replace("history_page_", ""), 10) || 1;
      logHistoryView(query.from, targetPage);

      const { text, replyMarkup } = renderUserHistory(senderId, targetPage);

      return editRichMessage(chatId, messageId, text, replyMarkup);
    }

    // ==================== MODE CUSTOM GMAIL ====================
    if (action === "mode_custom_gmail") {
      userState[senderId] = { step: "wait_email" };
      await answerCb(query.id);
      logUserActivity(query.from, '📋 Buka Menu Custom Gmail');

      const text = `<h3>📧 Masukkan Email Alight Motion</h3>
<p>Kirim email yang mau di-premiumkan di bawah ini.</p>

<pre>Contoh: email@gmail.com</pre>`;

      const buttons = {
        inline_keyboard: [
          [{ text: "↺ Kembali", callback_data: "am_create_options", style: "danger" }]
        ]
      };

      return editRichMessage(chatId, messageId, text, buttons);
    }

    // ==================== BACK MENU ====================
    if (action === "back_menu") {
      await answerCb(query.id);

      const htmlText = getMainMenuText(query.from);
      const buttons = getMainMenuButtons(senderId);

      return editRichMessage(chatId, messageId, htmlText, buttons);
    }
  } catch (e) {
    console.error("[!] Callback error:", e.message);
    answerCb(query.id, { text: "❌ Error!", show_alert: true });
  }
});

// ==================== MESSAGE HANDLER ====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith("/")) return;

  if (await checkMaintenance(chatId, senderId)) return;

  const lowerText = text.toLowerCase().trim();

  if (lowerText === "cek" || lowerText === "check" || lowerText === "status") {
    const handled = await handleCheckPaymentText(chatId, senderId);
    if (handled) return;
  }

  if (lowerText === "batal" || lowerText === "cancel" || lowerText === "batalkan") {
    const handled = await handleCancelPaymentText(chatId, senderId);
    if (handled) return;
  }

  const state = userState[senderId];
  if (!state) return;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (state.step === "wait_custom_username") {
    const customUser = text.trim();
    const domain = state.domain;
    delete userState[senderId];

    const userLimit = getTotalUserLimit(senderId);
    if (userLimit < 1) {
      const limitErrText = `<h3>❌ Limit Harian Habis!</h3>
<p>Silakan tunggu reset besok atau minta tambahan limit ke Owner!</p>`;
      return sendRichMessage(chatId, limitErrText);
    }

    const startText = `<h2>⏳ PROSES CUSTOM TEMP-MAIL</h2>
<p>Membuat email <b>${customUser}@${domain}</b> & menunggu link verifikasi masuk...</p>`;
    const processMsg = await sendRichMessage(chatId, startText);

    try {
      const itemResult = await runAutoTempmailProcess(domain, customUser, senderId);
      deductUserLimit(senderId, 1);

      logCreateAMSuccess(msg.from, `Custom Domain (${domain})`, itemResult.email);

      const remainingLimit = isMainOwner(senderId) ? "∞" : getUserLimit(senderId);

      const richTableText = `<h2>🎉 Custom Temp-Mail Berhasil!</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Email</td><td><code>${itemResult.email}</code></td></tr>
  <tr><td>Status</td><td>${itemResult.status}</td></tr>
  <tr><td>Expired</td><td>${itemResult.expired}</td></tr>
  <tr><td>Link Login</td><td><a href="${itemResult.loginUrl}">${itemResult.loginUrl}</a></td></tr>
  <tr><td>Magic Link</td><td><code>${itemResult.magicLink}</code></td></tr>
  <tr><td>Sisa Limit</td><td><b>${remainingLimit}</b> Limit</td></tr>
</table>

<hr/>
${GUIDE_DETAILS_HTML}

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

      const backButton = {
        inline_keyboard: [
          [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
        ]
      };
      await editRichMessage(chatId, processMsg.message_id, richTableText, backButton);

      await sendActivationLog(msg.from, itemResult.email, "Custom Temp-Mail");
    } catch (err) {
      logCreateAMFailed(msg.from, `Custom Domain (${domain})`, err.message);

      const failText = `<h3>❌ Custom Temp-Mail Gagal</h3>
<p>${err.message}</p>`;
      const backButton = {
        inline_keyboard: [
          [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
        ]
      };
      await editRichMessage(chatId, processMsg.message_id, failText, backButton);
    }
  }

  else if (state.step === "wait_bulk_count") {
    const count = parseInt(text.trim(), 10);
    if (isNaN(count) || count < 1 || count > 10) {
      const errText = `<h3>❌ Jumlah Tidak Valid!</h3>
<p>Harap masukkan angka antara <b>1</b> sampai <b>10</b>!</p>`;
      return sendRichMessage(chatId, errText);
    }

    const currentLimit = getUserLimit(senderId);
    if (currentLimit < count) {
      delete userState[senderId];
      const limitErrText = `<h3>❌ Limit Tidak Cukup!</h3>
<p>Kamu minta <b>${count}</b> akun, tapi sisa limit kamu cuma <b>${currentLimit}</b>.</p>
<p>Silakan coba jumlah yang lebih sedikit sesuai limit kamu!</p>`;
      return sendRichMessage(chatId, limitErrText);
    }

    delete userState[senderId];

    logBulkCreate(msg.from, count);

    const startBulkText = `<h2>⏳ MEMULAI PROSES BULK</h2>
<p>Target: <b>${count} Akun</b></p>
<p>Mohon tunggu, sistem otomatis sedang memproses seluruh akun...</p>`;
    const processMsg = await sendRichMessage(chatId, startBulkText);

    let successCount = 0;
    let failedCount = 0;
    let tablesHtml = "";

    for (let i = 1; i <= count; i++) {
      try {
        const itemResult = await runAutoTempmailProcess(null, null, senderId);
        deductUserLimit(senderId, 1);
        successCount++;

        logCreateAMSuccess(msg.from, `Bulk (${i}/${count})`, itemResult.email);

        tablesHtml += `<h3>🎉 Akun ${i} dari ${count} Berhasil</h3>
<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Email</td><td><code>${itemResult.email}</code></td></tr>
  <tr><td>Status</td><td>${itemResult.status}</td></tr>
  <tr><td>Expired</td><td>${itemResult.expired}</td></tr>
  <tr><td>Link Login</td><td><a href="${itemResult.loginUrl}">${itemResult.loginUrl}</a></td></tr>
  <tr><td>Magic Link</td><td><code>${itemResult.magicLink}</code></td></tr>
</table>
<br/>`;

        await sendActivationLog(msg.from, itemResult.email, `Bulk Temp-Mail (${i}/${count})`);
      } catch (err) {
        failedCount++;
        logCreateAMFailed(msg.from, `Bulk (${i}/${count})`, err.message);
        tablesHtml += `<h3>❌ Akun ${i} dari ${count} Gagal</h3>
<p>Error: ${err.message}</p>
<hr/>`;
      }

      if (i < count) {
        await sleep(5000);
      }
    }

    logBulkCreateResult(msg.from, count, successCount, failedCount);

    const remainingLimit = isMainOwner(senderId) ? "∞" : getUserLimit(senderId);

    const singleRichMessageText = `<h2>✅ RESULT BULK TEMPMAIL</h2>

<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>Total</td><td align="center">${count} Akun</td></tr>
  <tr><td>Berhasil</td><td align="center">${successCount} Akun</td></tr>
  <tr><td>Gagal</td><td align="center">${failedCount} Akun</td></tr>
  <tr><td>Sisa Limit</td><td align="center"><b>${remainingLimit}</b> Limit</td></tr>
</table>

<hr/>

${tablesHtml}

<hr/>
${GUIDE_DETAILS_HTML}

<hr/>
<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

    const backButton = {
      inline_keyboard: [
        [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
      ]
    };
    await editRichMessage(chatId, processMsg.message_id, singleRichMessageText, backButton);
  }

  else if (state.step === "wait_bulk_v2_count") {
    const count = parseInt(text.trim(), 10);
    if (isNaN(count) || count < 1 || count > 10) {
      const errText = `<h3>❌ Jumlah Tidak Valid!</h3>
<p>Harap masukkan angka antara <b>1</b> sampai <b>10</b>!</p>`;
      return sendRichMessage(chatId, errText);
    }

    const currentLimit = getUserLimit(senderId);
    if (currentLimit < count) {
      delete userState[senderId];
      const limitErrText = `<h3>❌ Limit Tidak Cukup!</h3>
<p>Kamu minta <b>${count}</b> akun, tapi sisa limit kamu cuma <b>${currentLimit}</b>.</p>`;
      return sendRichMessage(chatId, limitErrText);
    }

    delete userState[senderId];

    logBulkCreate(msg.from, count);

    const startBulkText = `<h2>⏳ MEMULAI PROSES BULK V2</h2>
<p>Target: <b>${count} Akun</b></p>
<p>Mohon tunggu, sistem otomatis sedang memproses seluruh akun...</p>`;
    const processMsg = await sendRichMessage(chatId, startBulkText);

    const result = await processBulkV2(count, senderId);

    const remainingLimit = isMainOwner(senderId) ? "∞" : getUserLimit(senderId);

    const finalText = renderAMV2Result(count, result.successCount, result.failedCount, result.limitUsed, result.tablesHtml + `
<table bordered striped>
  <tr><th>Info</th><th>Detail</th></tr>
  <tr><td>Sisa Limit</td><td align="center"><b>${remainingLimit}</b> Limit</td></tr>
</table>
`);

    const backButton = {
      inline_keyboard: [
        [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
      ]
    };
    await editRichMessage(chatId, processMsg.message_id, finalText, backButton);
  }

  else if (state.step === "wait_email") {
    if (!emailRegex.test(text.trim())) {
      const errorText = `<h3>❌ Format Email Tidak Valid</h3>
<p>Silakan kirim email dengan format yang benar!</p>

<pre>Contoh: contoh@gmail.com</pre>`;
      return sendRichMessage(chatId, errorText);
    }

    const email = text.trim();
    userState[senderId].email = email;
    userState[senderId].step = "wait_link";

    logCustomGmail(msg.from, email);

    bot.sendChatAction(chatId, "typing");

    try {
      const response = await safeSendLink(email);

      if (response?.status) {
        if (!db.sessions) db.sessions = {};
        db.sessions[email] = {
          email: email,
          status: "pending",
          sentAt: new Date().toISOString(),
          verifiedAt: null,
          link: null,
          userId: String(senderId)
        };
        saveDatabase();

        const successText = `<h2>✅ Email Berhasil Dikirim!</h2>

<p>Email Target: <code>${email}</code></p>

<hr/>
<h3>📋 Langkah Selanjutnya:</h3>
<ol>
  <li>Cek email kamu (cek folder Spam jika ada)</li>
  <li>Klik tombol 'Log in to Alight Motion'</li>
  <li>Salin URL setelah di-redirect</li>
  <li>Kirimkan link URL tersebut di sini</li>
</ol>`;

        await sendRichMessage(chatId, successText);
      } else {
        throw new Error(response?.message || "Gagal mengirim link");
      }
    } catch (e) {
      delete userState[senderId];
      logCreateAMFailed(msg.from, 'Custom Gmail - Kirim Link', e.message);

      const failText = `<h3>❌ Gagal Mengirim Link</h3>
<p>${e.message}</p>`;
      await sendRichMessage(chatId, failText);
    }
  }

  else if (state.step === "wait_link") {
    const email = state.email;
    const link = text.trim();

    if (!link.startsWith("http")) {
      const invalidLinkText = `<h3>❌ Link Tidak Valid</h3>
<p>Link harus diawali dengan http:// atau https://</p>`;
      return sendRichMessage(chatId, invalidLinkText);
    }

    bot.sendChatAction(chatId, "typing");

    try {
      const response = await safeVerifyLink(email, link);

      if (response?.status) {
        const userEmail = response.data?.email || email;
        const expiryDate = response.data?.duration || '1 Tahun';

        if (!db.sessions) db.sessions = {};
        if (db.sessions[email]) {
          db.sessions[email].verifiedAt = new Date().toISOString();
          db.sessions[email].status = 'verified';
          db.sessions[email].link = link;
          saveDatabase();
        }

        logCustomGmailSuccess(msg.from, email);
        logCreateAMSuccess(msg.from, 'Custom Gmail - Verifikasi', email);

        const verifText = `<h2>🎉 Verifikasi Berhasil!</h2>

<table bordered striped>
  <tr><th>Field</th><th>Detail</th></tr>
  <tr><td>Email</td><td><code>${userEmail}</code></td></tr>
  <tr><td>Status</td><td>Premium ✨</td></tr>
  <tr><td>Expired</td><td>${expiryDate}</td></tr>
</table>

<hr/>
<p>Selamat! Alight Motion Premium berhasil diaktifkan!</p>

<footer>© running since 2026  - <a href="https://t.me/masreymarket">@nokoswavirtual</a></footer>`;

        const backButton = {
          inline_keyboard: [
            [{ text: "↺ Kembali ke Menu", callback_data: "back_menu", style: "danger" }]
          ]
        };
        await sendRichMessage(chatId, verifText, backButton);

        await sendActivationLog(msg.from, userEmail, "Custom Gmail");

        delete userState[senderId];
      } else {
        throw new Error(response?.message || "Gagal memverifikasi akun");
      }
    } catch (e) {
      let errorMsg = e.message;
      if (e.message.includes('Email tidak valid')) {
        errorMsg = "Format email tidak valid!";
      } else if (e.message.includes('Magic Link')) {
        errorMsg = "Link tidak valid atau sudah expired!";
      }

      logCreateAMFailed(msg.from, 'Custom Gmail - Verifikasi', errorMsg);

      const failVerifText = `<h3>❌ Verifikasi Gagal</h3>
<p>${errorMsg}</p>
<p>Silakan coba lagi dengan mengirimkan link URL yang benar.</p>`;

      await sendRichMessage(chatId, failVerifText);
    }
  }
});

// ==================== START BOT ====================
startBot();
startAutoBackupCron();
startAutoOffCron();

// ==================== SET INTERVAL ====================
setInterval(async () => {
    await checkExpiredPayments();
}, 10000);

setInterval(() => {
    cleanupPayments();
}, 30000);

console.log(chalk.green.bold("✅ Bot started successfully!"));