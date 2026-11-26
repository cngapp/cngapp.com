/**
 * Serveur de cngapp.com (Cloudflare Pages Functions), sous /api/ :
 *   POST /api/annonce           Annonce IA gratuite (Workers AI, photos → titre/description), protégée par Turnstile
 *   POST /api/retour            Avis des testeurs : vérifié par Turnstile puis transmis (e-mail via le script Google + ntfy)
 *   POST /api/push/abonner      Notifications « Nouvelle tendance » (bêta) : enregistre l'abonnement du téléphone
 *   POST /api/push/desabonner   Retire l'abonnement
 *   POST /api/push/tendance     Prévient les abonnés de la dernière tendance publiée (une seule fois par tendance)
 *   POST /api/cloud/*           Sauvegarde et synchro chiffrées SUR L'APPAREIL (le serveur ne peut pas les lire)
 *   POST /api/pro/*             Codes Pro (créés par l'admin) : annonce IA illimitée
 *   POST /api/avis/*            Avis des utilisateurs (modérés par l'admin), publiés sur /avis/
 *   POST /api/push/vente        Notification de vente envoyée par le script Google personnel de l'utilisateur (jeton)
 *   POST /api/push/bilan        Rappel du bilan du dimanche (appelé par le Worker programmé « cng-bilan »)
 *   GET|POST /api/script        Tendances partagées (bêta) et statistiques d'utilisation, avec le même protocole que
 *                               l'ancien script Google (données dans la base D1 au lieu du Drive)
 *
 * Ce fichier est public (comme le reste du site) : AUCUN secret ici. Les clés sont dans les réglages du projet
 * Cloudflare (TURNSTILE_SECRET, VAPID_PRIVATE, RELAIS, CRON_SECRET) ; liaisons : AI (Workers AI), CNG (stockage KV), DB (base D1).
 */

export const AI_FREE_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const LIMITS = { perIpPerDay: 12, totalPerDay: 400, proPerDay: 150, proTotalPerDay: 2000, images: 3, imageChars: 600_000 };
const CONDITIONS = ['Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'Satisfaisant'];
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com|[a-z0-9.-]+\.push\.apple\.com)$/;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, erreur) => json({ ok: false, erreur }, status);
const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

export function b64uEncode(bytes) {
  let bin = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const enc = new TextEncoder();
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
async function sha256hex(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join(''); }

export async function turnstileOk(env, token, ip, fetcher = fetch) {
  if (!token || typeof token !== 'string' || token.length > 4096 || !env.TURNSTILE_SECRET) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const r = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const j = await r.json();
    return j.success === true;
  } catch { return false; }
}

/** Compteur (base D1, effacé au bout de 2 jours). Renvoie false si la limite est atteinte. */
async function underLimit(db, key, max, now = Date.now()) {
  const row = await db.prepare('SELECT n FROM compteurs WHERE cle = ?1 AND expire > ?2').bind(key, now).first();
  if (row && row.n >= max) return false;
  await db.prepare('INSERT INTO compteurs (cle, n, expire) VALUES (?1, 1, ?2) ON CONFLICT(cle) DO UPDATE SET n = CASE WHEN expire > ?3 THEN n + 1 ELSE 1 END, expire = CASE WHEN expire > ?3 THEN expire ELSE ?2 END')
    .bind(key, now + 2 * 86400_000, now).run();
  if (Math.random() < 0.02) await db.prepare('DELETE FROM compteurs WHERE expire < ?1').bind(now).run();
  return true;
}

// ---------------------------------------------------------------------------
// Annonce IA gratuite
// ---------------------------------------------------------------------------

export function freeListingPrompt(categories, notes) {
  return `Tu rédiges une annonce Vinted en français pour un vendeur de vêtements de seconde main, à partir des photos.
Règles :
- N'invente rien : marque, taille, matière ou défaut seulement s'ils sont lisibles sur les photos ou donnés par le vendeur, sinon null / liste vide.
- Aucun prix, aucun chiffre de vente.
- Titre accrocheur, 60 caractères maximum, format « Type Marque Détail clé couleur - Taille X » (sans la taille si inconnue).
- Description courte et honnête (4 à 7 lignes) : ce que c'est, style, état, défauts éventuels, conseil de taille si visible ; ton simple et chaleureux, tutoiement, pas d'emojis excessifs.
- 5 à 8 hashtags pertinents sans espaces.
- Catégorie parmi : ${categories.join(', ')}.
- État parmi : ${CONDITIONS.join(', ')}.
${notes ? `Infos du vendeur (fiables) : ${notes}\n` : ''}Réponds UNIQUEMENT avec un objet JSON : {"title":"","description":"","brand":null,"size":null,"condition":null,"category":"","color":null,"hashtags":[],"defects":[]}`;
}

/** Vérifie et nettoie la demande (rien d'autre que des photos JPEG, quelques mots et la liste de catégories). */
export function cleanListingRequest(d) {
  if (!d || typeof d !== 'object') return null;
  const images = Array.isArray(d.images) ? d.images.filter((x) => typeof x === 'string' && /^[A-Za-z0-9+/=]+$/.test(x) && x.length <= LIMITS.imageChars).slice(0, LIMITS.images) : [];
  if (!images.length) return null;
  const notes = typeof d.notes === 'string' ? d.notes.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) : '';
  const cats = Array.isArray(d.categories) ? d.categories.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.replace(/[\u0000-\u001f,]/g, ' ').trim().slice(0, 40)).slice(0, 40) : [];
  return { images, notes, categories: cats.length ? cats : ['Autres vêtements'] };
}

async function annonce(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  const d = await request.json().catch(() => null);
  if (!(await turnstileOk(env, d && d.token, ip))) return fail(403, 'verification');
  const req = cleanListingRequest(d);
  if (!req) return fail(400, 'photos');
  const today = day();
  const pro = await proStatus(env, d.pro);
  if (pro) {
    if (!(await underLimit(env.DB, `iapro:${today}`, LIMITS.proTotalPerDay))) return fail(429, 'quota-global');
    if (!(await underLimit(env.DB, `iapro:${today}:${pro.hash}`, LIMITS.proPerDay))) return fail(429, 'quota-pro');
  } else {
    if (!(await underLimit(env.DB, `ia:${today}`, LIMITS.totalPerDay))) return fail(429, 'quota-global');
    if (!(await underLimit(env.DB, `ia:${today}:${await sha256hex(ip)}`, LIMITS.perIpPerDay))) return fail(429, 'quota');
  }
  let out;
  try {
    out = await env.AI.run(AI_FREE_MODEL, {
      messages: [{ role: 'user', content: [{ type: 'text', text: freeListingPrompt(req.categories, req.notes) }, ...req.images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b}` } }))] }],
      max_tokens: 900,
      temperature: 0.4,
    });
  } catch {
    return fail(503, 'ia');
  }
  const text = typeof out?.response === 'string' ? out.response : out?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) return fail(502, 'ia');
  return json({ ok: true, text });
}

// ---------------------------------------------------------------------------
// Avis des testeurs
// ---------------------------------------------------------------------------

async function retour(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  const d = await request.json().catch(() => null);
  if (!(await turnstileOk(env, d && d.token, ip))) return fail(403, 'verification');
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const title = s(d.title, 120), message = s(d.message, 3800), contact = s(d.contact, 120), topic = s(d.topic, 80);
  if (message.trim().length < 3) return fail(400, 'message');
  if (!(await underLimit(env.DB, `avis:${day()}:${await sha256hex(ip)}`, 20))) return fail(429, 'quota');
  const tags = Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string').slice(0, 3) : [];
  const priority = [3, 4].includes(d.priority) ? d.priority : 3;
  const [mailed, pushed] = await Promise.all([
    env.APPS_SCRIPT_URL
      ? fetch(env.APPS_SCRIPT_URL, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ app: 'cng-vinted', title, message, contact, relais: env.RELAIS || '' }), redirect: 'follow' })
          .then(async (r) => r.ok && (await r.json().catch(() => null))?.ok === true).catch(() => false)
      : false,
    topic ? fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify({ topic, title, message, tags, priority }) }).then((r) => r.ok, () => false) : false,
  ]);
  if (!mailed && !pushed) return fail(502, 'envoi');
  return json({ ok: true, mailed, pushed });
}

// ---------------------------------------------------------------------------
// Notifications (Web Push : RFC 8291 chiffrement aes128gcm + RFC 8292 VAPID)
// ---------------------------------------------------------------------------

export function cleanSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return null;
  let u;
  try { u = new URL(sub.endpoint); } catch { return null; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.test(u.hostname)) return null;
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return null;
  try { if (b64uDecode(k.p256dh).length !== 65 || b64uDecode(k.auth).length !== 16) return null; } catch { return null; }
  return { endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** Chiffre un message pour un abonnement (aes128gcm). `salt` et `serverKeys` ne servent qu'aux tests. */
export async function encryptPush(sub, payload, { salt = crypto.getRandomValues(new Uint8Array(16)), serverKeys } = {}) {
  const ua = b64uDecode(sub.keys.p256dh);
  const auth = b64uDecode(sub.keys.auth);
  const as = serverKeys || (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
}

export async function vapidAuthorization(env, endpoint, now = Date.now()) {
  const jwk = JSON.parse(env.VAPID_PRIVATE);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://cngapp.com' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64uEncode(sig)}, k=${env.VAPID_PUBLIC}`;
}

export async function sendPush(env, sub, message, fetcher = fetch) {
  const body = await encryptPush(sub, JSON.stringify(message));
  const r = await fetcher(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidAuthorization(env, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body,
  });
  return r.status;
}

export const TOPICS = ['tendances', 'bilan', 'ventes'];

/** Abonnement d'un appareil, avec ses sujets. Les anciens abonnements (sans sujets) = tendances. */
async function readSub(env, key) {
  const v = JSON.parse((await env.CNG.get(key)) || 'null');
  if (v && !v.topics) v.topics = { tendances: true };
  return v;
}

async function abonner(request, env) {
  const d = await request.json().catch(() => null);
  const sub = cleanSubscription(d && d.subscription);
  if (!sub) return fail(400, 'abonnement');
  const key = `abo:${await sha256hex(sub.endpoint)}`;
  const old = await readSub(env, key);
  const asked = d.topics && typeof d.topics === 'object' ? d.topics : { tendances: true };
  const topics = { ...(old ? old.topics : {}) };
  for (const t of TOPICS) if (typeof asked[t] === 'boolean') topics[t] = asked[t];
  let jeton = null;
  const row = { ...sub, topics, since: old ? old.since : new Date().toISOString(), jetonHash: old ? old.jetonHash || null : null };
  // nouveau jeton : à la première activation, ou sur demande (jeton perdu / script réinstallé)
  if (topics.ventes && (!row.jetonHash || d.nouveauJeton === true)) {
    if (row.jetonHash) await env.CNG.delete(`jeton:${row.jetonHash}`);
    jeton = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
    row.jetonHash = await sha256hex(`jeton:${jeton}`);
    await env.CNG.put(`jeton:${row.jetonHash}`, key);
  }
  if (!topics.ventes && row.jetonHash) { await env.CNG.delete(`jeton:${row.jetonHash}`); row.jetonHash = null; }
  if (!TOPICS.some((t) => topics[t])) { await env.CNG.delete(key); return json({ ok: true, topics }); }
  await env.CNG.put(key, JSON.stringify(row));
  return json({ ok: true, topics, ...(jeton ? { jeton } : {}) });
}

async function desabonner(request, env) {
  const d = await request.json().catch(() => null);
  if (!d || typeof d.endpoint !== 'string') return fail(400, 'abonnement');
  const key = `abo:${await sha256hex(d.endpoint)}`;
  const old = await readSub(env, key);
  if (old && old.jetonHash) await env.CNG.delete(`jeton:${old.jetonHash}`);
  await env.CNG.delete(key);
  return json({ ok: true });
}

/** Envoie un message à tous les abonnés d'un sujet ; oublie les abonnements expirés. */
async function broadcast(env, topic, msg) {
  let sent = 0, cursor;
  do {
    const page = await env.CNG.list({ prefix: 'abo:', cursor });
    await Promise.all(page.keys.map(async ({ name }) => {
      const sub = await readSub(env, name);
      if (!sub || !sub.topics[topic]) return;
      const status = await sendPush(env, sub, msg).catch(() => 0);
      if (status === 404 || status === 410) { await env.CNG.delete(name); if (sub.jetonHash) await env.CNG.delete(`jeton:${sub.jetonHash}`); }
      else if (status >= 200 && status < 300) sent++;
    }));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return sent;
}

/** Vente détectée par le script Google personnel de l'utilisateur : notification sur SES appareils. */
async function pushVente(request, env) {
  const d = await request.json().catch(() => null);
  if (!d || typeof d.jeton !== 'string' || !/^[a-f0-9]{32}$/.test(d.jeton)) return fail(400, 'jeton');
  const h = await sha256hex(`jeton:${d.jeton}`);
  const key = await env.CNG.get(`jeton:${h}`);
  if (!key) return fail(404, 'jeton');
  if (!(await underLimit(env.DB, `vente:${day()}:${h}`, 80))) return fail(429, 'quota');
  const sub = await readSub(env, key);
  if (!sub || !sub.topics.ventes) return fail(404, 'jeton');
  const s = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : '');
  const msg = { title: s(d.titre, 80) || '💸 Nouvelle vente', body: s(d.texte, 200), url: s(d.url, 40).startsWith('#/') ? s(d.url, 40) : '#/ventes', tag: `vente-${Date.now()}` };
  const status = await sendPush(env, sub, msg).catch(() => 0);
  if (status === 404 || status === 410) { await env.CNG.delete(key); await env.CNG.delete(`jeton:${h}`); return fail(410, 'expire'); }
  return json({ ok: status >= 200 && status < 300 });
}

async function pushBilan(request, env) {
  if (!env.CRON_SECRET || request.headers.get('x-cron') !== env.CRON_SECRET) return fail(403, 'cron');
  const sent = await broadcast(env, 'bilan', { title: '📊 Ton bilan de la semaine', body: 'Ventes, bénéfice, articles qui dorment : jette un œil avant d’attaquer la semaine.', url: '#/bilan', tag: `bilan-${day()}` });
  return json({ ok: true, envoyes: sent });
}

/** Message de notification pour une tendance (données venant du script Google, déjà publiques). */
export function trendMessage(t) {
  const name = [t.brand, t.title].filter((x) => typeof x === 'string' && x.trim()).join(' · ').slice(0, 90) || 'Un nouvel article';
  const extra = [typeof t.likes === 'number' ? `${t.likes} ❤️` : '', typeof t.price === 'number' ? `${(t.price / 100).toFixed(2).replace('.', ',')} €` : ''].filter(Boolean).join(' · ');
  return { title: '🔥 Nouvelle tendance', body: extra ? `${name} — ${extra}` : name, url: '#/tendances', tag: `tendance-${t.id}` };
}

/** Choisit la tendance à annoncer : la plus récemment AJOUTÉE (pas modifiée), il y a moins de 30 min. */
export function latestNewTrend(items, now = Date.now()) {
  const fresh = (Array.isArray(items) ? items : []).filter((t) => t && typeof t.id === 'string' && Date.parse(t.addedAt) > now - 30 * 60_000);
  return fresh.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))[0] || null;
}

async function tendance(env) {
  const t = latestNewTrend(await listTrends(env));
  if (!t) return json({ ok: true, envoyes: 0 });
  const done = `notifie:${t.id}`;
  if (await env.CNG.get(done)) return json({ ok: true, envoyes: 0 });
  await env.CNG.put(done, '1', { expirationTtl: 30 * 86400 });
  return json({ ok: true, envoyes: await broadcast(env, 'tendances', trendMessage(t)) });
}

// ---------------------------------------------------------------------------
// Tendances et statistiques (même protocole que l'ancien script Google)
// ---------------------------------------------------------------------------

const TREND_FIELDS = { title: 160, brand: 80, size: 40, condition: 60, seller: 60, url: 500, text: 3000, note: 300 };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const MAX_PHOTO_B64 = 1_900_000;

/**
 * Admin : la clé envoyée par l'appli (empreinte du code admin, jamais le code) est comparée à l'empreinte
 * enregistrée. Première fois : vérifiée auprès de l'ancien script Google (qui connaît le code), puis seule
 * son empreinte est gardée ici.
 */
export async function isAdminKey(env, key, fetcher = fetch) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return false;
  const h = await sha256hex(`cng-admin:${key}`);
  const row = await env.DB.prepare("SELECT valeur FROM reglages WHERE cle = 'admin'").first();
  if (row) return row.valeur === h;
  if (!env.APPS_SCRIPT_URL) return false;
  const r = await fetcher(`${env.APPS_SCRIPT_URL}?action=presence&key=${encodeURIComponent(key)}`, { redirect: 'follow' }).catch(() => null);
  const j = r && (await r.json().catch(() => null));
  if (!j || j.ok !== true) return false;
  await env.DB.prepare("INSERT OR IGNORE INTO reglages (cle, valeur) VALUES ('admin', ?1)").bind(h).run();
  return true;
}

async function listTrends(env) {
  const { results } = await env.DB.prepare('SELECT data FROM tendances ORDER BY added_at DESC LIMIT 300').all();
  return results.map((r) => JSON.parse(r.data));
}

/** Une seule fois : reprend les tendances (et leurs photos) de l'ancien script Google. */
export async function importOldTrends(env, fetcher = fetch) {
  const done = await env.DB.prepare("SELECT valeur FROM reglages WHERE cle = 'import_tendances'").first();
  if (done || !env.APPS_SCRIPT_URL) return 0;
  const r = await fetcher(`${env.APPS_SCRIPT_URL}?action=tendances`, { redirect: 'follow' }).catch(() => null);
  const j = r && (await r.json().catch(() => null));
  if (!j || j.ok !== true || !Array.isArray(j.items)) return 0;
  let n = 0;
  for (const t of j.items.slice(0, 300)) {
    if (!t || typeof t.id !== 'string') continue;
    let photo = null;
    if (typeof t.photo === 'string' && t.photo) {
      const pr = await fetcher(`${env.APPS_SCRIPT_URL}?action=photo&id=${encodeURIComponent(t.photo)}`, { redirect: 'follow' }).catch(() => null);
      const p = pr && (await pr.json().catch(() => null));
      if (p && p.ok && typeof p.data === 'string' && p.data.length <= MAX_PHOTO_B64 && /^image\/(jpeg|png|webp)$/.test(p.mime)) {
        photo = `p-${crypto.randomUUID()}`;
        await env.DB.prepare('INSERT OR REPLACE INTO photos (id, mime, data) VALUES (?1, ?2, ?3)').bind(photo, p.mime, p.data).run();
      }
    }
    const row = { ...t, photo };
    const added = typeof t.addedAt === 'string' ? t.addedAt : new Date().toISOString();
    await env.DB.prepare('INSERT OR IGNORE INTO tendances (id, data, added_at, updated_at) VALUES (?1, ?2, ?3, ?4)').bind(t.id, JSON.stringify(row), added, typeof t.updatedAt === 'string' ? t.updatedAt : added).run();
    n++;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO reglages (cle, valeur) VALUES ('import_tendances', ?1)").bind(new Date().toISOString()).run();
  return n;
}

async function saveTrend(env, d) {
  const it = d.item || {};
  const now = new Date().toISOString();
  const old = typeof it.id === 'string' ? await env.DB.prepare('SELECT data FROM tendances WHERE id = ?1').bind(it.id).first() : null;
  const prev = old ? JSON.parse(old.data) : null;
  const row = { id: prev ? prev.id : crypto.randomUUID(), photo: prev ? prev.photo : null, addedAt: prev ? prev.addedAt : now, updatedAt: now };
  for (const [c, n] of Object.entries(TREND_FIELDS)) row[c] = String(it[c] ?? '').slice(0, n);
  if (!/^https:\/\//i.test(row.url)) row.url = '';
  row.price = num(it.price);
  row.likes = num(it.likes);
  const ph = d.photo;
  if (ph && typeof ph.data === 'string' && /^image\/(jpeg|png|webp)$/.test(ph.mime)) {
    if (ph.data.length > MAX_PHOTO_B64 || !/^[A-Za-z0-9+/=]+$/.test(ph.data)) return { ok: false, erreur: 'photo trop lourde' };
    if (row.photo) await env.DB.prepare('DELETE FROM photos WHERE id = ?1').bind(row.photo).run();
    row.photo = `p-${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO photos (id, mime, data) VALUES (?1, ?2, ?3)').bind(row.photo, ph.mime, ph.data).run();
  }
  await env.DB.prepare('INSERT INTO tendances (id, data, added_at, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?4')
    .bind(row.id, JSON.stringify(row), row.addedAt, row.updatedAt).run();
  return { ok: true, item: row };
}

async function deleteTrend(env, id) {
  const old = await env.DB.prepare('SELECT data FROM tendances WHERE id = ?1').bind(String(id || '')).first();
  if (old) {
    const t = JSON.parse(old.data);
    if (t.photo) await env.DB.prepare('DELETE FROM photos WHERE id = ?1').bind(t.photo).run();
    await env.DB.prepare('DELETE FROM tendances WHERE id = ?1').bind(t.id).run();
  }
  return { ok: true };
}

async function presence(env, d) {
  const id = String(d.id || '').slice(0, 64);
  if (!/^[a-z0-9-]{8,64}$/.test(id)) return { ok: false };
  const now = new Date().toISOString();
  const old = await env.DB.prepare('SELECT data, last FROM appareils WHERE id = ?1').bind(id).first();
  // au plus une écriture toutes les 4 minutes par appareil
  if (old && Date.parse(old.last) > Date.now() - 4 * 60_000) return { ok: true };
  const prev = old ? JSON.parse(old.data) : null;
  const row = {
    id, v: d.v === 'beta' ? 'beta' : 'officielle', build: String(d.build || '').slice(0, 12),
    tester: d.tester ? String(d.tester).slice(0, 30) : null, device: String(d.device || '').slice(0, 80), google: d.google === true,
    first: prev ? prev.first : now, last: now, opens: (prev ? prev.opens : 0) + 1,
  };
  await env.DB.prepare('INSERT INTO appareils (id, data, last) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, last = ?3').bind(id, JSON.stringify(row), now).run();
  return { ok: true };
}

async function script(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const action = url.searchParams.get('action');
    if (action === 'tendances') {
      await importOldTrends(env).catch(() => 0);
      return json({ ok: true, items: await listTrends(env) });
    }
    if (action === 'photo') {
      const id = url.searchParams.get('id') || '';
      const p = await env.DB.prepare('SELECT mime, data FROM photos WHERE id = ?1').bind(id).first();
      return json(p ? { ok: true, mime: p.mime, data: p.data } : { ok: false });
    }
    if (action === 'presence') {
      if (!(await isAdminKey(env, url.searchParams.get('key')))) return json({ ok: false, erreur: 'cle' });
      const { results } = await env.DB.prepare('SELECT data FROM appareils ORDER BY last DESC LIMIT 500').all();
      return json({ ok: true, devices: results.map((r) => JSON.parse(r.data)) });
    }
    return json({ ok: true, service: 'cngapp.com' });
  }
  const d = JSON.parse(await request.text().catch(() => 'null') || 'null');
  if (!d || typeof d !== 'object') return json({ ok: false, erreur: 'refusé' });
  if (d.app === 'cng-presence') return json(await presence(env, d));
  if (d.app === 'cng-tendances') {
    if (!(await isAdminKey(env, d.key))) return json({ ok: false, erreur: 'cle' });
    if (d.op === 'delete') return json(await deleteTrend(env, d.id));
    if (d.op === 'save' && d.item) return json(await saveTrend(env, d));
    return json({ ok: false });
  }
  return json({ ok: false, erreur: 'refusé' });
}

// ---------------------------------------------------------------------------
// Sauvegarde et synchro chiffrées (compte = code de récupération, jamais envoyé au serveur)
// ---------------------------------------------------------------------------
// L'appareil dérive de son code : un identifiant de compte, un secret d'accès, et la clé de chiffrement
// (qui ne quitte jamais l'appareil). Le serveur ne garde que des morceaux chiffrés + l'empreinte du secret.

export const CLOUD = { maxParts: 40, partChars: 1_400_000, maxPhotoChars: 1_900_000, maxPhotosChars: 150_000_000 };
const HEX64 = /^[a-f0-9]{64}$/;

async function cloudAccount(env, d) {
  if (!d || !HEX64.test(d.id || '') || !HEX64.test(d.secret || '')) return { error: fail(400, 'compte') };
  const row = await env.DB.prepare('SELECT secret, version, maj, taille FROM cloud_comptes WHERE id = ?1').bind(d.id).first();
  const h = await sha256hex(`cloud:${d.secret}`);
  if (row && row.secret !== h) return { error: fail(403, 'code') };
  return { row, h };
}

async function cloud(path, request, env) {
  const d = await request.json().catch(() => null);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await underLimit(env.DB, `cloud:${day()}:${await sha256hex(ip)}`, 3000))) return fail(429, 'quota');
  const { row, h, error } = await cloudAccount(env, d);
  if (error) return error;
  const op = path.slice('/api/cloud/'.length);
  if (op === 'etat') {
    if (!row) return json({ ok: true, existe: false });
    const { results } = await env.DB.prepare('SELECT pid FROM cloud_photos WHERE compte = ?1').bind(d.id).all();
    return json({ ok: true, existe: true, version: row.version, maj: row.maj, photos: results.map((r) => r.pid) });
  }
  if (op === 'envoyer') {
    const parts = Array.isArray(d.parts) ? d.parts : null;
    if (!parts || !parts.length || parts.length > CLOUD.maxParts || parts.some((x) => typeof x !== 'string' || x.length > CLOUD.partChars)) return fail(400, 'donnees');
    const current = row ? row.version : 0;
    if (Number(d.base) !== current) return json({ ok: false, erreur: 'conflit', version: current }, 409);
    const version = current + 1, now = new Date().toISOString();
    const size = parts.reduce((a, x) => a + x.length, 0);
    const stmts = [
      env.DB.prepare('INSERT INTO cloud_comptes (id, secret, version, maj, taille) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET version = ?3, maj = ?4, taille = ?5 WHERE cloud_comptes.version = ?6')
        .bind(d.id, h, version, now, size, current),
      env.DB.prepare('DELETE FROM cloud_parts WHERE compte = ?1').bind(d.id),
      ...parts.map((x, i) => env.DB.prepare('INSERT INTO cloud_parts (compte, n, data) VALUES (?1, ?2, ?3)').bind(d.id, i, x)),
    ];
    await env.DB.batch(stmts);
    return json({ ok: true, version, maj: now });
  }
  if (!row) return json({ ok: false, erreur: 'inconnu' }, 404);
  if (op === 'recevoir') {
    const { results } = await env.DB.prepare('SELECT data FROM cloud_parts WHERE compte = ?1 ORDER BY n').bind(d.id).all();
    return json({ ok: true, version: row.version, maj: row.maj, parts: results.map((r) => r.data) });
  }
  if (op === 'photo') {
    const pid = typeof d.pid === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(d.pid) ? d.pid : null;
    if (!pid) return fail(400, 'photo');
    if (d.op === 'envoyer') {
      if (typeof d.data !== 'string' || d.data.length > CLOUD.maxPhotoChars) return fail(400, 'photo');
      const used = await env.DB.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM cloud_photos WHERE compte = ?1').bind(d.id).first();
      if ((used ? used.n : 0) + d.data.length > CLOUD.maxPhotosChars) return fail(413, 'plein');
      await env.DB.prepare('INSERT OR REPLACE INTO cloud_photos (compte, pid, data) VALUES (?1, ?2, ?3)').bind(d.id, pid, d.data).run();
      return json({ ok: true });
    }
    if (d.op === 'recevoir') {
      const p = await env.DB.prepare('SELECT data FROM cloud_photos WHERE compte = ?1 AND pid = ?2').bind(d.id, pid).first();
      return json(p ? { ok: true, data: p.data } : { ok: false });
    }
    if (d.op === 'supprimer') {
      await env.DB.prepare('DELETE FROM cloud_photos WHERE compte = ?1 AND pid = ?2').bind(d.id, pid).run();
      return json({ ok: true });
    }
    return fail(400, 'photo');
  }
  if (op === 'supprimer') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM cloud_parts WHERE compte = ?1').bind(d.id),
      env.DB.prepare('DELETE FROM cloud_photos WHERE compte = ?1').bind(d.id),
      env.DB.prepare('DELETE FROM cloud_comptes WHERE id = ?1').bind(d.id),
    ]);
    return json({ ok: true });
  }
  return fail(404, 'inconnu');
}

// ---------------------------------------------------------------------------
// Pro : codes d'activation créés par l'admin (seule leur empreinte est gardée)
// ---------------------------------------------------------------------------

export const normPro = (c) => (typeof c === 'string' ? c.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

export async function proStatus(env, code) {
  const c = normPro(code);
  if (c.length < 12 || c.length > 32) return null;
  const hash = await sha256hex(`pro:${c}`);
  const row = await env.DB.prepare('SELECT label, expire, revoque FROM pro_codes WHERE hash = ?1').bind(hash).first();
  if (!row || row.revoque || (row.expire && Date.parse(row.expire) < Date.now())) return null;
  return { hash, expire: row.expire || null };
}

function newProCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map((x) => A[x % A.length]).join('');
  return `PRO-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

async function pro(path, request, env) {
  const d = await request.json().catch(() => null) || {};
  const op = path.slice('/api/pro/'.length);
  if (op === 'verifier') {
    const ip = request.headers.get('cf-connecting-ip') || '';
    if (!(await underLimit(env.DB, `proverif:${day()}:${await sha256hex(ip)}`, 30))) return fail(429, 'quota');
    const st = await proStatus(env, d.code);
    return json(st ? { ok: true, pro: true, expire: st.expire } : { ok: false, erreur: 'code' });
  }
  if (!(await isAdminKey(env, d.key))) return json({ ok: false, erreur: 'cle' }, 403);
  if (op === 'creer') {
    const code = newProCode();
    const months = Number.isInteger(d.mois) && d.mois > 0 && d.mois <= 36 ? d.mois : null;
    const exp = months ? new Date(Date.now() + months * 30.44 * 86400_000).toISOString() : null;
    const label = typeof d.label === 'string' ? d.label.slice(0, 60) : '';
    await env.DB.prepare('INSERT INTO pro_codes (hash, label, cree, expire, revoque) VALUES (?1, ?2, ?3, ?4, 0)').bind(await sha256hex(`pro:${normPro(code)}`), label, new Date().toISOString(), exp).run();
    return json({ ok: true, code, expire: exp });
  }
  if (op === 'liste') {
    const { results } = await env.DB.prepare('SELECT hash, label, cree, expire, revoque FROM pro_codes ORDER BY cree DESC LIMIT 200').all();
    return json({ ok: true, codes: results.map((r) => ({ id: r.hash.slice(0, 12), label: r.label, cree: r.cree, expire: r.expire, revoque: !!r.revoque })) });
  }
  if (op === 'revoquer') {
    const id = typeof d.id === 'string' && /^[a-f0-9]{12}$/.test(d.id) ? d.id : null;
    if (!id) return fail(400, 'id');
    await env.DB.prepare('UPDATE pro_codes SET revoque = 1 WHERE substr(hash, 1, 12) = ?1').bind(id).run();
    return json({ ok: true });
  }
  return fail(404, 'inconnu');
}

// ---------------------------------------------------------------------------
// Avis des utilisateurs : déposés depuis l'appli, publiés seulement après validation par l'admin
// ---------------------------------------------------------------------------

export function cleanReview(d) {
  if (!d) return null;
  const note = Number(d.note);
  const texte = typeof d.texte === 'string' ? d.texte.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim() : '';
  const nom = typeof d.nom === 'string' ? d.nom.replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 30) : '';
  if (!Number.isInteger(note) || note < 1 || note > 5 || texte.length < 10 || texte.length > 800) return null;
  return { note, texte, nom: nom || 'Un vendeur' };
}

export async function publishedReviews(env) {
  const { results } = await env.DB.prepare("SELECT id, note, texte, nom, cree FROM avis WHERE statut = 'publie' ORDER BY cree DESC LIMIT 200").all();
  return results;
}

async function avis(path, request, env, waitUntil) {
  const d = await request.json().catch(() => null) || {};
  const op = path.slice('/api/avis/'.length);
  if (op === 'envoyer') {
    const ip = request.headers.get('cf-connecting-ip') || '';
    if (!(await turnstileOk(env, d.token, ip))) return fail(403, 'verification');
    const r = cleanReview(d);
    if (!r) return fail(400, 'avis');
    if (!(await underLimit(env.DB, `avisu:${day()}:${await sha256hex(ip)}`, 3))) return fail(429, 'quota');
    await env.DB.prepare("INSERT INTO avis (id, note, texte, nom, cree, statut) VALUES (?1, ?2, ?3, ?4, ?5, 'attente')").bind(crypto.randomUUID(), r.note, r.texte, r.nom, new Date().toISOString()).run();
    // prévient l'admin par e-mail (script Google, même relais que les avis des testeurs)
    if (env.APPS_SCRIPT_URL) {
      const mail = fetch(env.APPS_SCRIPT_URL, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, redirect: 'follow',
        body: JSON.stringify({ app: 'cng-vinted', relais: env.RELAIS || '', title: `Nouvel avis ${'★'.repeat(r.note)} à relire`, message: `${r.nom} :\n\n${r.texte}\n\nPour le publier : https://cngapp.com/#/admin → Avis à relire`, contact: '' }) }).catch(() => null);
      if (waitUntil) waitUntil(mail); else await mail;
    }
    return json({ ok: true });
  }
  if (op === 'publics') return json({ ok: true, avis: await publishedReviews(env) });
  if (!(await isAdminKey(env, d.key))) return json({ ok: false, erreur: 'cle' }, 403);
  if (op === 'attente') {
    const { results } = await env.DB.prepare("SELECT id, note, texte, nom, cree, statut FROM avis WHERE statut != 'supprime' ORDER BY cree DESC LIMIT 200").all();
    return json({ ok: true, avis: results });
  }
  if (op === 'moderer') {
    const statut = ['publie', 'refuse', 'supprime', 'attente'].includes(d.statut) ? d.statut : null;
    if (!statut || typeof d.id !== 'string') return fail(400, 'avis');
    await env.DB.prepare('UPDATE avis SET statut = ?1 WHERE id = ?2').bind(statut, d.id).run();
    return json({ ok: true });
  }
  return fail(404, 'inconnu');
}

// ---------------------------------------------------------------------------

export async function onRequest({ request, env, waitUntil }) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (path === '/api/script' && request.method === 'GET') return script(request, env).catch(() => fail(500, 'serveur'));
  if (path === '/api/avis/publics' && request.method === 'GET') return json({ ok: true, avis: await publishedReviews(env).catch(() => []) });
  if (request.method !== 'POST') return fail(405, 'methode');
  // uniquement depuis le site lui-même (pas d'autres sites qui utiliseraient ces services)
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return fail(403, 'origine');
  try {
    switch (path) {
      case '/api/annonce': return await annonce(request, env);
      case '/api/retour': return await retour(request, env);
      case '/api/push/abonner': return await abonner(request, env);
      case '/api/push/desabonner': return await desabonner(request, env);
      case '/api/push/tendance': return await tendance(env);
      case '/api/script': return await script(request, env);
      case '/api/push/vente': return await pushVente(request, env);
      case '/api/push/bilan': return await pushBilan(request, env);
      default:
        if (path.startsWith('/api/cloud/')) return await cloud(path, request, env);
        if (path.startsWith('/api/pro/')) return await pro(path, request, env);
        if (path.startsWith('/api/avis/')) return await avis(path, request, env, waitUntil);
        return fail(404, 'inconnu');
    }
  } catch {
    return fail(500, 'serveur');
  }
}
