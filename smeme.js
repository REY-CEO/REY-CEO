```
const { downloadQuotedMedia, downloadMedia  } = require("../../lib/utils");
const { sendImageAsSticker  } = require("../../lib/exif");
const config = require("../../config");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

async function uploadWithFallback(filePath) {
  try {
    const formUguu = new FormData();
    formUguu.append("files[]", fs.createReadStream(filePath));

    const resUguu = await axios.post("https://uguu.se/upload", formUguu, {
      headers: formUguu.getHeaders(),
    });

    const uguuUrl = resUguu.data?.files?.[0]?.url;
    if (uguuUrl?.startsWith("http")) return uguuUrl;
    console.warn("⚠️ upload ke uguu gagal, lanjut catbox...");
  } catch (err) {
    console.warn("⚠️ upload uguu error:", err.message);
  }

  try {
    const formCatbox = new FormData();
    formCatbox.append("reqtype", "fileupload");
    formCatbox.append("fileToUpload", fs.createReadStream(filePath));

    const resCatbox = await axios.post("https://catbox.moe/user/api.php", formCatbox, {
      headers: formCatbox.getHeaders(),
    });

    if (typeof resCatbox.data === "string" && resCatbox.data.startsWith("http"))
      return resCatbox.data;

    throw new Error("format respons catbox tidak sesuai.");
  } catch (err) {
    console.error("❌ upload catbox gagal:", err.response?.data || err.message);
    throw new Error("upload gagal ke semua layanan.");
  }
}

async function handle(sock, messageInfo) {
  const { remoteJid, message, type, isQuoted, content, prefix, command } = messageInfo;

  try {
    if (!content) {
      return sock.sendMessage(
        remoteJid,
        {
          text: `_⚠️ format penggunaan:_\n\n_💬 contoh:_ *${prefix + command} atas | bawah*`,
        },
        { quoted: message }
      );
    }

    await sock.sendMessage(remoteJid, { react: { text: "⏰", key: message.key } });

    const mediaType = isQuoted ? isQuoted.type : type;
    if (mediaType !== "image" && mediaType !== "sticker") {
      return sock.sendMessage(
        remoteJid,
        { text: `⚠️ _kirim atau balas gambar dengan caption *${prefix + command}*_` },
        { quoted: message }
      );
    }

    const [text1 = "", text2 = ""] = (content || "").split("|");

    const media = isQuoted
      ? await downloadQuotedMedia(message)
      : await downloadMedia(message);

    const mediaPath = path.join("tmp", media);
    if (!fs.existsSync(mediaPath)) throw new Error("file media tidak ditemukan setelah diunduh.");

    const imageUrl = await uploadWithFallback(mediaPath);
    if (!imageUrl.startsWith("http")) throw new Error("url upload tidak valid.");

    const response = await axios.get("https://fybot-maker.vercel.app/api/smeme", {
      responseType: "arraybuffer",
      params: {
        url: imageUrl,
        text: `${text1.trim()}|${text2.trim()}`,
      },
    });

    const buffer = response.data;

    const stickerOptions = {
      packname: config.sticker_packname,
      author: config.sticker_author,
    };

    await sendImageAsSticker(sock, remoteJid, buffer, stickerOptions, message);

    fs.unlinkSync(mediaPath);
    await sock.sendMessage(remoteJid, { react: { text: "✅", key: message.key } });

  } catch (err) {
    console.error(err);
    await sock.sendMessage(
      remoteJid,
      { text: `❌ gagal memproses: ${err.message}` },
      { quoted: message }
    );
  }
}

module.exports = {
  handle,
  Commands: ["smeme"],
  OnlyPremium: false,
  OnlyOwner: false,
  limitDeduction: 1,
};
```