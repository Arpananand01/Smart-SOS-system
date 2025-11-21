// Backend to send alerts via WhatsApp and Email to multiple contacts
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Lazy init Twilio and Nodemailer
let twilioClient = null;
let nodemailer = null;
let mailTransport = null;

function getTwilio() {
    if (twilioClient) return twilioClient;
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
        twilioClient = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    }
    return twilioClient;
}

function getMailer() {
    if (mailTransport) return mailTransport;
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
    if (!nodemailer) nodemailer = require('nodemailer');
    if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
        mailTransport = nodemailer.createTransport({
            host: SMTP_HOST,
            port: Number(SMTP_PORT),
            secure: String(SMTP_SECURE || 'false') === 'true',
            auth: { user: SMTP_USER, pass: SMTP_PASS },
        });
    }
    return mailTransport;
}

// Health check
app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

// Helper to normalize phone number for WhatsApp
function normalizePhoneForWhatsApp(input) {
    if (!input) return null;
    let raw = String(input).trim().replace(/[\s()-]/g, '');
    if (raw.toLowerCase().startsWith('whatsapp:')) raw = raw.slice('whatsapp:'.length);
    if (!raw.startsWith('+') && process.env.DEFAULT_E164_PREFIX) {
        raw = raw.replace(/^0+/, '');
        raw = `${process.env.DEFAULT_E164_PREFIX}${raw}`;
    }
    return `whatsapp:${raw}`;
}

// Send WhatsApp message using Twilio API
async function sendWhatsApp(to, body) {
    const twilio = getTwilio();
    const fromWa = process.env.TWILIO_WHATSAPP_FROM;
    if (!twilio || !fromWa) return { ok: false, skipped: 'whatsapp_not_configured' };
    try {
        const toFormatted = normalizePhoneForWhatsApp(to);
        if (!toFormatted || !/whatsapp:\+\d{6,}/.test(toFormatted)) {
            return { ok: false, error: 'invalid_whatsapp_recipient' };
        }
        const msg = await twilio.messages.create({ from: fromWa, to: toFormatted, body });
        return { ok: true, sid: msg.sid };
    } catch (e) {
        console.error('Twilio WhatsApp send error:', e.message || e);
        return { ok: false, error: e.message };
    }
}

// Send SMS using Twilio
async function sendSms(to, body) {
    const twilio = getTwilio();
    const fromSms = process.env.TWILIO_PHONE;
    if (!twilio || !fromSms) return { ok: false, skipped: 'sms_not_configured' };
    try {
        let recipient = String(to || '').trim();
        // Basic normalization: ensure starts with + and digits
        if (!recipient.startsWith('+') && process.env.DEFAULT_E164_PREFIX) {
            recipient = recipient.replace(/^0+/, '');
            recipient = `${process.env.DEFAULT_E164_PREFIX}${recipient}`;
        }
        if (!/^\+\d{6,}$/.test(recipient)) {
            return { ok: false, error: 'invalid_sms_recipient' };
        }
        const msg = await twilio.messages.create({ from: fromSms, to: recipient, body });
        return { ok: true, sid: msg.sid };
    } catch (e) {
        console.error('Twilio SMS send error:', e.message || e);
        return { ok: false, error: e.message };
    }
}

// Send Email using Nodemailer
async function sendEmail(to, subject, text) {
    const mailer = getMailer();
    const emailFrom = process.env.EMAIL_FROM|| process.env.SMTP_USER;
    if (!mailer || !emailFrom) return { ok: false, skipped: 'email_not_configured' };
    try {
        const info = await mailer.sendMail({ from: emailFrom, to, subject, text });
        return { ok: true, id: info.messageId };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// API to send alerts
app.post('/api/send-alerts', async (req, res) => {
    const { message, contacts = [], location, medical, channel } = req.body || {};
    if (!message || !Array.isArray(contacts)) {
        return res.status(400).json({ ok: false, error: 'Invalid payload' });
    }

    // Compose message including medical info and location
    const medPieces = [];
    if (medical) {
        if (medical.bloodType) medPieces.push(`Blood: ${medical.bloodType}`);
        if (medical.allergies) medPieces.push(`Allergies: ${medical.allergies}`);
        if (medical.medications) medPieces.push(`Meds: ${medical.medications}`);
        if (medical.conditions) medPieces.push(`Conditions: ${medical.conditions}`);
    }
    const medText = medPieces.length ? `\nMedical: ${medPieces.join('; ')}` : '';
    const locText = location && location.latitude && location.longitude
        ? `\nLocation: https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`
        : '';
    const fullMessage = `${message}${locText}${medText}`;

    const results = [];

    // Loop through all contacts
    for (const contact of contacts) {
        const per = { contactId: contact.id, name: contact.name };

        // WhatsApp
        if (contact.phone) {
            per.whatsapp = await sendWhatsApp(contact.phone, fullMessage);
        }

        // Email (skip if channel is WhatsApp-only)
        if (contact.email && channel !== 'whatsapp') {
            per.email = await sendEmail(contact.email, 'Emergency Alert', fullMessage);
        }

        results.push(per);
    }

    res.json({ ok: true, results });
});

// Minimal SMS endpoint for client SOS
app.post('/send-sos', async (req, res) => {
    try {
        const { message, to } = req.body || {};
        if (!message || !to) {
            return res.status(400).json({ ok: false, error: 'Missing message or to' });
        }
        const result = await sendSms(to, message);
        if (result.ok) return res.json({ ok: true, sid: result.sid });
        return res.status(500).json({ ok: false, error: result.error || result.skipped || 'sms_failed' });
    } catch (e) {
        console.error('send-sos error:', e.message || e);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Alert backend listening on http://localhost:${port}`);
});
