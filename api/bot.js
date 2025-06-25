const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const fetch = require('node-fetch');
const Tesseract = require('tesseract.js');
const { Configuration, OpenAIApi } = require('openai');

// Guard env vars
if (!process.env.BOT_TOKEN) throw new Error('❌ BOT_TOKEN is not set');
if (!process.env.OPENAI_API_KEY) throw new Error('❌ OPENAI_API_KEY is not set');

// Initialize bot & OpenAI
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

// Global error handling
bot.catch((err, ctx) => console.error('🚨 Bot error', err, 'Update:', ctx.update));
process.on('unhandledRejection', err => console.error('🚨 Unhandled Rejection', err));
process.on('uncaughtException', err => console.error('🚨 Uncaught Exception', err));

// Simple logging middleware
bot.use((ctx, next) => {
  console.log('🔔 Update:', ctx.updateType);
  return next();
});

// Flood control
typeof flood === 'undefined' && (global.flood = {});
bot.use((ctx, next) => {
  if (ctx.chat && ctx.from) {
    const cid = ctx.chat.id, uid = ctx.from.id;
    global.flood[cid] = global.flood[cid] || {};
    global.flood[cid][uid] = global.flood[cid][uid] || [];
    global.flood[cid][uid].push(Date.now());
    global.flood[cid][uid] = global.flood[cid][uid].filter(ts => Date.now() - ts < 20000);
    if (global.flood[cid][uid].length > 15) {
      return ctx.deleteMessage().catch(() => {});
    }
  }
  return next();
});

// Helpers
async function getAnimeImage() {
  try {
    const res = await axios.get('https://api.waifu.pics/sfw/waifu');
    return res.data.url;
  } catch (e) {
    console.error('Anime API error', e);
    return 'https://via.placeholder.com/500?text=Error';
  }
}

async function getWeather(city) {
  try {
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
    return res.data;
  } catch (e) {
    console.error('Weather API error', e);
    return 'Error cuaca';
  }
}

async function getMeme() {
  try {
    const res = await axios.get('https://meme-api.com/gimme');
    return res.data;
  } catch (e) {
    console.error('Meme API error', e);
    return { url: 'https://via.placeholder.com/500?text=No+Meme', title: 'No meme' };
  }
}

async function translateText(text) {
  try {
    const res = await fetch('https://de.libretranslate.com/translate', {
      method: 'POST',
      body: JSON.stringify({
        q: text,
        source: 'auto',
        target: 'id',
        format: 'text',
        alternatives: 3,
        api_key: ''
      }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (Array.isArray(data.translations) && data.translations[0]?.translatedText) {
      return data.translations[0].translatedText;
    }
    return data.translatedText || JSON.stringify(data);
  } catch (e) {
    console.error('Translate error', e);
    return 'Error translate';
  }
}

// AI Assistant
async function aiAssist(query) {
  let liveData = '';
  try { liveData += `Weather: ${await getWeather('Jakarta')}`; } catch (e) { console.error(e); }
  try {
    const btcData = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    liveData += ` | BTC: $${btcData.data.bitcoin.usd}`;
  } catch (e) { console.error('Crypto API error', e); }
  const prompt = `User: "${query}"
Live data: ${liveData}
Answer:`;
  const resp = await openai.createCompletion({ model: 'text-davinci-003', prompt, max_tokens: 200 });
  return resp.data.choices[0].text.trim();
}

// Summarize & Paraphrase
async function summarizeText(text) {
  const prompt = `Summarize this text in concise Indonesian:\n${text}`;
  const res = await openai.createCompletion({ model: 'text-davinci-003', prompt, max_tokens: 150 });
  return res.data.choices[0].text.trim();
}
async function paraphraseText(text) {
  const prompt = `Paraphrase this text in Indonesian:\n${text}`;
  const res = await openai.createCompletion({ model: 'text-davinci-003', prompt, max_tokens: 150 });
  return res.data.choices[0].text.trim();
}

// Verification
bot.start(ctx => {
  ctx.session.verified = false;
  ctx.session.todos = [];
  return ctx.reply('🔒 Silakan verifikasi via kontak',
    Markup.keyboard([Markup.button.contactRequest('🔒 Verifikasi')]).oneTime().resize()
  );
});
bot.on('contact', ctx => {
  if (ctx.message.contact.user_id === ctx.from.id) {
    ctx.session.verified = true;
    return ctx.reply('✅ Verifikasi berhasil.', Markup.removeKeyboard());
  }
  return ctx.reply('⚠️ Silakan share kontak Anda sendiri.');
});
bot.use((ctx, next) => {
  if (ctx.session.verified || ctx.updateType === 'contact' || ctx.message?.text === '/start') return next();
  return ctx.reply('🔒 Verifikasi dulu dengan /start dan bagikan kontak.');
});

// Welcome & anti-spam in group
bot.on('new_chat_members', ctx => {
  const names = ctx.message.new_chat_members.map(m => m.first_name).join(', ');
  return ctx.reply(`Selamat datang, ${names}!`);
});

// Inline queries
bot.on('inline_query', async ctx => {
  const q = ctx.inlineQuery.query.toLowerCase();
  const results = [];
  if (q.includes('anime')) {
    const url = await getAnimeImage();
    results.push({ type: 'photo', id: '1', photo_url: url, thumb_url: url });
  }
  if (q.startsWith('translate ')) {
    const tr = await translateText(q.slice(10));
    results.push({ type: 'article', id: '2', title: 'Translate', input_message_content: { message_text: `🌐 ${tr}` } });
  }
  if (!results.length) {
    const ans = await aiAssist(q);
    results.push({ type: 'article', id: '3', title: 'AI', input_message_content: { message_text: ans } });
  }
  return ctx.answerInlineQuery(results);
});

// Main handler: OCR, commands & fallback
bot.on(['photo','document','text'], async ctx => {
  try {
    // OCR
    if (ctx.message.photo || (ctx.message.document && ctx.message.document.mime_type.startsWith('image/'))) {
      await ctx.reply('🔍 OCR processing...');
      const file = ctx.message.photo?.pop() || ctx.message.document;
      const link = await ctx.telegram.getFileLink(file.file_id);
      const { data: { text } } = await Tesseract.recognize(link.href, 'eng');
      return ctx.reply(`📄 Hasil OCR:\n${text}`);
    }
    const txt = (ctx.message.text || '').trim();
    const lower = txt.toLowerCase();

    // To-Do
    if (lower.startsWith('/todo')) {
      const [ , cmd, ...rest ] = txt.split(' ');
      const todos = ctx.session.todos;
      if (cmd === 'add') {
        todos.push(rest.join(' '));
        return ctx.reply(`✅ Todo dibuat: ${rest.join(' ')}`);
      }
      if (cmd === 'list') {
        return ctx.reply(todos.length ? todos.map((t,i) => `${i+1}. ${t}`).join('\n') : '📝 Todo kosong');
      }
      if (cmd === 'del') {
        const idx = parseInt(rest[0], 10) - 1;
        const rem = todos.splice(idx, 1);
        return ctx.reply(`❌ Dihapus: ${rem}`);
      }
      return ctx.reply('Usage: /todo add <task> | list | del <index>');
    }

    // Summarize & Paraphrase
    if (lower.startsWith('/summarize ')) {
      const res = await summarizeText(txt.slice(11));
      return ctx.reply(`📝 Ringkasan:\n${res}`);
    }
    if (lower.startsWith('/paraphrase ')) {
      const res = await paraphraseText(txt.slice(12));
      return ctx.reply(`✍️ Parafrase:\n${res}`);
    }

    // Keyword shortcuts
    if (lower.includes('anime')) {
      const url = await getAnimeImage();
      return ctx.replyWithPhoto(url, { caption: '✨ Anime art!' });
    }
    if (lower.includes('meme')) {
      const m = await getMeme();
      return ctx.replyWithPhoto(m.url, { caption: m.title });
    }
    const wc = lower.match(/cuaca\s+(.+)/);
    if (wc) return ctx.reply(await getWeather(wc[1].trim()));
    const trm = lower.match(/translate\s+(.+)/);
    if (trm) return ctx.reply(await translateText(trm[1]));
    const rem = lower.match(/remind(?:er)?\s+(\d+)\s+(.+)/);
    if (rem) {
      setTimeout(() => ctx.reply(`⏰ ${rem[2]}`), parseInt(rem[1], 10) * 60000);
      return ctx.reply('✅ Reminder disetel');
    }

    // Fallback AI
    const ai = await aiAssist(txt);
    return ctx.reply(`🤖 ${ai}`);
  } catch (e) {
    console.error('Error pada main handler:', e);
    return ctx.reply('⚠️ Maaf, terjadi kesalahan.');
  }
});

// Webhook auto-setup in production
if (process.env.NODE_ENV === 'production') {
  const url = process.env.VERCEL_URL;
  if (url) {
    bot.telegram.setWebhook(`https://${url}/api/bot`)
      .then(() => console.log('✅ Webhook set to https://' + url + '/api/bot'))
      .catch(console.error);
  }
}

// Vercel handler
module.exports = (req, res) => {
  console.log('🔔 New request:', req.method, req.url);
  if (req.method === 'POST') {
    return bot.handleUpdate(req.body, res);
  }
  res.status(200).send('OK');
};
