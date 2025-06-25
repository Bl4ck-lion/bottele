// api/bot.js
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const fetch = require('node-fetch');
const Tesseract = require('tesseract.js');
const { Configuration, OpenAIApi } = require('openai');

// ─── ENV CHECK ────────────────────────────────────────────────────────────────
['BOT_TOKEN','OPENAI_API_KEY'].forEach(k => {
  if (!process.env[k]) throw new Error(`${k} not set in environment`);
});

// ─── INIT BOT & OPENAI ────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────────
bot.catch((err, ctx) => console.error('Unhandled bot error', err));
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

// ─── FLOOD CONTROL ────────────────────────────────────────────────────────────
const flood = {};
bot.use((ctx, next) => {
  const cid = ctx.chat.id, uid = ctx.from.id;
  flood[cid] = flood[cid]||{};
  flood[cid][uid] = (flood[cid][uid]||[]).concat(Date.now());
  flood[cid][uid] = flood[cid][uid].filter(ts => Date.now()-ts < 20_000);
  if (flood[cid][uid].length > 15) return ctx.deleteMessage().catch(()=>{});
  return next();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getAnimeImage() {
  try {
    const res = await axios.get('https://api.waifu.pics/sfw/waifu');
    return res.data.url;
  } catch (e) {
    console.error('Waifu API error', e);
    return 'https://via.placeholder.com/500?text=Anime+Error';
  }
}

async function getMeme() {
  try {
    const { data } = await axios.get('https://meme-api.com/gimme');
    if (data.nsfw || data.spoiler) throw new Error('nsfw/spoiler');
    return data;
  } catch (e) {
    console.error('Meme API error', e);
    return { url: 'https://via.placeholder.com/500?text=No+Meme', title: 'No meme' };
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

async function translateText(text) {
  try {
    const res = await fetch('https://de.libretranslate.com/translate', {
      method: 'POST',
      body: JSON.stringify({
        q: text,
        source: 'auto',
        target: 'de',
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
    console.error('Translate API error', e);
    return 'Error translate';
  }
}

async function aiAssist(q) {
  try {
    const weather = await getWeather('Jakarta');
    const crypto = await axios
      .get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')
      .then(r => `BTC $${r.data.bitcoin.usd}`)
      .catch(()=>'');
    const prompt = `User: "${q}"\nLive:\n- ${weather}\n- ${crypto}\nAnswer:`;
    const resp = await openai.createCompletion({ model:'text-davinci-003', prompt, max_tokens:200 });
    return resp.data.choices[0].text.trim();
  } catch (e) {
    console.error('AI Assist error', e);
    return '🤖 Error AI';
  }
}

async function summarizeText(text) {
  try {
    const res = await openai.createCompletion({
      model: 'text-davinci-003',
      prompt: `Summarize this text in concise Indonesian:\n${text}`,
      max_tokens: 150
    });
    return res.data.choices[0].text.trim();
  } catch (e) {
    console.error('Summarize error', e);
    return 'Error ringkasan';
  }
}

async function paraphraseText(text) {
  try {
    const res = await openai.createCompletion({
      model: 'text-davinci-003',
      prompt: `Paraphrase this text in Indonesian:\n${text}`,
      max_tokens: 150
    });
    return res.data.choices[0].text.trim();
  } catch (e) {
    console.error('Paraphrase error', e);
    return 'Error parafrase';
  }
}

// ─── VERIFICATION & /start ────────────────────────────────────────────────────
bot.start(ctx => {
  ctx.session.verified = false;
  ctx.session.todos = [];
  return ctx.reply(
    '🔒 Verifikasi via kontak terlebih dahulu',
    Markup.keyboard([Markup.button.contactRequest('🔒 Verifikasi')]).oneTime().resize()
  );
});
bot.on('contact', ctx => {
  if (ctx.message.contact.user_id === ctx.from.id) {
    ctx.session.verified = true;
    return ctx.reply('✅ Verifikasi berhasil.', Markup.removeKeyboard());
  }
  return ctx.reply('⚠️ Silakan bagikan kontak Anda sendiri.');
});
bot.use((ctx, next) => {
  if (ctx.session.verified || ctx.updateType === 'contact' || ctx.message.text === '/start') {
    return next();
  }
  return ctx.reply('🔒 Verifikasi dulu dengan /start dan bagikan kontak.');
});

// ─── WELCOME NEW MEMBERS ───────────────────────────────────────────────────────
bot.on('new_chat_members', ctx => {
  ctx.message.new_chat_members.forEach(mem =>
    ctx.reply(`Selamat datang, ${mem.first_name}!`)
  );
});

// ─── INLINE QUERIES ────────────────────────────────────────────────────────────
bot.on('inline_query', async ctx => {
  const q = ctx.inlineQuery.query.toLowerCase();
  const results = [];
  if (q.includes('anime')) {
    results.push({
      type: 'photo',
      id: '1',
      photo_url: await getAnimeImage(),
      thumb_url: await getAnimeImage()
    });
  }
  if (q.startsWith('translate ')) {
    const tr = await translateText(q.slice(10));
    results.push({
      type: 'article',
      id: '2',
      title: 'Translate',
      input_message_content: { message_text: `🌐 ${tr}` }
    });
  }
  if (!results.length) {
    const ans = await aiAssist(q);
    results.push({
      type: 'article',
      id: '3',
      title: 'AI Reply',
      input_message_content: { message_text: ans }
    });
  }
  return ctx.answerInlineQuery(results);
});

// ─── MAIN HANDLER ───────────────────────────────────────────────────────────────
bot.on(['photo','document','text'], async ctx => {
  // OCR
  if (ctx.message.photo || (ctx.message.document && ctx.message.document.mime_type.startsWith('image/'))) {
    try {
      const file = ctx.message.photo ? ctx.message.photo.pop() : ctx.message.document;
      const link = await ctx.telegram.getFileLink(file.file_id);
      await ctx.reply('🔍 OCR processing...');
      const { data: { text } } = await Tesseract.recognize(link.href, 'eng');
      return ctx.reply(`📄 Hasil OCR:\n${text}`);
    } catch (e) {
      console.error('OCR error', e);
      return ctx.reply('⚠️ OCR gagal.');
    }
  }

  const txt = (ctx.message.text || '').toLowerCase();

  // To-Do
  if (txt.startsWith('/todo')) {
    const args = txt.split(' ').slice(1);
    const list = ctx.session.todos;
    if (args[0] === 'add')      return ctx.reply(`✅ Todo ditambahkan: ${args.slice(1).join(' ')}`)  && list.push(args.slice(1).join(' '));
    if (args[0] === 'list')     return ctx.reply(list.length ? '📝 ' + list.map((t,i)=>`${i+1}. ${t}`).join('\n') : '📝 Todo kosong');
    if (args[0] === 'del')      return ctx.reply(`❌ Dihapus: ${list.splice(+args[1]-1,1)}`);
    return ctx.reply('Usage: /todo add|list|del');
  }

  // Summarize & Paraphrase
  if (txt.startsWith('/summarize ')) {
    const out = await summarizeText(ctx.message.text.slice(11));
    return ctx.reply(`📝 Ringkasan:\n${out}`);
  }
  if (txt.startsWith('/paraphrase ')) {
    const out = await paraphraseText(ctx.message.text.slice(12));
    return ctx.reply(`✍️ Parafrase:\n${out}`);
  }

  // Keyword commands
  if (txt.includes('anime'))      return ctx.replyWithPhoto(await getAnimeImage(), { caption: '✨ Anime!' });
  if (txt.includes('meme'))       { const m = await getMeme(); return ctx.replyWithPhoto(m.url, { caption: m.title }); }
  if (/cuaca\s+(.+)/.test(txt))   return ctx.reply(await getWeather(txt.match(/cuaca\s+(.+)/)[1].trim()));
  if (/translate\s+(.+)/.test(txt)){ const tr = await translateText(txt.match(/translate\s+(.+)/)[1]); return ctx.reply(`🌐 ${tr}`); }
  if (/remind(?:er)?\s+(\d+)\s+(.+)/.test(txt)) {
    const [_,m, msg] = txt.match(/remind(?:er)?\s+(\d+)\s+(.+)/);
    setTimeout(()=> ctx.reply(`⏰ ${msg}`), +m*60000);
    return ctx.reply('✅ Reminder disetel');
  }

  // Fallback AI
  const ai = await aiAssist(ctx.message.text);
  return ctx.reply(`🤖 ${ai}`);
});

// ─── VERCEL HANDLER ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  console.log('🔔 Got', req.method, req.url);
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body, res);
  } else {
    res.status(200).send('OK');
  }
};
