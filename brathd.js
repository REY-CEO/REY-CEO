//ini versi cjs
// ntr gw bikinin versi esm ya 
const nexray = require('api-nexray');
const config = require("@config");
const { sendImageAsSticker } = require("@lib/exif");
const { logCustom } = require("@lib/logger");

async function handle(sock, messageInfo) {
    const { remoteJid, message, content, isQuoted, prefix, command } = messageInfo;

    try {
        const text = content && content.trim() !== '' ? content : isQuoted?.text ?? null;
        
        // Validate input content
        if (!text) {
            await sock.sendMessage(remoteJid, {
                text: `_⚠️ Format Penggunaan:_ \n\n_💬 Contoh:_ _*${prefix + command} halo*_`
            }, { quoted: message });
            return;
        }

        // Send loading reaction
        await sock.sendMessage(remoteJid, {
            react: { text: "⏰", key: message.key }
        });

        // Sanitize content
        const sanitizedContent = encodeURIComponent(text.trim().replace(/\n+/g, " "));

        const buffer = await nexray.getBuffer('/maker/brathd', {
        text: text
        });

        const options = {
            packname: config.sticker_packname,
            author: config.sticker_author,
        };

        // Send sticker
        await sendImageAsSticker(sock, remoteJid, buffer, options, message);


    } catch (error) {
        logCustom('info', content, `ERROR-COMMAND-${command}.txt`);
        const errorMessage = `Maaf, terjadi kesalahan saat memproses permintaan Anda. Coba lagi nanti.\n\nError: ${error.message}`;
        await sock.sendMessage(remoteJid, {
            text: errorMessage
        }, { quoted: message });
    }
}

module.exports = {
    handle,
    Commands: ['brat', 'b'],
    OnlyPremium: false,
    OnlyOwner: false,
    limitDeduction: 2
};
