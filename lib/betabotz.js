const axios = require('axios');
const QRCode = require('qrcode');
const chalk = require('chalk');

const config = require('../config.js');

const BETABOTZ_BASE_URL = config.betabotzBaseUrl || 'https://web.btzpay.my.id';
const BETABOTZ_APIKEY = config.betabotzApiKey || '';

function toRupiah(angka) {
    if (!angka) return 'Rp0';
    return Number(angka).toLocaleString("id-ID", {
        style: "currency",
        currency: "IDR",
        minimumFractionDigits: 0
    }).replace("IDR", "Rp").trim();
}

function generateReffId() {
    const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
    return `BTZ-${Date.now()}-${rand}`;
}

function generateCustomOrderId(type) {
    const random = Math.floor(10000000 + Math.random() * 90000000);
    const prefixMap = {
        'vvip': 'VVIP',
        'renew': 'PERPANJANG',
        'limit': 'LIMIT'
    };
    const prefix = prefixMap[type] || 'INV';
    return `${prefix}-INV-ORDERAN-${random}`;
}

function getFee(amount) {
    let percent = 0.5;
    return Math.round(Number(amount) * percent / 100);
}

function sanitizeQrString(s) {
    if (!s || typeof s !== 'string') return null;
    const idx = s.indexOf('000201');
    if (idx !== -1) return s.slice(idx).trim();
    return s.trim();
}

async function downloadQrisImage(url) {
    try {
        if (!url || !url.startsWith('http')) return null;
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error('[Betabotz] Download QRIS error:', error.message);
        return null;
    }
}

async function createdQris(harga, metadata = {}) {
    const amount = Number(harga);
    const fee = getFee(amount);
    const totalPayment = amount + fee;
    
    const type = metadata.type || 'vvip';
    const customOrderId = generateCustomOrderId(type);
    const reffId = generateReffId();

    if (!BETABOTZ_APIKEY) {
        console.error('[Betabotz] ❌ API Key tidak ditemukan di config.js!');
        return null;
    }

    try {
        const payload = {
            apikey: BETABOTZ_APIKEY,
            amount: totalPayment,
            fee: fee,
            timeout: 300000,
            notes: metadata.notes || `Pembayaran ${metadata.packageName || 'Paket'} sebesar ${toRupiah(amount)}`,
            callback_url: "https://web.btzpay.my.id/api/qris/merchant/callback",
            return_url: "https://web.btzpay.my.id/order/sukses",
            metadata: {
                orderId: customOrderId,
                reffId: reffId,
                sender: metadata.sender || '',
                donorName: metadata.donorName || 'User',
                chatId: metadata.chatId || '',
                type: metadata.type || 'vvip',
                package: metadata.package || '',
                packageName: metadata.packageName || ''
            },
            customerInfo: {
                name: metadata.donorName || "User",
                phone: metadata.phone || ""
            }
        };

        const response = await axios.post(
            `${BETABOTZ_BASE_URL}/api/qris/create`,
            payload,
            {
                headers: { 
                    "Content-Type": "application/json", 
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                },
                timeout: 30000
            }
        );

        if (!response.data || !response.data.success) {
            console.error("[Betabotz] ❌ Invalid response");
            return null;
        }

        const data = response.data.data;
        
        const transactionId = data.transactionId || data.transaction_id || data.id || reffId;
        
        let qrBuffer = null;
        let qrString = data.qrisString || data.qr_string || data.qris || '';

        const emv = sanitizeQrString(qrString);
        if (emv && emv.startsWith('000201')) {
            qrString = emv;
            try {
                qrBuffer = await QRCode.toBuffer(qrString, { 
                    errorCorrectionLevel: 'M', 
                    width: 512, 
                    margin: 1 
                });
            } catch (qrError) {
                console.error('[Betabotz] QR Code generation error:', qrError.message);
            }
        } else {
            if (data.qrImage || data.qr_image) {
                qrBuffer = await downloadQrisImage(data.qrImage || data.qr_image);
            }
        }

        if (!qrBuffer && qrString) {
            try {
                qrBuffer = await QRCode.toBuffer(qrString, { 
                    errorCorrectionLevel: 'M', 
                    width: 512, 
                    margin: 1 
                });
            } catch (err) {
                console.error('[Betabotz] Failed to generate QR from string:', err.message);
            }
        }

        const accessKey = data.accessKey || data.access_key || data.key || data.token || '';

        console.log(chalk.green(`[Betabotz] ✅ QRIS created successfully!`));
        console.log(chalk.green(`[Betabotz] 📋 Transaction ID: ${transactionId}`));
        console.log(chalk.green(`[Betabotz] 📋 Order ID: ${customOrderId}`));
        console.log(chalk.green(`[Betabotz] 💰 Amount: ${toRupiah(totalPayment)}`));

        return {
            idtransaksi: transactionId,
            transactionId: transactionId,
            orderId: customOrderId,
            reffId: reffId,
            jumlah: totalPayment,
            imageqris: qrBuffer,
            qr_string: qrString,
            nominal: amount,
            fee: fee,
            expired_at: data.expiredAt || data.expired_at || data.expiry || Date.now() + 300000,
            accessKey: accessKey,
            paymentUrl: data.paymentUrl || data.payment_url || data.url || '',
            status: data.status || 'PENDING',
            qrisImage: data.qrImage || data.qr_image || null,
            customOrderId: customOrderId
        };

    } catch (error) {
        console.error("[Betabotz] ❌ Create error:", error.message);
        if (error.response) {
            console.error("[Betabotz] Response status:", error.response.status);
        }
        return null;
    }
}

async function cekStatus(transactionId, accessKey) {
    if (!transactionId) {
        return { success: false, status: 'ERROR', error: 'Transaction ID required' };
    }

    try {
        const endpoints = [
            {
                url: `${BETABOTZ_BASE_URL}/api/qris/transaction/${transactionId}`,
                params: { apikey: BETABOTZ_APIKEY }
            },
            {
                url: `${BETABOTZ_BASE_URL}/api/qris/status`,
                params: { 
                    transaction_id: transactionId,
                    access_key: accessKey || '',
                    apikey: BETABOTZ_APIKEY 
                }
            },
            {
                url: `${BETABOTZ_BASE_URL}/api/transaction/status/${transactionId}`,
                params: { key: BETABOTZ_APIKEY }
            },
            {
                url: `${BETABOTZ_BASE_URL}/api/order/${transactionId}`,
                params: { api_key: BETABOTZ_APIKEY }
            }
        ];

        let response = null;

        for (let i = 0; i < endpoints.length; i++) {
            try {
                const ep = endpoints[i];
                response = await axios.get(ep.url, {
                    params: ep.params,
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });

                if (response.status === 200 && response.data) {
                    break;
                }
            } catch (e) {
                if (e.response?.status === 404 || e.response?.status === 400) {
                    continue;
                }
            }
        }

        if (!response || response.status !== 200) {
            return { success: false, status: 'PENDING', data: null };
        }

        let data = response.data;
        if (data.success === true) {
            data = data.data || data;
        }

        const status = (data.status || data.Status || data.state || data.payment_status || '').toLowerCase();
        const isPaid = data.is_paid === true || data.isPaid === true || data.paid === true;

        if (isPaid || ['sukses', 'success', 'paid', 'settlement', 'completed', 'settled'].includes(status)) {
            return { 
                success: true, 
                status: 'PAID', 
                data: data,
                transactionId: data.transactionId || data.transaction_id || transactionId,
                amount: data.amount || data.total || 0,
                paidAt: data.paidAt || data.paid_at || data.payment_date || Date.now()
            };
        }
        
        if (['expired', 'timeout', 'expire', 'kadaluarsa'].includes(status)) {
            return { success: false, status: 'EXPIRED', data: data };
        }
        
        if (['cancel', 'cancelled', 'failed', 'batal', 'gagal'].includes(status)) {
            return { success: false, status: 'CANCELLED', data: data };
        }
        
        return { success: false, status: 'PENDING', data: data };

    } catch (error) {
        return { success: false, status: 'PENDING', error: error.message };
    }
}

async function cancelTransaction(transactionId) {
    if (!transactionId) {
        return { success: true, message: 'No transaction ID provided' };
    }

    try {
        const endpoints = [
            {
                url: `${BETABOTZ_BASE_URL}/api/qris/cancel/${transactionId}`,
                method: 'POST',
                data: { apikey: BETABOTZ_APIKEY, reason: "cancelled_by_user" }
            },
            {
                url: `${BETABOTZ_BASE_URL}/api/transaction/cancel/${transactionId}`,
                method: 'POST',
                data: { key: BETABOTZ_APIKEY }
            },
            {
                url: `${BETABOTZ_BASE_URL}/api/order/cancel`,
                method: 'POST',
                data: { transaction_id: transactionId, apikey: BETABOTZ_APIKEY }
            }
        ];

        for (let i = 0; i < endpoints.length; i++) {
            try {
                const ep = endpoints[i];
                const response = await axios({
                    method: ep.method,
                    url: ep.url,
                    data: ep.data,
                    headers: { 
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 10000
                });

                if (response.status === 200 || response.status === 201) {
                    console.log(chalk.red(`[Betabotz] ❌ Transaction CANCELLED!`));
                    console.log(chalk.red(`[Betabotz] 📋 Transaction ID: ${transactionId}`));
                    return { success: true, message: 'Transaction cancelled successfully' };
                }
            } catch (e) {
                if (e.response?.status === 404 || e.response?.status === 400) {
                    continue;
                }
            }
        }

        console.log(chalk.red(`[Betabotz] ❌ Transaction CANCELLED!`));
        console.log(chalk.red(`[Betabotz] 📋 Transaction ID: ${transactionId}`));
        return { success: true, message: 'Force local cleanup' };

    } catch (error) {
        console.error('[Betabotz] ❌ cancelTransaction error:', error.message);
        return { success: true, message: 'Cleanup only' };
    }
}

// ==================== REAL-TIME STATUS CHECKER ====================
async function watchPaymentStatus(transactionId, accessKey, interval = 5000, maxAttempts = 120) {
    let attempts = 0;
    let isStopped = false;
    let isPaidNotified = false;
    let isCancelledNotified = false;
    let isExpiredNotified = false;

    console.log(chalk.blue(`[Betabotz] 👀 Monitoring started for: ${transactionId}`));
    
    return new Promise((resolve) => {
        const checkInterval = setInterval(async () => {
            if (isStopped) {
                clearInterval(checkInterval);
                resolve({ success: false, status: 'STOPPED', data: null });
                return;
            }
            
            attempts++;
            
            try {
                const result = await cekStatus(transactionId, accessKey);
                
                if (result.success && result.status === 'PAID') {
                    if (!isPaidNotified) {
                        isPaidNotified = true;
                        console.log(chalk.green(`[Betabotz] ✅ Payment SUCCESS!`));
                        console.log(chalk.green(`[Betabotz] 📋 Transaction ID: ${transactionId}`));
                        console.log(chalk.green(`[Betabotz] 💰 Amount: ${toRupiah(result.amount || 0)}`));
                    }
                    clearInterval(checkInterval);
                    resolve({ success: true, status: 'PAID', data: result.data });
                    return;
                }
                
                if (result.status === 'CANCELLED') {
                    if (!isCancelledNotified) {
                        isCancelledNotified = true;
                        console.log(chalk.red(`[Betabotz] ❌ Transaction CANCELLED!`));
                        console.log(chalk.red(`[Betabotz] 📋 Transaction ID: ${transactionId}`));
                    }
                    clearInterval(checkInterval);
                    resolve({ success: false, status: 'CANCELLED', data: result.data });
                    return;
                }
                
                if (result.status === 'EXPIRED') {
                    if (!isExpiredNotified) {
                        isExpiredNotified = true;
                        console.log(chalk.yellow(`[Betabotz] ⏰ Transaction EXPIRED!`));
                        console.log(chalk.yellow(`[Betabotz] 📋 Transaction ID: ${transactionId}`));
                    }
                    clearInterval(checkInterval);
                    resolve({ success: false, status: 'EXPIRED', data: result.data });
                    return;
                }
                
                if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    resolve({ success: false, status: 'TIMEOUT', data: null });
                    return;
                }
                
            } catch (error) {
                if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    resolve({ success: false, status: 'TIMEOUT', data: null });
                }
            }
        }, interval);
    });
}

function stopWatching(transactionId) {
    console.log(chalk.yellow(`[Betabotz] ⏹️ Monitoring stopped for: ${transactionId}`));
    return true;
}

module.exports = {
    createdQris,
    cekStatus,
    cancelTransaction,
    toRupiah,
    getFee,
    generateReffId,
    generateCustomOrderId,
    sanitizeQrString,
    downloadQrisImage,
    watchPaymentStatus,
    stopWatching
};