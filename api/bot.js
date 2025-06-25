const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const fetch = require('node-fetch');
const Tesseract = require('tesseract.js');
const { Configuration, OpenAIApi } = require('openai');

// Initialize bot & OpenAI
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

// Flood control store
const flood = {};

// Helpers
const getAnimeImage = () => `https://source.unsplash.com/featured/500x500?anime,manga`;
const getWeather = city => axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=3`).then(r=>r.data).catch(()=>`Error cuaca`);
const getMeme = () => fetch('https://meme-api.herokuapp.com/gimme').then(r=>r.json());
const translateText = t => axios.post('https://libretranslate.de/translate',{q:t,source:'auto',target:'id',format:'text'}).then(r=>r.data.translatedText).catch(()=>`Error translate`);
async function aiAssist(q) {
  const weather = await getWeather('Jakarta');
  const crypto = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd').then(r=>`BTC $${r.data.bitcoin.usd}`).catch(()=>``);
  const prompt = `User: "${q}"\nLive:\n- ${weather}\n- ${crypto}\nAnswer:`;
  const resp = await openai.createCompletion({ model:'text-davinci-003', prompt, max_tokens:200 });
  return resp.data.choices[0].text.trim();
}

// Summarize / Paraphrase functions
async function summarizeText(text) {
  const prompt = `Summarize this text in concise Indonesian:\n${text}`;
  const res = await openai.createCompletion({ model:'text-davinci-003', prompt, max_tokens:150 });
  return res.data.choices[0].text.trim();
}
async function paraphraseText(text) {
  const prompt = `Paraphrase this text in Indonesian:\n${text}`;
  const res = await openai.createCompletion({ model:'text-davinci-003', prompt, max_tokens:150 });
  return res.data.choices[0].text.trim();
}

// Verification
bot.start(ctx => {
  ctx.session.verified = false;
  ctx.session.todos = [];
  return ctx.reply('🔒 Verifikasi via kontak terlebih dahulu',
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
bot.use((ctx,next)=>{
  if (ctx.session.verified || ctx.updateType==='contact' || ctx.message.text==='/start') return next();
  return ctx.reply('🔒 Verifikasi dulu dengan /start dan bagikan kontak.');
});

// Group: welcome & anti-spam
bot.on('new_chat_members', ctx => ctx.reply(`Selamat datang, ${ctx.message.new_chat_member.first_name}!`));
bot.on('message', ctx => {
  const cid=ctx.chat.id, uid=ctx.from.id;
  flood[cid] = flood[cid]||{};
  flood[cid][uid] = flood[cid][uid]||[];
  flood[cid][uid].push(Date.now());
  flood[cid][uid] = flood[cid][uid].filter(ts=>Date.now()-ts<20000);
  if (flood[cid][uid].length>10) ctx.deleteMessage().catch(()=>{});
});

// Inline Query Handler
bot.on('inline_query', async ctx => {
  const q = ctx.inlineQuery.query.toLowerCase();
  const results = [];
  if (q.includes('anime')) {
    results.push({ type:'photo', id:'anime1', photo_url:getAnimeImage(), thumb_url:getAnimeImage() });
  }
  if (q.startsWith('translate ')) {
    const txt=q.slice(10);
    const tr=await translateText(txt);
    results.push({ type:'article', id:'tran1', title:'Translate', input_message_content:{message_text:`🌐 ${tr}`} });
  }
  // fallback AI inline
  if (!results.length) {
    const ans=await aiAssist(q);
    results.push({ type:'article', id:'ai1', title:'AI Reply', input_message_content:{message_text:ans} });
  }
  return ctx.answerInlineQuery(results);
});

// Main Handler: OCR, Text Commands & Fallback
bot.on(['photo','document','text'], async ctx => {
  // OCR
  if (ctx.message.photo || (ctx.message.document&&ctx.message.document.mime_type.startsWith('image/'))) {
    try {
      const file=ctx.message.photo?ctx.message.photo.pop():ctx.message.document;
      const link=await ctx.telegram.getFileLink(file.file_id);
      await ctx.reply('🔍 OCR processing...');
      const { data:{text} } = await Tesseract.recognize(link.href,'eng');
      return ctx.reply(`📄 Hasil OCR:\n${text}`);
    } catch { return ctx.reply('⚠️ OCR gagal.'); }
  }
  const txt=(ctx.message.text||'').toLowerCase();
  // To-Do
  if (txt.startsWith('/todo')) {
    const p=txt.split(' ').slice(1), list=ctx.session.todos;
    if(p[0]==='add'){ list.push(p.slice(1).join(' ')); return ctx.reply(`✅ Todo: ${p.slice(1).join(' ')}`); }
    if(p[0]==='list'){ return ctx.reply(list.length?('📝 Todos:\n'+list.map((t,i)=>`${i+1}. ${t}`).join('\n')):'📝 Todo kosong'); }
    if(p[0]==='del'){ const i=parseInt(p[1])-1; const rem=list.splice(i,1); return ctx.reply(`❌ Dihapus: ${rem}`); }
    return ctx.reply('Usage: /todo add|list|del');
  }
  // Summarize
  if (txt.startsWith('/summarize ')) {
    const arg=ctx.message.text.slice(11);
    const res=await summarizeText(arg);
    return ctx.reply(`📝 Ringkasan:\n${res}`);
  }
  // Paraphrase
  if (txt.startsWith('/paraphrase ')) {
    const arg=ctx.message.text.slice(12);
    const res=await paraphraseText(arg);
    return ctx.reply(`✍️ Parafrase:\n${res}`);
  }
  // Keyword-based features
  if (txt.includes('anime')) return ctx.replyWithPhoto(getAnimeImage(), '✨ Anime art!');
  if (txt.includes('meme')){ const m=await getMeme(); return ctx.replyWithPhoto(m.url,m.title);}  
  const w=txt.match(/cuaca\s+([\w\s]+)/);
  if(w) return ctx.reply(await getWeather(w[1].trim()));
  const tr=txt.match(/translate\s+(.+)/);
  if(tr) return ctx.reply(await translateText(tr[1]));
  const rem=txt.match(/remind(?:er)?\s+(\d+)\s+(.+)/);
  if(rem){ setTimeout(()=>ctx.reply(`⏰ ${rem[2]}`),parseInt(rem[1])*60000); return ctx.reply('✅ Reminder disetel'); }
  // Fallback AI
  const ai=await aiAssist(ctx.message.text);
  return ctx.reply(`🤖 ${ai}`);
});

// Vercel handler
module.exports = (req, res) => {
  if (req.method === 'POST') bot.handleUpdate(req.body, res);
  else res.status(200).send('OK');
};
