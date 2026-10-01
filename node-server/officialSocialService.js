"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { SEEDS, editorialUrl, catalogProjects, discoverAccounts } = require("./socialRegistry");
const { readSocialUrl } = require("./socialHttp");
const { topicOf, postTitle, telegramPage, telegramBotPost, xPage, discordPage, websitePage, socialUnlockSignals } = require("./socialPosts");
const DAY = 86400000, CATALOG_URL = "https://api.llama.fi/protocols";
const maxId = ids => ids.reduce((a, b) => !a || BigInt(b) > BigInt(a) ? b : a, null);
const minId = ids => ids.reduce((a, b) => !a || BigInt(b) < BigInt(a) ? b : a, null);

function discordConfig(raw) {
  try {
    const rows = JSON.parse(raw || "[]");
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 200).filter(r => r && typeof r.projectId === "string" && /^\d{10,25}$/.test(r.channelId) &&
      Array.isArray(r.authorIds) && r.authorIds.length > 0 && r.authorIds.every(id => typeof id === "string" && /^\d{10,25}$/.test(id)));
  } catch (_) { return []; }
}

function createOfficialSocialService({ filePath = path.join(__dirname, "data", "official-social.json"),
  read = readSocialUrl, now = Date.now, seeds = SEEDS, catalog = true, verifyBatch = 16, pollBatch = 24,
  xToken = process.env.NEWS_X_BEARER_TOKEN || "", discordToken = process.env.NEWS_DISCORD_BOT_TOKEN || "",
  discordChannels = discordConfig(process.env.NEWS_DISCORD_CHANNELS), onChange = () => {} } = {}) {
  let state = { version: 1, projects: {}, sources: {}, posts: [], catalog: { status: "pending" }, updatedAt: null };
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (saved.version === 1 && saved.projects && saved.sources && Array.isArray(saved.posts)) state = saved;
  } catch (_) {}
  state.posts = state.posts.filter(p => p && typeof p.text === "string" && topicOf(p.text))
    .map(p => ({ ...p, topic: topicOf(p.text), title: postTitle(p.text) }));
  for (const [id, s] of Object.entries(state.sources)) if (s.platform === "website" && !editorialUrl(s.url)) delete state.sources[id];
  // Reconcile canonical seeds after website migrations without inheriting an old proof.
  for (const p of seeds) {
    const previous = state.projects[p.id];
    state.projects[p.id] = { ...(previous?.website === p.website ? previous : {}), ...p };
  }
  let stopped = false, controller = new AbortController(), timer = null, saveTimer = null, running = null, saving = Promise.resolve();
  const platformRetry = new Map();
  const listeners = new Set();
  let cached = null, cachedAt = 0;
  const validProof = source => Number.isFinite(source.verifiedAt) && source.verifiedAt <= now() + 60000 &&
    source.verifiedAt > now() - 7 * DAY && state.projects[source.projectId]?.website === source.evidenceUrl &&
    state.projects[source.projectId]?.checkedAt >= source.verifiedAt &&
    (source.platform !== "x" || source.account === state.projects[source.projectId]?.twitter?.toLowerCase());
  function changed() { cached = null; if (!stopped) { onChange(); for (const fn of listeners) { try { fn(); } catch (_) {} } } }
  function save() {
    const body = JSON.stringify(state);
    saving = saving.then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(`${filePath}.tmp`, body);
      await fs.promises.rename(`${filePath}.tmp`, filePath);
      state.persistenceError = false;
    }).catch(() => { state.persistenceError = true; cached = null; });
    return saving;
  }
  async function get(url, options) { return read(url, { signal: controller.signal, ...options }); }
  async function json(url, options) { return JSON.parse(await get(url, options)); }
  async function pool(rows, worker, concurrency = 3) {
    const queue = [...rows];
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length && !stopped) await worker(queue.shift());
    }));
  }

  async function refreshCatalog() {
    if (!catalog || (state.catalog.retryAt || 0) > now()) return;
    try {
      const discovered = catalogProjects(await json(CATALOG_URL, { maxBytes: 24_000_000 }));
      if (stopped) return;
      const candidates = discovered.slice(0, 10000);
      for (const p of candidates) {
        const previous = state.projects[p.id];
        state.projects[p.id] = { ...(previous?.website === p.website && previous?.twitter === p.twitter ? previous : {}), ...p };
      }
      const retained = new Set([...seeds, ...candidates].map(p => p.id));
      for (const id of Object.keys(state.projects)) if (!retained.has(id)) delete state.projects[id];
      for (const [id, s] of Object.entries(state.sources)) if (!state.projects[s.projectId]) delete state.sources[id];
      state.catalog = { status: "ok", checkedAt: now(), candidates: discovered.length, partial: discovered.length > candidates.length, retryAt: now() + DAY };
    } catch (_) { state.catalog = { ...state.catalog, status: "error", checkedAt: now(), retryAt: now() + 30 * 60000 }; }
  }

  async function verify(project) {
    try {
      const html = await get(project.website);
      if (stopped) return;
      if (!/<(?:html|body|a)\b/i.test(html) || /<title[^>]*>\s*(?:Just a moment|Access denied|Attention Required)/i.test(html)) throw new Error("Website challenge");
      const accounts = discoverAccounts(html, project, now());
      const retained = new Set();
      for (const account of accounts) {
        const id = `${project.id}:${account.platform}:${account.account}`;
        retained.add(id);
        const previous = state.sources[id] || {};
        state.sources[id] = { ...previous, ...account, id, status: previous.status || "pending" };
        if (account.platform === "x" && !xToken) state.sources[id].status = "requires_api_token";
        if (account.platform === "discord" && (!discordToken || !discordChannels.some(c => c.projectId === project.id))) state.sources[id].status = "requires_bot_access";
      }
      for (const [id, s] of Object.entries(state.sources)) if (s.projectId === project.id && !retained.has(id)) delete state.sources[id];
      Object.assign(project, { status: accounts.length ? "verified" : "no_verified_links", checkedAt: now(), retryAt: now() + DAY });
    } catch (_) {
      Object.assign(project, { status: "website_unavailable", checkedAt: now(), retryAt: now() + 6 * 3600000 });
    }
  }

  function retainPosts(rows, source, fetchedIds = []) {
    const map = new Map(state.posts.map(p => [p.id, p]));
    // A fetched post that was edited into an irrelevant/forwarded message must
    // disappear from this curated feed, even when its URL has not changed.
    if (source) for (const id of fetchedIds) map.delete(`${source.platform}:${source.account}:${id}`);
    for (const row of rows) map.set(row.id, row);
    const counts = new Map(); let omitted = 0;
    state.posts = [...map.values()].filter(p => p.publishedAt > now() - 7 * DAY && state.sources[p.sourceId] && validProof(state.sources[p.sourceId]))
      .sort((a, b) => b.publishedAt - a.publishedAt).filter(p => {
        const count = (counts.get(p.sourceId) || 0) + 1; counts.set(p.sourceId, count);
        if (count > 100) { omitted++; return false; } return true;
      });
    if (state.posts.length > 2000) omitted += state.posts.length - 2000;
    state.posts = state.posts.slice(0, 2000);
    state.retentionLimitedAt = omitted ? now() : state.retentionLimitedAt || null;
  }

  async function prepare(source) {
    if (source.platform === "x") {
      if (!xToken) { source.status = "requires_api_token"; return false; }
      // Re-resolve identities regularly; an account rename must not follow the old owner.
      if (!source.userId || source.identityAt < now() - DAY) {
        const data = await json(`https://api.x.com/2/users/by/username/${source.account}`, { headers: { Authorization: `Bearer ${xToken}` } });
        if (!/^\d+$/.test(data.data?.id || "") || data.data.username?.toLowerCase() !== source.account) throw new Error("X identity mismatch");
        if (source.userId && source.userId !== data.data.id) { delete source.scan; delete source.cursor; }
        source.userId = data.data.id; source.identityAt = now();
      }
    }
    if (source.platform === "discord") {
      const config = discordChannels.find(c => c.projectId === source.projectId);
      if (!discordToken || !config) { source.status = "requires_bot_access"; return false; }
      if (!source.guildId || source.identityAt < now() - DAY || source.channelId !== config.channelId) {
        const invite = await json(`https://discord.com/api/v10/invites/${source.account}`);
        const channel = await json(`https://discord.com/api/v10/channels/${config.channelId}`, { headers: { Authorization: `Bot ${discordToken}` } });
        if (!invite.guild?.id || channel.guild_id !== invite.guild.id || channel.id !== config.channelId || channel.type !== 5) throw new Error("Discord announcement channel mismatch");
        if (source.channelId !== config.channelId) { delete source.scan; delete source.cursor; }
        source.guildId = channel.guild_id; source.channelId = config.channelId; source.identityAt = now();
      }
      source.authorIds = config.authorIds;
    }
    return true;
  }

  async function page(source, next) {
    if (source.platform === "telegram") return telegramPage(await get(`https://t.me/s/${source.account}${next ? `?before=${next}` : ""}`), source, now());
    if (source.platform === "website") return websitePage(await get(source.url), source, now());
    if (source.platform === "x") {
      const url = new URL(`https://api.x.com/2/users/${source.userId}/tweets`);
      url.searchParams.set("max_results", "100"); url.searchParams.set("tweet.fields", "created_at,author_id,referenced_tweets,note_tweet");
      url.searchParams.set("exclude", "retweets,replies");
      if (source.scan.since) url.searchParams.set("since_id", source.scan.since);
      if (next) url.searchParams.set("pagination_token", next);
      return xPage(await json(url.href, { headers: { Authorization: `Bearer ${xToken}` } }), source, now());
    }
    const url = `https://discord.com/api/v10/channels/${source.channelId}/messages?limit=100${next ? `&before=${next}` : ""}`;
    return discordPage(await json(url, { headers: { Authorization: `Bot ${discordToken}` } }), source, now());
  }

  async function poll(source) {
    if (!validProof(source)) { source.status = "verification_expired"; return; }
    if ((platformRetry.get(source.platform) || 0) > now()) { source.status = "rate_limited"; return; }
    try {
      if (!await prepare(source) || stopped) return;
      source.scan ||= { since: source.cursor || null, head: null, next: null, pages: 0 };
      // Continuation persists between bounded batches; do not advance the cursor
      // to the newest post while an older page is still missing after an outage.
      for (let n = 0; n < 3 && !stopped; n++) {
        const batch = await page(source, source.scan.next);
        if (stopped) return;
        retainPosts(batch.rows, source, batch.ids);
        source.lastSuccessAt = now(); source.checkedAt = now();
        source.latestAt = Math.max(source.latestAt || 0, ...batch.rows.map(r => r.publishedAt)) || null;
        source.scan.head = maxId([source.scan.head, ...batch.ids].filter(Boolean)); source.scan.pages++;
        const crossed = source.scan.since && minId(batch.ids) && BigInt(minId(batch.ids)) <= BigInt(source.scan.since);
        const initialLimit = !source.scan.since && source.scan.pages >= 3;
        if (!batch.next || crossed || initialLimit || source.platform === "website") {
          source.historyLimited = source.historyLimited || Boolean(initialLimit && batch.next && !crossed) || source.platform === "website";
          source.cursor = source.scan.head || source.cursor; delete source.scan;
          source.status = batch.accessUnknown ? "empty_or_restricted" : batch.rows.length || source.latestAt ? "ok" : "no_relevant_posts";
          break;
        }
        if (batch.next === source.scan.next) throw new Error("Repeated source page");
        source.scan.next = batch.next; source.status = "catching_up";
      }
      source.failures = 0; source.retryAt = now() + (source.scan ? 30000 : 120000);
      delete source.error;
    } catch (error) {
      if (stopped) return;
      source.failures = Math.min((source.failures || 0) + 1, 8);
      const delay = Math.max(30000 * 2 ** source.failures, Math.min(error.retryAfterMs || 0, DAY));
      source.status = error.status === 429 ? "rate_limited" : [401, 402, 403].includes(error.status) ? "access_denied" : "error";
      source.error = String(error.message).slice(0, 140); source.checkedAt = now(); source.retryAt = now() + Math.min(delay, DAY);
      if (error.status === 429 || [401, 402].includes(error.status)) platformRetry.set(source.platform, source.retryAt);
      // X pagination tokens can expire; retry from the last completed cursor.
      if (source.platform === "x" && error.status === 400) delete source.scan;
    }
  }

  function refresh() {
    if (running || stopped) return running || Promise.resolve();
    running = (async () => {
      await refreshCatalog();
      await pool(Object.values(state.projects).filter(p => !(p.retryAt > now())).sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0)).slice(0, verifyBatch), verify);
      await pool(Object.values(state.sources).filter(s => !(s.retryAt > now()) &&
        (s.platform !== "x" || xToken) && (s.platform !== "discord" || discordToken && discordChannels.some(c => c.projectId === s.projectId)))
        .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0)).slice(0, pollBatch), async s => {
        await poll(s);
        // Unconfigured accounts must not monopolize the round-robin queue.
        if (["requires_api_token", "requires_bot_access", "verification_expired"].includes(s.status)) { s.checkedAt = now(); s.retryAt = now() + 3600000; }
      });
      if (stopped) return;
      retainPosts([]); state.updatedAt = now(); changed(); await save();
    })().finally(() => { running = null; });
    return running;
  }

  function snapshot() {
    if (cached && now() - cachedAt < 1000) return cached;
    const availability = s => !validProof(s) ? "verification_expired"
      : s.platform === "x" && !xToken ? "requires_api_token"
      : s.platform === "discord" && (!discordToken || !discordChannels.some(c => c.projectId === s.projectId)) ? "requires_bot_access"
      : ["ok", "no_relevant_posts"].includes(s.status) && s.lastSuccessAt < now() - 10 * 60000 ? "stale" : s.status;
    const sources = Object.values(state.sources).map(({ id, platform, project, projectId, account, url, evidenceUrl, verifiedAt,
      status, checkedAt, latestAt, lastSuccessAt, retryAt, historyLimited, error }) => ({ id, platform, project, projectId, account, url,
      evidenceUrl, verifiedAt, status: availability(state.sources[id]), checkedAt, latestAt, lastSuccessAt, retryAt, historyLimited, error }));
    const projects = Object.values(state.projects);
    const posts = state.posts.filter(p => p.publishedAt > now() - 7 * DAY && state.sources[p.sourceId] && validProof(state.sources[p.sourceId]));
    cachedAt = now();
    return cached = { posts, sources, updatedAt: state.updatedAt, catalog: state.catalog, persistenceError: !!state.persistenceError,
      coverage: { candidates: projects.length, checked: projects.filter(p => p.checkedAt).length,
        verifiedProjects: new Set(sources.filter(s => s.status !== "verification_expired").map(s => s.projectId)).size,
        reading: sources.filter(s => ["ok", "no_relevant_posts", "catching_up"].includes(s.status) && s.lastSuccessAt > now() - 10 * 60000).length,
        unavailableWebsites: projects.filter(p => p.status === "website_unavailable").length },
      platforms: { x: xToken ? "configured" : "requires_api_token", discord: discordToken && discordChannels.length ? "configured" : "requires_bot_access", telegram: "public_preview", website: "public_feed" },
      retention: { days: 7, maxPosts: 2000, maxPerSource: 100, limitedAt: state.retentionLimitedAt || null },
      signals: socialUnlockSignals(posts) };
  }
  return { refresh, snapshot,
    ingestTelegram(message) {
      if (stopped || message?.chat?.type !== "channel") return;
      const source = Object.values(state.sources).find(s => s.platform === "telegram" && s.account === message.chat.username?.toLowerCase() && validProof(s));
      if (!source) return;
      const row = telegramBotPost(message, source, now());
      retainPosts(row ? [row] : [], source, /^\d+$/.test(String(message.message_id)) ? [String(message.message_id)] : []);
      if (row) { source.lastSuccessAt = now(); source.latestAt = row.publishedAt; source.status = "ok"; }
      state.updatedAt = now(); changed();
      if (!saveTimer) { saveTimer = setTimeout(() => { saveTimer = null; void save(); }, 250); saveTimer.unref?.(); }
    },
    query({ search = "", platform = "all", topic = "all", page = 0, sourcePage = 0 } = {}) {
      const { posts, sources, signals, ...meta } = snapshot();
      const q = String(search).slice(0, 100).toLowerCase();
      const matches = row => (platform === "all" || row.platform === platform) && (!q || `${row.project} ${row.symbol || ""} ${row.account} ${row.text || ""}`.toLowerCase().includes(q));
      const filtered = posts.filter(row => matches(row) && (topic === "all" || row.topic === topic));
      const accounts = sources.filter(matches).sort((a, b) => (b.lastSuccessAt || 0) - (a.lastSuccessAt || 0) || a.project.localeCompare(b.project));
      const boundedPage = (n, total, size) => Math.max(0, Math.min(Math.floor(Number(n)) || 0, Math.max(0, Math.ceil(total / size) - 1)));
      page = boundedPage(page, filtered.length, 40); sourcePage = boundedPage(sourcePage, accounts.length, 50);
      return { ...meta, posts: filtered.slice(page * 40, (page + 1) * 40), sources: accounts.slice(sourcePage * 50, (sourcePage + 1) * 50),
        page, sourcePage, postTotal: filtered.length, sourceTotal: accounts.length };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() { if (timer) return; stopped = false; controller = new AbortController(); void refresh().catch(() => {});
      timer = setInterval(() => { void refresh().catch(() => {}); }, 30000); timer.unref?.(); },
    stop() { stopped = true; controller.abort(); if (timer) clearInterval(timer); timer = null; },
    async flush() { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; await running; return save(); }
  };
}
module.exports = { createOfficialSocialService, discordConfig };
