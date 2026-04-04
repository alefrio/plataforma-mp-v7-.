const nodemailer = require('nodemailer');
const twilio = require('twilio');
const axios = require('axios');

let twilioClient = null;
function getTwilio() {
  if (twilioClient !== null) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    twilioClient = false;
    return null;
  }
  try {
    twilioClient = twilio(sid, token);
  } catch {
    twilioClient = false;
  }
  return twilioClient || null;
}

let mailTransporter = null;
function getMailer() {
  if (mailTransporter !== null) return mailTransporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user) {
    mailTransporter = false;
    return null;
  }
  mailTransporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: pass ? { user, pass } : undefined,
  });
  return mailTransporter || null;
}

function publicAppBaseUrl() {
  return String(process.env.APP_PUBLIC_URL || 'http://127.0.0.1:3780').replace(/\/$/, '');
}

function buildPlataformaNotifLink(novo) {
  const base = publicAppBaseUrl();
  const id = encodeURIComponent(novo.id || '');
  return `${base}/?notif=${id}`;
}

function buildAlertBody(novo) {
  const titulo = novo.titulo || 'Nova notificação MPMA';
  const id = novo.id || '';
  const pdf = novo.pdfUrl || '';
  return `${titulo}\nID: ${id}\n${pdf ? `PDF: ${pdf}\n` : ''}PlataformaMP — alerta automático.`;
}

/** E.164 aproximado para Twilio WhatsApp (Brasil: força +55 se vier só DDD+número) */
function normalizeWhatsAppTo(payload) {
  let d = String(payload || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length >= 10 && d.length <= 11 && !d.startsWith('55')) d = `55${d}`;
  return `+${d}`;
}

function collectWhatsAppDestinations(allUsers) {
  const list = [];
  const extra = process.env.TWILIO_WHATSAPP_TO || process.env.WHATSAPP_CLOUD_TO || '';
  if (extra) {
    for (const raw of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
      const d = normalizeWhatsAppTo(raw);
      if (d) list.push(d);
    }
  }
  for (const u of allUsers || []) {
    const norm = normalizeWhatsAppTo(u.whatsapp);
    if (norm) list.push(norm);
  }
  return [...new Set(list)];
}

/**
 * WhatsApp Business Cloud (Meta Graph API) — variáveis WHATSAPP_CLOUD_ACCESS_TOKEN + WHATSAPP_CLOUD_PHONE_NUMBER_ID.
 */
async function sendWhatsAppCloud(novo, destinations) {
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return false;
  const ver = process.env.WHATSAPP_CLOUD_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${ver}/${phoneNumberId}/messages`;
  const link = buildPlataformaNotifLink(novo);
  const bodyText = `${buildAlertBody(novo)}\nAbrir na plataforma: ${link}`.slice(0, 4090);
  let sent = 0;
  for (const to of destinations) {
    const digits = String(to).replace(/\D/g, '');
    if (digits.length < 10) continue;
    try {
      await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          to: digits,
          type: 'text',
          text: { body: bodyText },
        },
        {
          timeout: 45000,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );
      sent += 1;
      console.log('[notify] WhatsApp Cloud enviado para', digits);
    } catch (e) {
      console.error('[notify] Erro WhatsApp Cloud:', digits, e.response?.data || e.message);
    }
  }
  return sent > 0;
}

/**
 * WhatsApp: Meta Cloud API (se configurado) ou Twilio WhatsApp.
 * @param {object} novo - notificação criada (MPMA / denúncia)
 * @param {Array} [allUsers] - lista de utilizadores (users.json)
 */
async function sendWhatsAppNewNotif(novo, allUsers) {
  if (process.env.NOTIFY_WHATSAPP_ENABLED === 'false') return;
  if ((novo.monitoramentoOrigem || 'MPMA') !== 'MPMA') return;
  const destinations = collectWhatsAppDestinations(allUsers);
  if (!destinations.length) {
    if (process.env.NOTIFY_WHATSAPP_STRICT === '1') {
      console.warn('[notify] WhatsApp: nenhum destino (TWILIO_WHATSAPP_TO / WHATSAPP_CLOUD_TO ou campo whatsapp nos utilizadores).');
    }
    return;
  }
  const link = buildPlataformaNotifLink(novo);
  const body = `${buildAlertBody(novo)}\nAbrir na plataforma: ${link}`;

  const prefer = (process.env.NOTIFY_WHATSAPP_PROVIDER || 'auto').toLowerCase();
  const useCloud =
    prefer === 'cloud' ||
    (prefer === 'auto' && process.env.WHATSAPP_CLOUD_ACCESS_TOKEN && process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID);
  if (useCloud) {
    const ok = await sendWhatsAppCloud(novo, destinations);
    if (ok) return;
    if (prefer === 'cloud') return;
  }

  const client = getTwilio();
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!client || !from) {
    if (!useCloud) {
      console.warn('[notify] WhatsApp: configure Meta (WHATSAPP_CLOUD_*) ou Twilio (TWILIO_* + TWILIO_WHATSAPP_FROM).');
    }
    return;
  }

  const sent = new Set();
  async function sendOneTwilio(rawTo) {
    if (!rawTo) return;
    const to = rawTo.startsWith('whatsapp:') ? rawTo : `whatsapp:${rawTo}`;
    if (sent.has(to)) return;
    try {
      await client.messages.create({ from, to, body });
      sent.add(to);
      console.log('[notify] WhatsApp Twilio enviado para', to);
    } catch (e) {
      console.error('[notify] Erro Twilio WhatsApp:', to, e.message);
    }
  }

  for (const d of destinations) {
    await sendOneTwilio(`whatsapp:${d}`);
  }
}

/**
 * Envia e-mail para destinatários (usuários com campo email).
 */
async function sendEmailNewNotif(novo, usersWithEmail) {
  if (process.env.NOTIFY_EMAIL_ENABLED === 'false') return;
  const tx = getMailer();
  if (!tx) return;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) return;
  const list = (usersWithEmail || []).filter((u) => u && u.email && String(u.email).includes('@'));
  if (!list.length) return;
  const link = buildPlataformaNotifLink(novo);
  const subject = `[PlataformaMP] Nova denúncia / menção — ${novo.id || ''}`;
  const html = `
    <p><strong>${novo.titulo || 'Notificação'}</strong></p>
    <p>ID: <code>${novo.id || ''}</code></p>
    <p><a href="${link}">Abrir na PlataformaMP</a></p>
    ${novo.pdfUrl ? `<p><a href="${novo.pdfUrl}">PDF do Diário Oficial (MPMA)</a></p>` : ''}
    <p style="color:#666;font-size:12px">Mensagem automática da PlataformaMP.</p>
  `;
  for (const u of list) {
    try {
      await tx.sendMail({
        from,
        to: u.email,
        subject,
        text: `${buildAlertBody(novo)}\nAbrir: ${link}`,
        html,
      });
      console.log('[notify] E-mail enviado para', u.email);
    } catch (e) {
      console.error('[notify] Erro SMTP:', u.email, e.message);
    }
  }
}

module.exports = {
  sendWhatsAppNewNotif,
  sendEmailNewNotif,
  buildPlataformaNotifLink,
};
