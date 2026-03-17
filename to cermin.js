import { downloadQuotedMedia, downloadMedia, reply  } from "@lib/utils";
import path from "path.js";
import axios from "axios.js";
import FormData from "form-data.js";
import fs from "fs-extra.js";
import sharp from "sharp.js";

fs.ensureDirSync('tmp');

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
  } catch (err) {
    console.error('❌ Upload ke Uguu gagal:', err.message);
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
  } catch (err) {
    console.error('❌ Upload ke Catbox gagal:', err.message);
    return null;
  }
}

async function normalizeToPNG(inputPath) {
  if (!await fs.pathExists(inputPath)) {
    throw new Error('File media tidak ditemukan.');
  }

  const outPath = path.join('tmp', `norm_${Date.now()}.png`);

  try {
    const img = sharp(inputPath, { animated: true, pages: 1 });
    await img.png().toFile(outPath);
    return outPath;
  } catch (e) {
    throw new Error(`Gagal konversi ke PNG: ${e.message}`);
  }
}

async function handle(sock, messageInfo) {
  const { m, remoteJid, message, isQuoted, type, prefix, command } = messageInfo;

  const mediaType = isQuoted ? isQuoted.type : type;
  if (!['image', 'sticker'].includes(mediaType)) {
    return await reply(m, `⚠️ kirim atau balas *foto/stiker* dengan caption *${prefix + command}*`);
  }

  let mediaTempPath = null;
  let pngPath = null;
  let resultPath = null;

  try {

    await sock.sendMessage(remoteJid, { react: { text: "⏰", key: message.key } });

    const mediaFileName = isQuoted
      ? await downloadQuotedMedia(message)
      : await downloadMedia(message);

    mediaTempPath = path.join('tmp', mediaFileName);

    if (!await fs.pathExists(mediaTempPath)) {
      throw new Error('File media tidak ditemukan.');
    }

    pngPath = await normalizeToPNG(mediaTempPath);

    let fileUrl = await uploadToUguu(pngPath);
    if (!fileUrl) fileUrl = await uploadToCatbox(pngPath);

    if (!fileUrl) {
      throw new Error("Upload gagal.");
    }

    const apiUrl = `https://api-hara.vercel.app/ai/tocerminv2?url=${encodeURIComponent(fileUrl)}`;

    const apiRes = await axios.get(apiUrl, {
      responseType: "arraybuffer",
      timeout: 180000
    });

    const buffer = Buffer.from(apiRes.data);

    resultPath = path.join('tmp', `cermin_${Date.now()}.jpg`);
    await fs.writeFile(resultPath, buffer);

    await sock.sendMessage(
      remoteJid,
      {
        image: fs.readFileSync(resultPath),
        caption: `✅ *berhasil di edit*

⚠️ foto ini di edit oleh *ai*, jika hasilnya masih kurang sesuai bisa dicoba ulang`
      },
      { quoted: message }
    );

  } catch (error) {

    console.error("❌ Error plugin tocermin:", error);

    await sock.sendMessage(
      remoteJid,
      { text: `⚠️ gagal memproses gambar` },
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

export default {
  handle,
  Commands: ["tocermin"],
  OnlyPremium: false,
  OnlyOwner: false,
  limitDeduction: 1,
};
```