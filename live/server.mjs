// Adapted from kentjuno/chanh-dien-online (MIT). Copyright (c) 2026 Kent Juno.
// Karaoke Tay Vịn Cún Cưng — live server
// Runs on the streaming PC. Serves the overlay + control panel, listens to a TikTok LIVE room,
// keeps the list of seated viewers, generates Vietnamese voice lines with Edge TTS and pushes
// everything to the overlay over WebSocket.
//
//   cd live && npm install && node server.mjs        → http://localhost:3000/live/control.html
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // repo root: serves /assets, /live
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
const PORT = +process.env.PORT || 3000;

/* -------------------------------------------------------- local moderation */
// Rule-based filtering, not semantic/AI moderation. No comment is sent to a cloud service.
const MODERATION_DEFAULTS = { blockedTerms: [], blockLinks: true, blockPhoneNumbers: true, maxCommentsPer10Seconds: 3 };
let moderationPolicy = { ...MODERATION_DEFAULTS };
try {
  const file = path.join(__dirname, 'moderation.json');
  if (fs.existsSync(file)) {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(p.blockedTerms)) moderationPolicy.blockedTerms = p.blockedTerms.filter(t => typeof t === 'string' && t.trim()).slice(0, 200).map(t => t.slice(0, 80));
    for (const key of ['blockLinks', 'blockPhoneNumbers']) if (typeof p[key] === 'boolean') moderationPolicy[key] = p[key];
    if (Number.isInteger(p.maxCommentsPer10Seconds)) moderationPolicy.maxCommentsPer10Seconds = Math.max(1, Math.min(20, p.maxCommentsPer10Seconds));
  }
} catch { console.warn('Không đọc được moderation.json; dùng bộ lọc mặc định.'); }
const moderationTraffic = new Map();
function cleanText(value){
  return typeof value === 'string' ? value.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim() : '';
}
function foldedText(value){ return cleanText(value).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim(); }
function hasPhrase(text, phrase){ return (' ' + text + ' ').includes(' ' + phrase + ' '); }
function reviewText(value){
  const text = cleanText(value), folded = foldedText(text), lower = text.toLowerCase();
  if (!text) return { ok:false, reason:'nội dung trống', text:'' };
  // Accent-sensitive single words avoid confusing “các”, “lớn”, “đeo” with profanity.
  if (/(^|[^\p{L}])(địt|cặc|lồn|đéo|đụ)(?=$|[^\p{L}])/iu.test(lower)) return { ok:false, reason:'từ ngữ tục tĩu', text:'' };
  const phrases = ['dit me','dit con me','du ma','du me','vai lon','fuck','fucking','pussy','dcm','dmm','dkm'];
  const obfuscated = /\b(?:d[\s._*-]*c[\s._*-]*m|d[\s._*-]*m[\s._*-]*m|d[\s._*-]*k[\s._*-]*m)\b/i;
  if (phrases.some(p => hasPhrase(folded, p)) || obfuscated.test(lower)) return { ok:false, reason:'từ ngữ tục tĩu', text:'' };
  if (['tao giet may','tao se giet may','giet chet may','danh chet may','hiep dam','au dam','mua dam','ban dam'].some(p => hasPhrase(folded, p))) return { ok:false, reason:'đe dọa hoặc nội dung tình dục', text:'' };
  if (moderationPolicy.blockedTerms.some(p => hasPhrase(folded, foldedText(p)))) return { ok:false, reason:'từ khóa bị chặn', text:'' };
  if (moderationPolicy.blockLinks && /(?:https?\s*:\s*\/\/|www\s*\.|\b[\p{L}\d-]+\s*\.\s*(?:com|net|org|vn|io|me|xyz|top|online)\b)/iu.test(text)) return { ok:false, reason:'liên kết hoặc quảng cáo', text:'' };
  if (moderationPolicy.blockPhoneNumbers && /(?:^|[^\d])(?:\+?84|0)(?:[ .()-]*\d){8,10}(?!\d)/u.test(text)) return { ok:false, reason:'số điện thoại', text:'' };
  if (/(.)\1{11,}/iu.test(text) || /\b(\w+)(?:\s+\1){4,}\b/i.test(folded)) return { ok:false, reason:'nội dung lặp', text:'' };
  return { ok:true, reason:'', text:Array.from(text).slice(0, 120).join('') };
}
function moderateComment(id, value, now = Date.now()){
  const reviewed = reviewText(value);
  if (!reviewed.ok) return reviewed;
  const key = String(id), old = moderationTraffic.get(key);
  const recent = old && now - old.since < 10000 ? old : { since:now, count:0 };
  recent.count++; moderationTraffic.set(key, recent);
  if (moderationTraffic.size > 1000) moderationTraffic.delete(moderationTraffic.keys().next().value);
  if (recent.count > moderationPolicy.maxCommentsPer10Seconds) return { ok:false, reason:'gửi bình luận quá nhanh', text:'' };
  return reviewed;
}
function publicName(value){ const result = reviewText(String(value || '')); return result.ok ? result.text.slice(0, 18) : 'Khách hữu duyên'; }

/* ------------------------------------------------------------------ state */
const settings = {
  title: 'KARAOKE TAY VỊN CÚN CƯNG',
  subtitle: 'Chọn bài hát · Bình chọn 1–5 · Lên sân khấu cùng Corgi',
  voice: 'vi-VN-NamMinhNeural',      // or vi-VN-HoaiMyNeural
  pitch: -18,                        // Hz
  rate: -20,                         // %
  music: true, mo: false, moBpm: 52,
  autoChant: false, chantEveryMin: 3,
  videoUrl: '', activeSong: 0,
  seatMode: 'auto',                  // auto | 24 | 36 | 64 | 100
  idleMinutes: 0,                   // 0 disables inferred departure; not a TikTok leave signal
  joinOnEnter: false,                // also seat viewers who only enter the room
  gifts: { readAll: true, minDiamonds: 1 },
};
const meritLedger = new Map();       // preserve session gift points when someone returns
const viewers = new Map();           // id -> { id, name, skin, avatar, coins, joinedAt, lastAt, lastText, lastTextAt, demo }
const startedAt = Date.now();
const SONGS = [
  { title:'Bài hát số 1', artist:'Đang chờ cấu hình' },
  { title:'Bài hát số 2', artist:'Đang chờ cấu hình' },
  { title:'Bài hát số 3', artist:'Đang chờ cấu hình' },
  { title:'Bài hát số 4', artist:'Đang chờ cấu hình' },
  { title:'Bài hát số 5', artist:'Đang chờ cấu hình' },
];
const voteLedger = new Map();
let tiktok = null, tiktokState = { status: 'idle', uniqueId: '', error: '' };
const log = [];
function addLog(s){ const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 300) log.shift(); broadcast({ t:'log', line }, 'control'); console.log(line); }

const CAPS = [24, 36, 64, 100];
function capacity(){ if (settings.seatMode !== 'auto') return +settings.seatMode; const n = viewers.size; return CAPS.find(c => n <= c) || 100; }

/* skins: sprites that exist in /assets. Walking strips exist for man / woman / granny. */
// A comment changes the outfit only when it IS the keyword (≤ 3 words), so "Nam mô A Di Đà Phật" never reads as "nam".
const SKIN_WORDS = [
  ['master', ['cao tăng','cao tang']], ['monk', ['sư','su','sư thầy','su thay','thầy','thay']], ['nun', ['ni','ni cô','ni co','sư cô','su co']],
  ['child', ['tiểu','tieu','chú tiểu','chu tieu','bé','be']], ['granny', ['bà','ba','áo nâu','ao nau','cụ','cu']],
  ['woman', ['nữ','nu','chị','chi','gái','gai']], ['man', ['nam','anh','trai']],
];
function skinFromText(t){
  const w = String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w || w.split(' ').length > 3) return null;
  for (const [skin, words] of SKIN_WORDS) if (words.includes(w)) return skin;
  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'woman', 'man', 'granny'];

function pub(v){ return { id:v.id, name:v.name, skin:v.skin, avatar:v.avatar||'', coins:v.coins, demo:!!v.demo }; }
function snapshot(){ return { t:'state', settings, viewers:[...viewers.values()].map(pub), cap: capacity(), startedAt, tiktok: tiktokState, songs:SONGS, votes:Object.fromEntries(voteLedger) }; }

function seat(id, name, opts = {}){
  let v = viewers.get(id);
  if (v){ v.lastAt = Date.now(); if (opts.avatar) v.avatar = opts.avatar; return { v, isNew:false }; }
  if (viewers.size >= 100){                     // full: the longest-quiet non-donor stands up
    const quiet = [...viewers.values()].filter(x => x.coins === 0).sort((a,b) => a.lastAt - b.lastAt)[0];
    if (!quiet) return { v:null, isNew:false };
    viewers.delete(quiet.id); broadcast({ t:'leave', id: quiet.id });
  }
  v = { id, name: publicName(name || id), skin: opts.skin || DEFAULT_SKINS[viewers.size % DEFAULT_SKINS.length],
        avatar: opts.avatar || '', coins: meritLedger.get(id)?.coins || 0, joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo };
  viewers.set(id, v);
  broadcast({ t:'join', v: pub(v), cap: capacity() });
  return { v, isNew:true };
}

function leaveViewer(id, reason = 'manual'){
  const v = viewers.get(id); if (!v) return false;
  viewers.delete(id); moderationTraffic.delete(String(id));
  if (v.coins) meritLedger.set(id, { coins:v.coins });
  broadcast({ t:'leave', id, reason });
  addLog(reason === 'inactivity' ? 'Tự động rời chỗ do không tương tác (ước lượng, không xác nhận rời LIVE).' : 'Đã cho một nhân vật rời chỗ theo điều khiển.');
  return true;
}
function touchViewer(id, now = Date.now()){ const v = viewers.get(id); if (v) v.lastAt = now; }
function resetViewerActivity(){ for (const id of viewers.keys()) if (String(id).startsWith('tt_')) touchViewer(id); }
function expireInactive(now = Date.now()){
  if (!settings.idleMinutes || tiktokState.status !== 'connected') return;
  for (const [id,v] of viewers) if (String(id).startsWith('tt_') && !v.demo && now - v.lastAt >= settings.idleMinutes * 60000) leaveViewer(id, 'inactivity');
}

/* ------------------------------------------------------------- events in */
function onChat(id, name, text, avatar){
    const voteMatch = String(text || '').trim().match(/^(?:bình chọn\s*)?([1-5])$/iu);
  if (voteMatch) {
    const choice = Number(voteMatch[1]);
    voteLedger.set(choice, (voteLedger.get(choice) || 0) + 1);
    broadcast({ t:'votes', votes:Object.fromEntries(voteLedger), songs:SONGS });
    addLog(`Bình chọn bài ${choice} từ ${publicName(name)}`);
    return;
  }
  // Exact, allowlisted outfit commands do not consume the comment spam budget.
  const command = skinFromText(cleanText(text));
  const reviewed = command ? reviewText(text) : moderateComment(id, text);
  text = reviewed.ok ? reviewed.text : '';
  const want = reviewed.ok ? skinFromText(text) : null;
  const { v, isNew } = seat(id, name, { avatar, skin: want || undefined });
  if (!v) return;
  if (!reviewed.ok) {
    v.lastText = ''; v.lastTextAt = 0;
    broadcast({ t:'chat-clear', id });
    if (reviewed.reason !== 'nội dung trống') addLog('Kiểm duyệt: đã ẩn bình luận (' + reviewed.reason + ').');
    return;
  }
  if (!isNew && want && want !== v.skin){ v.skin = want; broadcast({ t:'skin', id, skin: want }); }
  if (!want) { v.lastText = text; v.lastTextAt = Date.now(); }
  broadcast({ t:'chat', id, name: v.name, text, skin:v.skin, v:pub(v) });
}

function onGift(id, name, giftName, count, diamonds, avatar){
  const reviewedGift = reviewText(String(giftName || 'quà'));
  giftName = reviewedGift.ok ? reviewedGift.text.slice(0, 30) : 'lễ vật'; count = Math.max(1, Math.min(9999, +count || 1));
  const { v } = seat(id, name, { avatar });
  if (!v) return;
  const coins = Math.max(1, (diamonds || 1) * (count || 1));
  v.coins += coins; meritLedger.set(id, { coins:v.coins });
  const prayer = (v.lastText && Date.now() - v.lastTextAt < 90_000 && v.lastText.length > 6) ? v.lastText : pickPrayer();
  const tier = coins >= 99 ? 3 : coins >= 10 ? 2 : 1;
  const line = `${spoken(v.name)} vừa tặng ${giftName}${count > 1 ? ', số lượng ' + count : ''}. Cảm ơn bạn đã ủng hộ Karaoke Tay Vịn Cún Cưng!`;
  broadcast({ t:'gift', id, name: v.name, giftName, count, coins, total: v.coins, tier, prayer });
  if (settings.gifts.readAll || coins >= settings.gifts.minDiamonds) say(line, { tag:'gift', id });
}

function pickPrayer(){
  const P = ['Nguyện cầu gia đạo bình an, vạn sự cát tường', 'Nguyện cầu cha mẹ mạnh khỏe, sống lâu', 'Nguyện hồi hướng công đức cho khắp pháp giới chúng sinh',
             'Nguyện cầu thân tâm an lạc, phiền não tiêu trừ', 'Nguyện cầu công việc hanh thông, gia đình hạnh phúc'];
  return P[Math.floor(Math.random() * P.length)];
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'ẩn danh';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
function esc(s){ return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function say(text, meta = {}){ if (ttsQueue.length >= 15) { addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; } ttsQueue.push({ text: String(text).slice(0, 500), meta }); pumpTTS(); }
async function pumpTTS(){
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  try {
    const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
    const tts = new MsEdgeTTS();
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%` });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', c => chunks.push(c)); audioStream.on('close', res); audioStream.on('error', rej); });
    try { tts.close(); } catch {}
    fs.writeFileSync(path.join(TTS_DIR, file), Buffer.concat(chunks));
    broadcast({ t:'tts', url: `/live/tts/${file}`, text, ...meta });
    const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch {} }
  } catch (e) { addLog('TTS lỗi: ' + (e?.message || e)); }
  ttsBusy = false; setTimeout(pumpTTS, 50);
}

const CHANTS = [
  'Nam mô Bổn Sư Thích Ca Mâu Ni Phật. Nguyện đem công đức này, hướng về khắp tất cả, đệ tử và chúng sinh, đều trọn thành Phật đạo.',
  'Nam mô A Di Đà Phật. Nguyện sanh Tây Phương Tịnh Độ trung, cửu phẩm liên hoa vi phụ mẫu.',
  'Nam mô Đại Bi Quán Thế Âm Bồ Tát. Nguyện cho tất cả chúng sinh thân tâm an lạc, tai qua nạn khỏi.',
  'Quán Tự Tại Bồ Tát hành thâm Bát Nhã Ba La Mật Đa thời, chiếu kiến ngũ uẩn giai không, độ nhất thiết khổ ách.',
];
let chantIdx = 0, chantTimer = null;
function chant(){ const text = CHANTS[chantIdx++ % CHANTS.length]; broadcast({ t:'chant', text }); say(text, { tag:'chant' }); }
function scheduleChant(){ clearInterval(chantTimer); if (settings.autoChant) chantTimer = setInterval(chant, Math.max(1, settings.chantEveryMin) * 60_000); }
scheduleChant();
const departureTimer = setInterval(expireInactive, 5000); departureTimer.unref?.();

/* --------------------------------------------------------------- TikTok */
// Compatibility fix for tiktok-live-connector 2.5 / protobuf v3.
// Upstream: kentjuno/chanh-dien-online, MIT; see the accompanying LICENSE.
let TikTokLib = null, tiktokGeneration = 0, tiktokWatchdog = null;
function liveChatText(data){
  // Protobuf v3 uses content; legacy connector events use comment.
  for (const value of [data?.content, data?.comment]) if (typeof value === 'string' && value.trim()) return value;
  return '';
}
function liveUser(d){
  const u = d?.user || {};
  const rawId = u.id || u.userId || u.uniqueId || u.displayId || d?.userId || d?.uniqueId;
  if (!rawId || String(rawId) === '0') return null;
  return {
    id: 'tt_' + String(rawId),
    name: String(u.nickname || u.displayId || u.uniqueId || d?.nickname || 'ẩn danh').slice(0, 40),
    avatar: u.avatarThumb?.urlList?.[0] || u.avatarThumb?.url?.[0] || u.profilePicture?.urlList?.[0] || u.profilePicture?.url?.[0] || '',
  };
}
function liveGift(d){
  const g = d.gift || d.giftDetails || {}, extra = d.extendedGiftInfo || {};
  const type = Number(g.type ?? g.giftType ?? extra.type ?? d.giftType);
  if (type === 1 && Number(d.repeatEnd) !== 1) return null;
  return {
    name: g.name || g.giftName || extra.name || d.giftName || 'quà',
    count: Math.max(1, Math.min(9999, Number(d.repeatCount) || 1)),
    diamonds: Math.max(1, Number(g.diamondCount ?? g.diamond_count ?? extra.diamond_count ?? extra.diamondCount ?? d.diamondCount) || 1),
  };
}
async function connectTikTok(uniqueId){
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!/^[a-zA-Z0-9_.]{2,24}$/.test(uniqueId)) { addLog('TikTok: username không hợp lệ'); return; }
  const disconnecting = disconnectTikTok();
  const generation = tiktokGeneration;
  await disconnecting;
  if (generation !== tiktokGeneration) return;
  tiktokState = { status:'connecting', uniqueId, error:'' }; broadcast({ t:'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('tiktok-live-connector');
    if (generation !== tiktokGeneration) return;
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = TikTokLib;
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo:false, processInitialData:false });
    tiktok = conn;
    let received = 0, lastLogAt = 0, warned = false, warnedText = false;
    const eventKinds = new Set();
    const active = () => tiktok === conn && generation === tiktokGeneration;
    const receivedEvent = kind => {
      received++;
      const firstKind = !eventKinds.has(kind); eventKinds.add(kind);
      if (firstKind || Date.now() - lastLogAt >= 10000) {
        addLog(`TikTok nhận ${kind} · tổng ${received} sự kiện từ LIVE`); lastLogAt = Date.now();
      }
    };
    const user = d => {
      const u = liveUser(d);
      if (!u && !warned) { warned = true; addLog('TikTok đã gửi sự kiện nhưng thiếu ID người xem; bỏ qua để tránh gộp nhầm tài khoản.'); }
      return u;
    };
    conn.on(WebcastEvent.CHAT, d => {
      if (!active()) return; receivedEvent('bình luận');
      const u = user(d), text = liveChatText(d);
      if (!text && !warnedText) { warnedText = true; addLog('TikTok nhận chat nhưng không có chữ trong content/comment. Kiểm tra phiên bản connector.'); }
      if (u) onChat(u.id, u.name, text, u.avatar);
    });
    conn.on(WebcastEvent.GIFT, d => {
      if (!active()) return; receivedEvent('quà');
      const u = user(d), g = liveGift(d); if (!u || !g) return;
      onGift(u.id, u.name, g.name, g.count, g.diamonds, u.avatar);
      addLog(`🎁 ${publicName(u.name)} đã tặng quà x${g.count}`);
    });
    conn.on(WebcastEvent.MEMBER, d => {
      if (!active()) return; receivedEvent('vào phòng');
      const present = liveUser(d); if (present) touchViewer(present.id);
      if (settings.joinOnEnter) { const u = user(d); if (u) seat(u.id, u.name, { avatar:u.avatar }); }
    });
    conn.on(WebcastEvent.LIKE, d => {
      if (!active()) return; receivedEvent('thả tim');
      const u = user(d); if (u) touchViewer(u.id); if (u) broadcast({ t:'like', id:u.id, n:Math.max(1, Number(d.likeCount) || 1) });
    });
    conn.on(ControlEvent.DISCONNECTED, () => {
      if (!active()) return;
      clearTimeout(tiktokWatchdog); tiktok = null;
      tiktokState = { ...tiktokState, status:'disconnected' }; broadcast({ t:'tiktok', ...tiktokState }); addLog('TikTok: mất kết nối');
    });
    conn.on(ControlEvent.ERROR, e => { if (active()) addLog('TikTok lỗi: ' + (e?.info || e?.message || e)); });
    let timeout;
    const connecting = conn.connect();
    connecting.then(() => { if (!active()) { try { conn.disconnect(); } catch {} } }, () => {});
    let st;
    try { st = await Promise.race([connecting, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Quá 30 giây chờ kết nối TikTok.')), 30000); })]); }
    finally { clearTimeout(timeout); }
    if (!active()) return;
    resetViewerActivity();
    tiktokState = { status:'connected', uniqueId, error:'', roomId:st?.roomId || '' };
    addLog(`✅ Đã kết nối live @${uniqueId} · roomId: ${st?.roomId || '(không có)'}`);
    addLog('Hãy dùng tài khoản khác gửi bình luận mới trong LIVE. Khách mô phỏng không kiểm tra được đường truyền TikTok.');
    tiktokWatchdog = setTimeout(() => {
      if (active() && received === 0) addLog('⚠ TikTok báo kết nối nhưng chưa nhận sự kiện sau 30 giây. Kiểm tra đúng kênh LIVE và thử bình luận bằng tài khoản khác.');
    }, 30000);
    tiktokWatchdog.unref?.();
  } catch (e) {
    if (generation !== tiktokGeneration) return;
    const failed = tiktok; tiktok = null;
    try { failed?.disconnect(); } catch {}
    clearTimeout(tiktokWatchdog);
    tiktokState = { status:'error', uniqueId, error:String(e?.message || e) };
    addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
  }
  broadcast({ t:'tiktok', ...tiktokState });
}
async function disconnectTikTok(){
  tiktokGeneration++; clearTimeout(tiktokWatchdog);
  const previous = tiktok; tiktok = null;
  try { await previous?.disconnect(); } catch {}
  tiktokState = { status:'idle', uniqueId:'', error:'' }; broadcast({ t:'tiktok', ...tiktokState });
}

/* ------------------------------------------------------------- test data */
const DEMO_NAMES = ['Diệu Hạnh','Minh Tâm','Thiện Đức','Huệ An','Tịnh Nhã','Quảng Trí','Chơn Như','Pháp Hỷ','Nguyên Thanh','Tâm Đăng','Diệu Liên','Trí Hải','Phước Lộc','Hạnh Nguyện','Như Ý','Bảo Châu','Thanh Lương','Từ Tâm','An Lạc','Giác Hoa','Tuệ Minh','Liên Hương','Thu Hà','Ngọc Lan','Đức Anh','Hải Đăng','Mai Anh','Phương Thảo','Trung Kiên','Quang Huy','Bảo Ngọc','Diệu Linh'];
function fillDemo(n){
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 100; i++){
    const name = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
    seat('demo_' + i, name, { demo: true, skin: ['man','woman','woman','man','granny','monk','nun','child'][i % 8] });
  }
}
function clearSeats(){ viewers.clear(); moderationTraffic.clear(); meritLedger.clear(); broadcast(snapshot()); addLog('Đã làm trống bồ đoàn'); }

/* ------------------------------------------------------------- control */
function onControl(m){
  switch (m.cmd){
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'chat': { const n = publicName(m.name || 'Khách'); onChat('sim_' + n, n, String(m.text ?? '')); break; }
    case 'gift': { const n = publicName(m.name || 'Khách'); onGift('sim_' + n, n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'fill': fillDemo(clamp(m.n, 1, 100)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'voteReset': voteLedger.clear(); broadcast({ t:'votes', votes:{}, songs:SONGS }); addLog('Đã reset bình chọn'); break;
    case 'songSet': { const i=clamp(m.index,1,5)-1; SONGS[i]={title:String(m.title||`Bài hát ${i+1}`).slice(0,100),artist:String(m.artist||'').slice(0,80)}; broadcast({t:'songs',songs:SONGS,votes:Object.fromEntries(voteLedger)}); break; }
    case 'songNext': settings.activeSong=(settings.activeSong+1)%5; broadcast({t:'songs',songs:SONGS,votes:Object.fromEntries(voteLedger)}); addLog('Chuyển bài hát đang phát'); break;
    case 'leave': if (typeof m.id === 'string') leaveViewer(m.id); break;
    case 'bell': broadcast({ t:'bell' }); break;
    case 'mo': broadcast({ t:'mo1' }); break;
    case 'chant': chant(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag:'say' }); break;
    case 'settings':
      applySettings(m.settings || {});
      scheduleChant(); broadcast({ t:'settings', settings, cap: capacity() }); break;
    case 'bots': setBots(!!m.on, +m.n || 12, m.pace); break;
  }
}

// Only known keys, right types, sane ranges: the panel is local, but nothing from the socket is trusted blindly.
const SETTING_RULES = {
    title: v => String(v).slice(0, 60), subtitle: v => String(v).slice(0, 100),
  videoUrl: v => { const s=String(v||'').trim(); return /^https?:\/\//i.test(s) ? s.slice(0,500) : ''; },
  activeSong: v => clamp(v,0,4),
  voice: v => ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), moBpm: v => clamp(v, 20, 120), chantEveryMin: v => clamp(v, 1, 60),
  music: Boolean, mo: Boolean, autoChant: Boolean, joinOnEnter: Boolean,
  idleMinutes: v => clamp(v, 0, 60),
  seatMode: v => ['auto', '24', '36', '64', '100'].includes(String(v)) ? String(v) : 'auto',
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o){ for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]); }

/* ----------------------------------------------------------------- bots */
let botTimer = null;
const BOT_LINES = ['Nam mô A Di Đà Phật', 'Nam mô Bổn Sư Thích Ca Mâu Ni Phật', 'Cầu cho gia đình bình an', 'Con xin thành tâm sám hối', 'nữ', 'nam', 'bà',
  'Nguyện cầu cha mẹ mạnh khỏe', 'Mô Phật, an lạc quá', 'Chúc mọi người một ngày bình an', 'sư', 'Cầu công việc hanh thông'];
function setBots(on, n, pace){
  clearInterval(botTimer); botTimer = null;
  if (on){
    n = clamp(n, 1, 100);
    for (let i = 0; i < n; i++) seat('bot_' + i, DEMO_NAMES[(i + 7) % DEMO_NAMES.length] + ' ·bot', { demo: true });
    const every = { slow: 4000, mid: 1800, fast: 700 }[pace] || 1800;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .62) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else if (r < .9) broadcast({ t:'like', id, n: 1 + Math.floor(Math.random() * 4) });
      else if (r < .985) onGift(id, v.name, 'Hoa hồng', 1 + Math.floor(Math.random() * 3), 1);
      else onGift(id, v.name, 'Đèn hoa sen', 1, 99);
    }, every);
    addLog(`🤖 Bật ${n} bot, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t:'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t:'bots', on }, 'control');
}

/* -------------------------------------------------------------- server */
// Security notes (this file is meant to be shared publicly):
//  • listens on 127.0.0.1 only; nothing is reachable from the LAN or internet unless HOST is changed on purpose
//  • Host header must be localhost/127.0.0.1 (blocks DNS-rebinding pages from talking to the server)
//  • WebSocket only accepts pages served by this server (Origin check), so other sites open in the
//    same browser cannot send control commands
//  • static files: only /assets and /live, no dot-files, no node_modules, no server source, no path escapes
//  • no TikTok password, cookie or session is ever used or stored; only public room events are read
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp3':'audio/mpeg', '.mp4':'video/mp4', '.webm':'video/webm', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const SEP = path.sep;
function resolveStatic(urlPath){
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (!/^\/(assets|live)\//.test(p)) return null;
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;      // never serve server code / package files
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/live/tts/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;                                   // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  } });
function broadcast(msg, only){ const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') ws.send(JSON.stringify({ t:'logs', lines: log }));
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});
server.listen(PORT, HOST, () => addLog(`Server chạy tại http://localhost:${PORT}  ·  Bảng điều khiển: http://localhost:${PORT}/live/control.html  ·  Overlay: http://localhost:${PORT}/live/overlay.html  ·  Bản sửa departures-v1 (rời chỗ theo điều khiển hoặc thời gian không tương tác)`));