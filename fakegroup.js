// plugins/fakegroup.js
const { downloadQuotedMedia, downloadMedia, reply } = require('@lib/utils');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs-extra');
const sharp = require('sharp');

fs.ensureDirSync('tmp');

/* ========= upload helpers ========= */
async function uploadToUguu(filePath) {
  try {
    const form = new FormData();
    form.append('files[]', fs.createReadStream(filePath));
    const res = await axios.post('https://uguu.se/upload', form, {
      headers: form.getHeaders(),
      timeout: 60000,
      validateStatus: s => s >= 200 && s < 500
    });
    return res.data?.files?.[0]?.url || null;
  } catch {
    return null;
  }
}

async function uploadToCatbox(filePath) {
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(filePath));
    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 60000,
      validateStatus: s => s >= 200 && s < 500
    });
    if (typeof res.data === 'string' && res.data.startsWith('https://')) {
      return res.data.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/* ========= normalize ke png ========= */
async function normalizeToPNG(inputPath) {
  const outPath = path.join('tmp', `norm_${Date.now()}.png`);
  await sharp(inputPath, { animated: true, pages: 1 })
    .png()
    .toFile(outPath);
  return outPath;
}

/* ========= command ========= */
async function handle(sock, messageInfo) {

  const {
    m,
    remoteJid,
    sender,
    message,
    isQuoted,
    type,
    prefix,
    command,
    content
  } = messageInfo;

  const parts = (content ?? '').split('|').map(v => v.trim());
  const name = parts[0] || '';
  const members = parts[1] || '';

  if (!name || !members) {
    return reply(
      m,
`⚠️ ꜰᴏʀᴍᴀᴛ:
*${prefix + command} ɴᴀᴍᴀ ɢʀᴏᴜᴘ | 3000*

📸 ᴄᴀʀᴀ ᴍᴇɴɢɢᴜɴᴀᴋᴀɴ:
• ʀᴇᴘʟʏ ꜰᴏᴛᴏ / ꜱᴛɪᴋᴇʀ
• ᴀᴛᴀᴜ ᴋɪʀɪᴍ ꜰᴏᴛᴏ + ᴄᴀᴘᴛɪᴏɴ

ᴊɪᴋᴀ ᴛᴀɴᴘᴀ ᴍᴇᴅɪᴀ,
ᴀᴠᴀᴛᴀʀ ᴀᴋᴀɴ ᴍᴇɴɢɢᴜɴᴀᴋᴀɴ ꜰᴏᴛᴏ ᴘʀᴏꜰɪʟ.`
    );
  }

  const mediaType = isQuoted ? isQuoted.type : type;

  let mediaTempPath = null;
  let pngPath = null;
  let resultPath = null;

  try {

    await sock.sendMessage(remoteJid, {
      react: { text: '⏳', key: message.key }
    });

    /* ===== avatar ===== */
    let avatarUrl = null;

    if (['image','sticker'].includes(mediaType)) {

      const mediaFile = isQuoted
        ? await downloadQuotedMedia(message)
        : await downloadMedia(message);

      mediaTempPath = path.join('tmp', mediaFile);

      pngPath = await normalizeToPNG(mediaTempPath);

      avatarUrl = await uploadToUguu(pngPath);
      if (!avatarUrl) avatarUrl = await uploadToCatbox(pngPath);

      if (!avatarUrl) throw new Error('upload avatar gagal');
    }

    if (!avatarUrl) {
      avatarUrl = await sock.profilePictureUrl(sender, 'image')
        .catch(() => 'https://files.catbox.moe/ncw55w.jpg');
    }

    /* ===== API ===== */
    const apiUrl =
      `https://kazztzyy.my.id/api/maker/fakegroup2` +
      `?image=${encodeURIComponent(avatarUrl)}` +
      `&name=${encodeURIComponent(name)}` +
      `&members=${encodeURIComponent(members)}`;

    const res = await axios.get(apiUrl, {
      responseType: 'arraybuffer',
      timeout: 120000
    });

    resultPath = path.join('tmp', `fakegroup_${Date.now()}.jpg`);
    await fs.writeFile(resultPath, Buffer.from(res.data));

    await sock.sendMessage(
      remoteJid,
      {
        image: fs.readFileSync(resultPath),
        caption:
`👥 ꜰᴀᴋᴇ ɢʀᴏᴜᴘ

📛 ɴᴀᴍᴀ : ${name}
👤 ᴍᴇᴍʙᴇʀ : ${members}`
      },
      { quoted: message }
    );

    await sock.sendMessage(remoteJid, {
      react: { text: '✅', key: message.key }
    });

  } catch (err) {

    console.error(err);

    await sock.sendMessage(
      remoteJid,
      { text: `❌ ɢᴀɢᴀʟ ᴍᴇᴍʙᴜᴀᴛ ꜰᴀᴋᴇɢʀᴏᴜᴘ\n${err.message}` },
      { quoted: message }
    );

  } finally {

    for (const p of [mediaTempPath, pngPath, resultPath]) {
      if (p && await fs.pathExists(p)) {
        fs.unlink(p).catch(() => {});
      }
    }

  }
}

module.exports = {
  handle,
  Commands: ['fakegroup','fgc'],
  OnlyPremium: false,
  OnlyOwner: false,
  limitDeduction: 1
};