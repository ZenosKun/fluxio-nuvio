/**
 * Fluxio v3.1.7 — multi-sources FR pour Nuvio
 * Built: 2026-10-28T09:52:06.440Z
 */
var __provider = (() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve2, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve2(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };

  // src/utils/settings.js
  function getSettingsRaw() {
    try {
      if (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS && typeof globalThis.SCRAPER_SETTINGS === "object") {
        return globalThis.SCRAPER_SETTINGS;
      }
    } catch (e) {
    }
    return {};
  }
  function boolOr(value, def) {
    if (value === void 0 || value === null || value === "") return def;
    return String(value).toLowerCase() !== "false";
  }
  function readConfig() {
    const s = getSettingsRaw();
    let serverUrl = String(s.serverUrl || "").trim();
    if (serverUrl && !/^https?:\/\//i.test(serverUrl)) {
      serverUrl = "http://" + serverUrl;
    }
    serverUrl = serverUrl.replace(/\/+$/, "");
    const languageRaw = String(s.language || "vf").toLowerCase();
    const language = languageRaw === "all" || languageRaw === "" ? "vf" : languageRaw;
    const fallbackLangs = languageRaw === "all" ? ["vf", "vostfr", "vo"] : buildLangChain(language);
    const allowOtherLang = boolOr(s.allowOtherLang, true);
    const detectAnime = boolOr(s.detectAnime, true);
    const earlyExit = boolOr(s.earlyExit, true);
    const verifyLinks = boolOr(s.verifyLinks, true);
    const selfTest = boolOr(s.selfTest, true);
    const softSec = parseInt(String(s.softMs || ""), 10);
    const softMs = Number.isFinite(softSec) && softSec >= 3e3 && softSec <= 15e3 ? softSec : 5e3;
    const useTranscode = s.useTranscode === void 0 || s.useTranscode === null || s.useTranscode === "" ? false : String(s.useTranscode).toLowerCase() === "true";
    const sources = String(s.sources || s.sites || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).join(",");
    const timeoutSec = parseInt(String(s.timeoutSec || "10"), 10);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec >= 8 && timeoutSec <= 90 ? timeoutSec * 1e3 : 1e4;
    const budgetSec = parseInt(String(s.budgetSec || ""), 10);
    const budgetMs = Number.isFinite(budgetSec) && budgetSec >= 10 && budgetSec <= 30 ? budgetSec * 1e3 : typeof setTimeout === "function" ? 25e3 : 18e3;
    return {
      serverUrl,
      language,
      fallbackLangs,
      allowOtherLang,
      detectAnime,
      earlyExit,
      verifyLinks,
      selfTest,
      softMs,
      useTranscode,
      sources,
      timeoutMs,
      budgetMs
    };
  }
  function buildLangChain(preferred) {
    const rest = LANGUAGES.filter((l) => l !== preferred);
    return [preferred, ...rest];
  }
  var LANGUAGES;
  var init_settings = __esm({
    "src/utils/settings.js"() {
      LANGUAGES = ["vf", "vostfr", "vo"];
    }
  });

  // src/utils/http.js
  function makeController(externalSignal) {
    try {
      if (typeof AbortController === "function") {
        const controller = new AbortController();
        if (externalSignal && !externalSignal.aborted && typeof externalSignal.addEventListener === "function") {
          externalSignal.addEventListener("abort", function() {
            try {
              controller.abort();
            } catch (e) {
            }
          });
        }
        return controller;
      }
    } catch (e) {
    }
    return null;
  }
  function setHttpDeadline(ts) {
    govDeadline = ts > 0 ? ts : 0;
  }
  function govHost(url) {
    const m = /^https?:\/\/([^\/?#]+)/i.exec(String(url));
    return m ? m[1].toLowerCase() : "";
  }
  function govGate(url, timeout) {
    const host = govHost(url);
    const until = govDead[host];
    if (until && Date.now() < until) {
      throw new HttpError("h\xF4te injoignable (disjoncteur) : " + host, 0, url);
    }
    if (govDeadline) {
      const remaining = govDeadline - Date.now();
      if (remaining < GOV_MIN_SLICE_MS) throw new HttpError("budget \xE9puis\xE9 avant : " + url, 0, url);
      return Math.min(timeout, remaining);
    }
    return timeout;
  }
  function govNoteFailure(url, err) {
    if (err && err.status !== void 0 && err.status !== 0) return;
    if (err && /disjoncteur|budget épuisé/.test(String(err.message))) return;
    govDead[govHost(url)] = Date.now() + GOV_DEAD_MS;
  }
  function raceFetch(url, fetchOptions, timeout, action) {
    return __async(this, null, function* () {
      const clamped = govGate(url, timeout);
      try {
        return yield raceFetchInner(url, __spreadProps(__spreadValues({}, fetchOptions), { timeout: clamped }), clamped, action);
      } catch (err) {
        govNoteFailure(url, err);
        throw err;
      }
    });
  }
  function raceFetchInner(url, fetchOptions, timeout, action) {
    return __async(this, null, function* () {
      const noBody = fetchOptions._noBody === true;
      const rest = __spreadValues({}, fetchOptions);
      delete rest._noBody;
      const controller = makeController(rest.signal);
      const opts = __spreadProps(__spreadValues({}, rest), { signal: controller ? controller.signal : void 0 });
      const work = (() => __async(this, null, function* () {
        const res = yield fetch(url, opts);
        if (!res || typeof res.status !== "number") {
          throw new HttpError("r\xE9ponse invalide du runtime fetch", 0, url);
        }
        let text = "";
        if (!noBody) {
          try {
            text = yield res.text();
          } catch (e) {
            text = "";
          }
        }
        let contentType = "";
        try {
          const h = res.headers;
          if (h) {
            if (typeof h.get === "function") contentType = String(h.get("content-type") || "");
            else if (h["content-type"]) contentType = String(h["content-type"]);
          }
        } catch (e) {
        }
        let finalUrl = url;
        try {
          if (res.url && typeof res.url === "string") finalUrl = res.url;
        } catch (e) {
        }
        return { res, text, finalUrl, contentType };
      }))();
      if (typeof setTimeout !== "function") {
        return action(yield work);
      }
      let timer = null;
      try {
        const won = yield Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(function() {
              try {
                if (controller) controller.abort();
              } catch (e) {
              }
              reject(new HttpError("timeout r\xE9seau (" + timeout + " ms) : " + url, 0, url));
            }, timeout);
          })
        ]);
        return action(won);
      } finally {
        try {
          clearTimeout(timer);
        } catch (e) {
        }
      }
    });
  }
  function fetchText(_0) {
    return __async(this, arguments, function* (url, options = {}) {
      const timeout = options.timeout || 2e4;
      let out;
      try {
        out = yield raceFetch(
          url,
          {
            method: options.method || "GET",
            headers: __spreadValues(__spreadValues({}, DEFAULT_HEADERS), options.headers || {}),
            body: options.body !== void 0 ? options.body : void 0,
            timeout
          },
          timeout,
          (won) => won
        );
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError("r\xE9seau injoignable: " + (err && err.message ? err.message : String(err)), 0, url);
      }
      if (out.res.status < 200 || out.res.status >= 300) {
        const detail = out.text ? out.text.slice(0, 200) : "";
        throw new HttpError("HTTP " + out.res.status + (detail ? " \u2014 " + detail : ""), out.res.status, url);
      }
      return {
        text: out.text,
        status: out.res.status,
        finalUrl: out.finalUrl,
        contentType: out.contentType || ""
      };
    });
  }
  function fetchStatus(_0) {
    return __async(this, arguments, function* (url, options = {}) {
      const timeout = options.timeout || 2e4;
      let out;
      try {
        out = yield raceFetch(
          url,
          {
            method: options.method || "GET",
            headers: __spreadValues(__spreadValues({}, DEFAULT_HEADERS), options.headers || {}),
            body: options.body !== void 0 ? options.body : void 0,
            timeout,
            _noBody: options.noBody === true
          },
          timeout,
          (won) => won
        );
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError("r\xE9seau injoignable: " + (err && err.message ? err.message : String(err)), 0, url);
      }
      return {
        status: out.res.status,
        contentType: out.contentType || "",
        finalUrl: out.finalUrl
      };
    });
  }
  function fetchJson(_0) {
    return __async(this, arguments, function* (url, options = {}) {
      const timeout = options.timeout || 2e4;
      let out;
      try {
        out = yield raceFetch(
          url,
          {
            method: options.method || "GET",
            headers: __spreadValues(__spreadValues({}, DEFAULT_HEADERS), options.headers || {}),
            body: options.body !== void 0 ? JSON.stringify(options.body) : void 0,
            timeout
          },
          timeout,
          (won) => won
        );
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError("r\xE9seau injoignable: " + (err && err.message ? err.message : String(err)), 0, url);
      }
      if (out.res.status < 200 || out.res.status >= 300) {
        const detail = out.text ? out.text.slice(0, 200) : "";
        throw new HttpError("HTTP " + out.res.status + (detail ? " \u2014 " + detail : ""), out.res.status, url);
      }
      try {
        return JSON.parse(out.text);
      } catch (e) {
        throw new HttpError("JSON invalide (" + out.text.slice(0, 80) + "\u2026)", out.res.status, url);
      }
    });
  }
  function fetchJsonSafe(_0) {
    return __async(this, arguments, function* (url, options = {}) {
      try {
        return yield fetchJson(url, options);
      } catch (err) {
        if (err instanceof HttpError && err.status >= 400) return null;
        throw err;
      }
    });
  }
  function resolveUrl(base, rel) {
    const r = String(rel || "").trim();
    if (!r) return base || "";
    if (/^https?:\/\//i.test(r)) return r;
    try {
      return new URL(r, base).href;
    } catch (e) {
    }
    if (r.startsWith("//")) return "https:" + r;
    const b = String(base || "");
    if (!b) return r;
    if (r.startsWith("/")) return b.split("/").slice(0, 3).join("/") + r;
    return b.replace(/\/[^/]*$/, "/") + r;
  }
  function createTtlCache(maxEntries) {
    const store = /* @__PURE__ */ new Map();
    const limit = maxEntries || 40;
    function prune() {
      if (store.size <= limit) return;
      const now = Date.now();
      for (const [k, v] of store) {
        if (v.expires <= now) store.delete(k);
        if (store.size <= limit) break;
      }
      while (store.size > limit) {
        const first = store.keys().next();
        if (first.done) break;
        store.delete(first.value);
      }
    }
    return {
      get(key) {
        const hit = store.get(key);
        if (!hit) return null;
        if (hit.expires <= Date.now()) {
          store.delete(key);
          return null;
        }
        return hit.value;
      },
      set(key, value, ttlMs) {
        store.set(key, { value, expires: Date.now() + ttlMs });
        prune();
      },
      clear() {
        store.clear();
      }
    };
  }
  var DEFAULT_HEADERS, HttpError, govDeadline, govDead, GOV_DEAD_MS, GOV_MIN_SLICE_MS;
  var init_http = __esm({
    "src/utils/http.js"() {
      DEFAULT_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*"
      };
      HttpError = class extends Error {
        constructor(message, status, url) {
          super(message);
          this.name = "HttpError";
          this.status = status || 0;
          this.url = url || "";
        }
      };
      govDeadline = 0;
      govDead = {};
      GOV_DEAD_MS = 12e4;
      GOV_MIN_SLICE_MS = 1500;
    }
  });

  // src/core/verify.js
  function looksHtml(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    const head = t.slice(0, 400);
    return t.charAt(0) === "<" || /<html[\s>]/i.test(head) || /<!doctype\s+html/i.test(head);
  }
  function nextHlsUri(text, tag) {
    const re = new RegExp("^" + String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const lines = String(text || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i].trim())) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l || l.charAt(0) === "#") continue;
        return l;
      }
    }
    return "";
  }
  function neutralErr(err) {
    return /budget épuisé|disjoncteur/.test(String(err && err.message || ""));
  }
  function probeOne(st, timeout, deep) {
    return __async(this, null, function* () {
      const isHls = /\.m3u8(\?|$)/i.test(String(st.url || ""));
      const headers = Object.assign({ Accept: "*/*" }, st.headers || {});
      const deadline = Date.now() + Math.max(800, timeout);
      const left = () => Math.max(400, deadline - Date.now());
      const statusOf = (err) => err && err.status ? err.status : 0;
      if (!isHls) {
        try {
          const res2 = yield fetchText(st.url, { method: "HEAD", headers, timeout });
          if (looksHtml(res2.text) || /text\/html/i.test(res2.contentType || "")) {
            return { ok: false, why: "redirection vers page HTML" };
          }
          return { ok: true };
        } catch (err) {
          const status = statusOf(err);
          if (status === 405 || status === 501) return { ok: null, why: "HEAD refus\xE9" };
          return { ok: false, why: status ? "HTTP " + status : "injoignable" };
        }
      }
      let res;
      try {
        res = yield fetchText(st.url, { method: "GET", headers, timeout: left() });
      } catch (err) {
        if (neutralErr(err)) return { ok: null, why: "sonde interrompue" };
        const status = statusOf(err);
        return { ok: false, why: status ? "HTTP " + status : "playlist injoignable" };
      }
      let text = res.text || "";
      if (looksHtml(text)) return { ok: false, why: "redirection vers page HTML" };
      let base = res.finalUrl || st.url;
      const variant = nextHlsUri(text, "#EXT-X-STREAM-INF");
      if (variant) {
        const vUrl = resolveUrl(base, variant);
        let v;
        try {
          v = yield fetchText(vUrl, { method: "GET", headers, timeout: left() });
        } catch (err) {
          if (neutralErr(err)) return { ok: null, why: "sonde interrompue" };
          const status = statusOf(err);
          if (status >= 400) return { ok: false, why: "HTTP " + status + " (variante)" };
          return { ok: null, why: "variante non test\xE9e" };
        }
        text = v.text || "";
        if (looksHtml(text)) return { ok: false, why: "variante \u2192 page HTML" };
        base = v.finalUrl || vUrl;
      }
      const seg = nextHlsUri(text, "#EXTINF");
      if (!seg || !deep) return { ok: true };
      const segUrl = resolveUrl(base, seg);
      try {
        const sres = yield fetchStatus(segUrl, {
          method: "GET",
          headers: Object.assign({}, headers, { Range: SEGMENT_RANGE }),
          timeout: left(),
          noBody: true
        });
        if (sres.status >= 400) return { ok: false, why: "HTTP " + sres.status + " (segment)" };
        if (/text\/html/i.test(sres.contentType || "")) return { ok: false, why: "segment \u2192 page HTML" };
        return { ok: true };
      } catch (err) {
        if (neutralErr(err)) return { ok: null, why: "sonde interrompue" };
        const status = statusOf(err);
        if (!status && Date.now() >= deadline) return { ok: null, why: "segment non test\xE9" };
        return { ok: false, why: status ? "HTTP " + status + " (segment)" : "segment injoignable" };
      }
    });
  }
  function verifyStreams(streams, opts) {
    const list = (streams || []).slice(0, PROBE_MAX);
    const budget = Math.min(PROBE_BUDGET_MS, (opts && opts.remainingMs) - MIN_REMAINING_MS);
    if (!list.length || !(budget >= 2e3)) return Promise.resolve(streams);
    const perProbe = Math.min(PROBE_MS, budget);
    const deadline = Date.now() + budget;
    let results;
    if (typeof setTimeout === "function") {
      results = Promise.all(list.map(function(st, i) {
        return probeOne(st, perProbe, i < DEEP_MAX);
      }));
    } else {
      results = list.reduce(function(chain, st, i) {
        return chain.then(function(acc) {
          if (Date.now() + MIN_REMAINING_MS > deadline) {
            acc.push({ ok: null, why: "non test\xE9" });
            return acc;
          }
          return probeOne(st, perProbe, i < DEEP_MAX).then(function(r) {
            acc.push(r);
            return acc;
          });
        });
      }, Promise.resolve([]));
    }
    return results.then(function(res) {
      const good = [];
      const dead = [];
      (streams || []).forEach(function(st, i) {
        const r = i < res.length ? res[i] : { ok: null };
        console.log(
          "[verify] " + (r.ok === true ? "OK " : r.ok === false ? "KO " : "?  ") + st.name + " \xB7 " + (r.why || "") + " \xB7 " + st.url
        );
        if (r.ok === false) {
          const copy = Object.assign({}, st);
          if (!/ ⚠$/.test(String(copy.name || ""))) copy.name = String(copy.name || "Fluxio") + " \u26A0";
          dead.push(copy);
        } else {
          good.push(st);
        }
      });
      return good.concat(dead);
    });
  }
  var PROBE_MS, PROBE_MAX, PROBE_BUDGET_MS, MIN_REMAINING_MS, DEEP_MAX, SEGMENT_RANGE;
  var init_verify = __esm({
    "src/core/verify.js"() {
      init_http();
      PROBE_MS = 4e3;
      PROBE_MAX = 6;
      PROBE_BUDGET_MS = 8e3;
      MIN_REMAINING_MS = 1500;
      DEEP_MAX = 3;
      SEGMENT_RANGE = "bytes=0-16383";
    }
  });

  // src/meta/tmdb.js
  function tmdbKey() {
    try {
      const s = getSettingsRaw();
      const k = String(s && s.tmdbKey || "").trim();
      if (k) return k;
    } catch (e) {
    }
    return TMDB_FALLBACK_KEY;
  }
  function getTmdbMeta(_0, _1) {
    return __async(this, arguments, function* (tmdbId, mediaType, opts = {}) {
      const type = mediaType === "tv" ? "tv" : "movie";
      const key = `tmdb:${type}:${tmdbId}`;
      const cached = metaCache.get(key);
      if (cached) return cached;
      const meta = { titles: [], year: 0, originalLanguage: "", isAnimeHint: false };
      const timeout = opts.timeout || 12e3;
      const url = `${TMDB_BASE}/${type}/${encodeURIComponent(String(tmdbId))}?api_key=${tmdbKey()}&language=fr-FR`;
      let details = null;
      try {
        details = yield fetchJson(url, { timeout, signal: opts.signal });
      } catch (err) {
        try {
          details = yield fetchJson(
            `${TMDB_BASE}/${type}/${encodeURIComponent(String(tmdbId))}?api_key=${tmdbKey()}`,
            { timeout, signal: opts.signal }
          );
        } catch (err2) {
          console.error("[v3] TMDB injoignable: " + (err2 && err2.message ? err2.message : err2));
          throw err2;
        }
      }
      if (!details) throw new Error("TMDB: aucune donn\xE9e pour " + tmdbId);
      const frTitle = String(details.title || details.name || "").trim();
      const originalTitle = String(details.original_title || details.original_name || "").trim();
      const date = String(details.release_date || details.first_air_date || "");
      const year = parseInt(date.slice(0, 4), 10);
      meta.year = Number.isFinite(year) ? year : 0;
      meta.originalLanguage = String(details.original_language || "");
      {
        const isAnim = Array.isArray(details.genres) && details.genres.some((g) => g && g.id === 16);
        meta.isAnimeHint = isAnim && meta.originalLanguage === "ja";
      }
      const titles = [];
      pushUnique(titles, frTitle);
      pushUnique(titles, originalTitle);
      try {
        const alt = yield fetchJson(
          `${TMDB_BASE}/${type}/${encodeURIComponent(String(tmdbId))}/alternative_titles?api_key=${tmdbKey()}`,
          { timeout, signal: opts.signal }
        );
        const list = alt && alt.results || alt && alt.titles || [];
        for (const t of list.slice(0, 12)) {
          const iso = String(t.iso_3166_1 || "").toLowerCase();
          const title = String(t.title || "").trim();
          if (title && (iso === "fr" || titles.length < 2)) pushUnique(titles, title);
        }
      } catch (e) {
      }
      meta.titles = titles.filter(Boolean);
      metaCache.set(key, meta, META_TTL_MS);
      return meta;
    });
  }
  function getImdbId(_0, _1) {
    return __async(this, arguments, function* (tmdbId, mediaType, opts = {}) {
      const type = mediaType === "tv" ? "tv" : "movie";
      const key = `imdb:${type}:${tmdbId}`;
      const cached = imdbCache.get(key);
      if (cached !== null) return cached;
      const id = String(tmdbId || "");
      if (!id || !/^\d+$/.test(id)) {
        imdbCache.set(key, "", IMDB_TTL_MS);
        return "";
      }
      try {
        const data = yield fetchJson(
          `${TMDB_BASE}/${type}/${id}/external_ids?api_key=${tmdbKey()}`,
          { timeout: opts.timeout || 12e3, signal: opts.signal }
        );
        const imdb = data && typeof data.imdb_id === "string" && /^tt\d+$/.test(data.imdb_id) ? data.imdb_id : "";
        imdbCache.set(key, imdb, IMDB_TTL_MS);
        return imdb;
      } catch (e) {
        imdbCache.set(key, "", IMDB_TTL_MS);
        return "";
      }
    });
  }
  function pushUnique(arr, value) {
    const v = String(value || "").trim();
    if (v && arr.map((x) => x.toLowerCase()).indexOf(v.toLowerCase()) === -1) arr.push(v);
  }
  var TMDB_BASE, TMDB_FALLBACK_KEY, META_TTL_MS, IMDB_TTL_MS, metaCache, imdbCache;
  var init_tmdb = __esm({
    "src/meta/tmdb.js"() {
      init_http();
      init_settings();
      TMDB_BASE = "https://api.themoviedb.org/3";
      TMDB_FALLBACK_KEY = "8265bd1679663a7ea12ac168da84d2e8";
      META_TTL_MS = 2 * 60 * 60 * 1e3;
      IMDB_TTL_MS = 24 * 60 * 60 * 1e3;
      metaCache = createTtlCache(120);
      imdbCache = createTtlCache(120);
    }
  });

  // src/utils/match.js
  function normalizeTitle(s) {
    let out = String(s || "").toLowerCase();
    try {
      out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    } catch (e) {
    }
    out = out.replace(/&/g, " et ");
    out = out.replace(/[^a-z0-9]+/g, " ");
    return out.trim().replace(/\s+/g, " ");
  }
  function stripSeasonSuffix(title) {
    return String(title || "").replace(new RegExp(SEASON_WORDS.source + "\\s*\\d+", "gi"), "").replace(/\s*[-–:]\s*$/, "").trim();
  }
  function tokenSet(s) {
    const n = normalizeTitle(s);
    if (!n) return [];
    return n.split(" ");
  }
  function titleScore(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    const short = na.length <= nb.length ? na : nb;
    const long = na.length <= nb.length ? nb : na;
    if (short.length >= 4) {
      if (long.startsWith(short)) {
        if (long.charAt(short.length) === " ") return 85;
        if (short.length >= 6) return 70;
        return 0;
      }
      if (short.length >= 6 && long.indexOf(short) !== -1) return 70;
    }
    const ta = tokenSet(a);
    const tb = tokenSet(b);
    if (!ta.length || !tb.length) return 0;
    const setB = {};
    for (const t of tb) setB[t] = true;
    let inter = 0;
    const seen = {};
    for (const t of ta) {
      if (setB[t] && !seen[t]) {
        inter++;
        seen[t] = true;
      }
    }
    const union = {};
    for (const t of ta) union[t] = true;
    for (const t of tb) union[t] = true;
    const jaccard = inter / Object.keys(union).length;
    return Math.round(jaccard * 60);
  }
  function scoreCard(card, meta, mediaType, season2) {
    const isMovie = mediaType !== "tv";
    let best = 0;
    const names = [];
    if (isMovie) {
      names.push(card.title);
    } else {
      if (card.series_name) names.push(card.series_name);
      names.push(stripSeasonSuffix(card.title || ""));
      names.push(card.title);
    }
    for (const t of meta.titles) {
      for (const n of names) {
        const s = titleScore(t, n);
        if (s > best) best = s;
      }
    }
    if (best <= 0) return -1;
    const titleScoreBest = best;
    if (isMovie && card.is_film === false && (parseInt(card.season_number, 10) || 0) > 0) return -1;
    if (!isMovie && card.is_film === true) return -1;
    if (!isMovie && Number.isFinite(season2) && season2 > 0) {
      const cs = parseInt(card.season_number, 10) || 0;
      if (cs > 0 && cs !== season2) best -= 20;
      else if (cs === season2) best += 12;
    }
    const cardYear = parseInt(card.year, 10) || 0;
    if (cardYear > 0 && meta.year > 0) {
      const diff = Math.abs(cardYear - meta.year);
      if (isMovie && diff > 1) return -1;
      if (!isMovie && titleScoreBest < 100 && diff > 2) return -1;
      if (diff === 0) best += 15;
      else if (diff === 1) best += 8;
      else if (diff > 3) best -= 10;
    }
    if (isMovie && card.is_film === true) best += 5;
    return best;
  }
  function rankCards(cards, meta, mediaType, season2) {
    const ranked = [];
    const seenUrls = {};
    for (const c of cards || []) {
      if (!c || !c.page_url) continue;
      if (seenUrls[c.page_url]) continue;
      seenUrls[c.page_url] = true;
      const score = scoreCard(c, meta, mediaType, season2);
      if (score > 0) ranked.push({ card: c, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }
  var SEASON_WORDS;
  var init_match = __esm({
    "src/utils/match.js"() {
      SEASON_WORDS = /(?:\bseason\b|\bsaison\b|\bs\s?(?=\d))/i;
    }
  });

  // src/sources/dle-common.js
  function resolveOrigins(base, timeoutMs, signal, forceRefresh) {
    return __async(this, null, function* () {
      const hit = originCache.get(base);
      if (hit && !forceRefresh && hit.expires > Date.now()) return hit.origins;
      const t = Math.min(timeoutMs, 12e3);
      const first = yield fetchText(base, { timeout: t, headers: HEADERS, signal });
      const firstOrigin = originOf(first.finalUrl) || base;
      const validated = [];
      if (DLE_MARKERS.test(first.text)) {
        validated.push(firstOrigin);
      } else {
        for (const candidate of yield probeLanding(first.text, firstOrigin, t, signal)) {
          try {
            const probe = yield fetchText(candidate, {
              timeout: Math.min(t, 1e4),
              headers: HEADERS,
              signal
            });
            if (DLE_MARKERS.test(probe.text)) {
              const origin = originOf(probe.finalUrl) || candidate;
              if (validated.indexOf(origin) === -1) validated.push(origin);
              if (validated.length >= 2) break;
            }
          } catch (e) {
          }
        }
      }
      if (!validated.length) validated.push(firstOrigin);
      originCache.set(base, { origins: validated, expires: Date.now() + 60 * 60 * 1e3 });
      return validated;
    });
  }
  function probeLanding(html, landingOrigin, timeoutMs, signal) {
    return __async(this, null, function* () {
      const candidates = [];
      const seen = {};
      const linkRe = /(?:href=["']|https?:\/\/)(https?:\/\/[a-z0-9.-]+[a-z0-9])/gi;
      let m;
      while ((m = linkRe.exec(html)) !== null) {
        const url = m[1];
        const host = url.replace(/^https?:\/\//i, "").toLowerCase();
        if (!host || seen[url]) continue;
        seen[url] = true;
        if (FOREIGN_HOSTS.test(host)) continue;
        if (host.indexOf(landingOrigin.replace(/^https?:\/\//i, "")) !== -1) continue;
        candidates.push(url);
      }
      candidates.sort((a, b) => {
        const pa = /^https?:\/\/fs\d+\./i.test(a) ? 0 : 1;
        const pb = /^https?:\/\/fs\d+\./i.test(b) ? 0 : 1;
        return pa - pb;
      });
      return candidates.slice(0, 4);
    });
  }
  function originOf(url) {
    const m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ""));
    return m ? m[1] : "";
  }
  function unslash(text) {
    return String(text || "").replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  function formEncode(obj) {
    const parts = [];
    for (const k of Object.keys(obj)) {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]));
    }
    return parts.join("&");
  }
  function searchDle(_0, _1) {
    return __async(this, arguments, function* (siteId, query, opts = {}) {
      const site = DLE_SITES[siteId];
      const timeoutMs = opts.timeout || 2e4;
      const cacheKey = "search:" + siteId + ":" + String(query || "").toLowerCase().trim();
      if (!opts.noCache) {
        const hit = searchCache.get(cacheKey);
        if (hit) return hit;
      }
      let attempts = yield resolveOrigins(site.base, timeoutMs, opts.signal, false);
      let cards = [];
      for (let pass = 0; pass < 2 && !cards.length; pass++) {
        if (pass === 1) {
          attempts = yield resolveOrigins(site.base, timeoutMs, opts.signal, true);
        }
        for (const origin of attempts.slice(0, 2)) {
          try {
            const res = yield fetchText(origin + "/engine/ajax/search.php", {
              method: "POST",
              body: formEncode({ query, search_start: "0", full_search: "0", result_from: "1" }),
              timeout: timeoutMs,
              headers: {
                Referer: origin + "/",
                Origin: origin,
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/x-www-form-urlencoded"
              },
              signal: opts.signal
            });
            cards = parseSearchResponse(origin, site, res.text);
          } catch (err) {
            console.warn(
              `[dle] Recherche ${siteId} sur ${origin} \xE9chou\xE9e : ` + (err && err.message ? err.message : err)
            );
          }
          if (cards.length) break;
        }
      }
      if (cards.length) searchCache.set(cacheKey, cards, SEARCH_TTL_MS);
      return cards;
    });
  }
  function parseSearchResponse(origin, site, html) {
    if (!html || /fsschal|Verification/i.test(html.slice(0, 2e3))) {
      return [];
    }
    const cards = [];
    const markers = [];
    const markerRe = /<div[^>]*class=['"][^'"]*search-item[^'"]*['"][^>]*>/g;
    let m;
    while ((m = markerRe.exec(html)) !== null) markers.push(m);
    for (let i = 0; i < markers.length; i++) {
      const start = markers[i].index;
      const end = i + 1 < markers.length ? markers[i + 1].index : html.length;
      const seg = html.slice(start, end);
      const isSeriesBlock = /class=['"][^'"]*search-series/.test(seg);
      if (isSeriesBlock) {
        const seasonsAttr = /data-seasons=['"]([^'"]*)['"]/.exec(seg);
        const tmS = /class=['"]search-title['"][^>]*>([\s\S]*?)<\/div>/.exec(seg);
        if (seasonsAttr && tmS) {
          const seriesName2 = unslash(stripTags(tmS[1])).replace(/\s*-\s*s[eé]rie\s*$/i, "").trim();
          let seasons = [];
          try {
            seasons = JSON.parse(htmlUnescape(seasonsAttr[1]));
          } catch (e) {
            seasons = [];
          }
          for (const s of Array.isArray(seasons) ? seasons : []) {
            const link = String(s.l || "");
            if (!link) continue;
            const pageUrl2 = /^https?:\/\//i.test(link) ? link : origin + link;
            const num = parseInt(s.n, 10) || 0;
            const ym2 = /-(\d{4})\.html?$/i.exec(link);
            cards.push({
              newsid: (NEWSID_RE.exec(link) || [])[1] || "",
              title: num > 1 ? seriesName2 + " - Saison " + num : seriesName2,
              series_name: seriesName2,
              season_number: num,
              poster_url: String(s.p || ""),
              page_url: pageUrl2,
              is_film: false,
              is_anime: site.isAnime,
              year: ym2 ? parseInt(ym2[1], 10) : 0,
              source: site.id
            });
          }
        }
        continue;
      }
      const om = ONCLICK_RE.exec(seg);
      if (!om) continue;
      const rel = om[1];
      const pageUrl = /^https?:\/\//i.test(rel) ? rel : origin + rel;
      const im = /<img[^>]*\ssrc=["']([^"']+)["']/i.exec(seg);
      const poster = im ? im[1] : "";
      const tm = /class=['"]search-title['"][^>]*>([\s\S]*?)<\/div>/.exec(seg);
      const rawTitle = tm ? unslash(stripTags(tm[1])) : "";
      if (!rawTitle) continue;
      const ym = YEAR_RE.exec(rawTitle);
      const year = ym ? parseInt(ym[1], 10) : 0;
      const title = rawTitle.replace(YEAR_RE, "").trim();
      const sm = SEASON_RE.exec(title);
      const seasonNumber = sm ? parseInt(sm[1], 10) : 0;
      const seriesName = sm ? title.split(SEASON_RE)[0].replace(/[\s-]+$/, "").trim() : title;
      const isFilm = !sm && !site.isAnime;
      const idm = NEWSID_RE.exec(rel);
      cards.push({
        newsid: idm ? idm[1] : "",
        title,
        series_name: seriesName,
        season_number: seasonNumber,
        poster_url: poster,
        page_url: pageUrl,
        is_film: isFilm,
        is_anime: site.isAnime,
        year,
        source: site.id
      });
    }
    return cards;
  }
  function stripTags(s) {
    return String(s || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
  }
  function htmlUnescape(s) {
    return String(s || "").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  function fetchDlePage(_0, _1, _2) {
    return __async(this, arguments, function* (siteId, pageUrl, lang, opts = {}) {
      const timeoutMs = opts.timeout || 2e4;
      try {
        return yield fetchDleSeason(siteId, pageUrl, lang, timeoutMs, opts.signal);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (String(msg).indexOf("news ID") === -1 && String(msg).indexOf("serie-config") === -1) {
          throw err;
        }
        return yield fetchDleFilm(siteId, pageUrl, lang, timeoutMs, opts.signal);
      }
    });
  }
  function fetchDleSeason(siteId, pageUrl, lang, timeoutMs, signal) {
    return __async(this, null, function* () {
      const page = yield fetchText(pageUrl, { timeout: timeoutMs, headers: HEADERS, signal });
      const html = page.text;
      const origin = originOf(page.finalUrl) || originOf(pageUrl);
      const newsId = parseNewsId(html);
      if (!newsId) throw new Error("news ID introuvable (pas de #serie-config) : " + pageUrl);
      const season2 = parseSeasonNumber(html);
      let epsRes;
      try {
        epsRes = yield fetchText(origin + "/data/eps_" + newsId + ".txt", {
          timeout: timeoutMs,
          headers: { Referer: pageUrl, Cookie: "fsschal=1", "User-Agent": UA },
          signal
        });
      } catch (err) {
        const st = err && err.status ? err.status : 0;
        if (st !== 404) throw err;
        epsRes = yield fetchText(origin + "/engine/ajax/manga_episodes_api.php?id=" + newsId, {
          timeout: timeoutMs,
          headers: { Referer: pageUrl, "X-Requested-With": "XMLHttpRequest", Cookie: "fsschal=1", "User-Agent": UA },
          signal
        });
      }
      let data;
      try {
        data = JSON.parse(epsRes.text);
      } catch (e) {
        throw new Error("donn\xE9es d \xE9pisodes invalides (site " + siteId + ", id " + newsId + ")");
      }
      const langData = data && typeof data[lang] === "object" && data[lang] ? data[lang] : {};
      const info = data && typeof data.info === "object" && data.info ? data.info : {};
      const availableLangs = Object.keys(data || {}).filter((k) => k !== "info" && k !== "alt_titles" && data[k] && typeof data[k] === "object" && Object.keys(data[k]).length).sort();
      const langsByEpisode = {};
      for (const key of Object.keys(data || {})) {
        if (key === "info" || key === "alt_titles") continue;
        const block = data[key];
        if (!block || typeof block !== "object") continue;
        for (const epKey of Object.keys(block)) {
          const providers = block[epKey];
          if (!providers || typeof providers !== "object") continue;
          const has = Object.keys(providers).some((p) => providers[p]);
          if (!has) continue;
          const num = parseInt(epKey, 10);
          if (!Number.isFinite(num)) continue;
          if (!langsByEpisode[num]) langsByEpisode[num] = [];
          if (langsByEpisode[num].indexOf(key) === -1) langsByEpisode[num].push(key);
        }
      }
      function titleOf(num) {
        const inf = info[String(num)];
        if (inf && typeof inf === "object" && inf.title) return String(inf.title);
        return "Episode " + num;
      }
      const episodes = [];
      for (const key of Object.keys(langData)) {
        const num = parseInt(key, 10);
        if (!Number.isFinite(num)) continue;
        const providers = langData[key];
        const embedUrls = {};
        if (providers && typeof providers === "object") {
          for (const p of Object.keys(providers)) {
            if (providers[p]) embedUrls[p] = providers[p];
          }
        }
        episodes.push({
          number: num,
          title: titleOf(num),
          season: season2,
          embed_urls: embedUrls,
          langs: langsByEpisode[num] || []
        });
      }
      for (const numStr of Object.keys(langsByEpisode)) {
        const num = parseInt(numStr, 10);
        if (episodes.some((e) => e.number === num)) continue;
        episodes.push({ number: num, title: titleOf(num), season: season2, embed_urls: {}, langs: langsByEpisode[num] });
      }
      episodes.sort((a, b) => a.number - b.number);
      return { season: season2, is_film: false, available_langs: availableLangs, episodes };
    });
  }
  function fetchDleFilm(siteId, pageUrl, lang, timeoutMs, signal) {
    return __async(this, null, function* () {
      const idm = NEWSID_RE.exec(pageUrl);
      if (!idm) throw new Error("news ID introuvable dans l URL film : " + pageUrl);
      const newsId = idm[1];
      const page = yield fetchText(pageUrl, { timeout: timeoutMs, headers: HEADERS, signal });
      const html = page.text;
      const origin = originOf(page.finalUrl) || originOf(pageUrl);
      let embedUrls = {};
      let available = [];
      try {
        const api = yield fetchJson(origin + "/engine/ajax/film_api.php?id=" + newsId, {
          timeout: timeoutMs,
          headers: { Referer: pageUrl, "X-Requested-With": "XMLHttpRequest", Cookie: "fsschal=1", "User-Agent": UA },
          signal
        });
        if (api && api.error) throw new Error("film_api : " + api.error);
        const players = api && api.players || {};
        const langKeys = FILM_LANG_KEYS[lang] || ["vff", "vfq"];
        for (const provider of PROVIDER_ORDER) {
          const variants = players[provider];
          if (!variants || typeof variants !== "object") continue;
          let url = "";
          for (const k of langKeys) {
            if (variants[k]) {
              url = variants[k];
              break;
            }
          }
          if (!url) url = variants["default"] || "";
          if (url) embedUrls[provider] = url;
        }
        const set = {};
        for (const provider of Object.keys(players)) {
          const v = players[provider];
          if (!v || typeof v !== "object") continue;
          if (v.vfq || v.vff) set.vf = true;
          if (v.vostfr) set.vostfr = true;
        }
        available = Object.keys(set).sort();
        if (!available.length && Object.keys(players).length) available = ["vf"];
      } catch (e) {
      }
      if (!Object.keys(embedUrls).length) {
        const iframeRe = /<iframe\b[^>]*>/gi;
        let im;
        while ((im = iframeRe.exec(html)) !== null) {
          const tag = im[0];
          const sm = /\ssrc=["']([^"']+)["']/.exec(tag);
          const dm = /\sdata-src=["']([^"']+)["']/.exec(tag);
          const src = sm && sm[1] || dm && dm[1] || "";
          if (!src) continue;
          const provider = guessProvider(src);
          if (provider && !embedUrls[provider]) embedUrls[provider] = src;
        }
      }
      const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
      let filmTitle = titleMatch ? stripTags(titleMatch[1]) : "";
      filmTitle = filmTitle.replace(/\s+[-–|]\s+[\s\S]*$/, "").trim();
      filmTitle = filmTitle.replace(/^(?:Film|Movie)\s+/i, "").trim() || "film_" + newsId;
      return {
        season: 0,
        is_film: true,
        available_langs: available,
        episodes: [
          {
            number: 1,
            title: filmTitle,
            season: 0,
            embed_urls: embedUrls,
            langs: available.slice()
          }
        ]
      };
    });
  }
  function guessProvider(src) {
    const low = String(src || "").toLowerCase();
    for (const [hint, provider] of EMBED_HINTS) {
      if (low.indexOf(hint) !== -1) return provider;
    }
    return null;
  }
  function parseNewsId(html) {
    let m = /<[^>]*\bid=["']serie-config["'][^>]*>/.exec(html);
    if (m) {
      const idm = /data-news-id=["']([^"']+)["']/.exec(m[0]);
      if (idm) return idm[1];
      const start = m.index;
      const window = html.slice(start, start + 800);
      const idm2 = /data-news-id=["']([^"']+)["']/.exec(window);
      if (idm2) return idm2[1];
    }
    const dm = /data-news-id=["'](\d+)["']/.exec(html);
    if (dm && html.indexOf("serie-config") !== -1) return dm[1];
    return "";
  }
  function parseSeasonNumber(html) {
    const cm = /<[^>]*\bid=["']serie-config["'][^>]*>/.exec(html);
    if (cm) {
      const tm = /data-title=["']([^"']*)["']/.exec(cm[0]);
      if (tm) {
        const sm = SEASON_RE.exec(unslash(tm[1]));
        if (sm) return parseInt(sm[1], 10);
      }
    }
    const tt = /<title>([\s\S]*?)<\/title>/i.exec(html);
    if (tt) {
      const sm = SEASON_RE.exec(stripTags(tt[1]));
      if (sm) return parseInt(sm[1], 10);
    }
    return 0;
  }
  var UA, HEADERS, DLE_SITES, PROVIDER_ORDER, SEASON_RE, ONCLICK_RE, NEWSID_RE, YEAR_RE, FILM_LANG_KEYS, originCache, DLE_MARKERS, FOREIGN_HOSTS, searchCache, SEARCH_TTL_MS, EMBED_HINTS;
  var init_dle_common = __esm({
    "src/sources/dle-common.js"() {
      init_http();
      UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
      HEADERS = {
        "User-Agent": UA,
        "Accept-Language": "fr-FR,fr;q=0.9",
        Cookie: "fsschal=1"
      };
      DLE_SITES = {
        fstream: { id: "fstream", label: "FStream", base: "https://fstream.top", isAnime: false },
        "french-manga": { id: "french-manga", label: "French-Manga", base: "https://french-manga.net", isAnime: true }
      };
      PROVIDER_ORDER = ["uqload", "premium", "netu", "luluvid", "filmoon", "voe", "vidzy"];
      SEASON_RE = /[Ss]aison\s+(\d+)/i;
      ONCLICK_RE = /location\.href=['"]([^'"]+)['"]/;
      NEWSID_RE = /\/(\d+)-/;
      YEAR_RE = /\s*\((\d{4})\)\s*$/;
      FILM_LANG_KEYS = {
        vf: ["vff", "vfq"],
        vff: ["vff", "vfq"],
        vfq: ["vfq", "vff"],
        vostfr: ["vostfr"],
        vo: ["vostfr"]
      };
      originCache = /* @__PURE__ */ new Map();
      DLE_MARKERS = /dle-content|engine\/ajax|short-poster|serie-config|templates\//;
      FOREIGN_HOSTS = /googleapis|gstatic|cdnjs|google\.|brave\.com|cloudflare|w3\.org|play\.google|apple\.com|fonts\.|microsoft|twitter|facebook|instagram|telegram|discord|reddit|wikipedia|youtube|mozilla|github|schema\.org|yahoo|bing\.|email-protection/;
      searchCache = createTtlCache(60);
      SEARCH_TTL_MS = 10 * 60 * 1e3;
      EMBED_HINTS = [
        ["uqload", "uqload"],
        ["vidzy", "vidzy"],
        ["fsvid", "premium"],
        ["premium", "premium"],
        ["luluvdo", "luluvid"],
        ["luluvid", "luluvid"],
        ["lulustream", "luluvid"],
        ["vidhsareup", "luluvid"],
        ["voe", "voe"],
        ["vidaraa", "filmoon"],
        ["filmoon", "filmoon"],
        ["/viper", "filmoon"],
        ["chamber_go", "filmoon"],
        ["netu", "netu"],
        ["/moon", "netu"],
        ["byse", "netu"]
      ];
    }
  });

  // src/utils/text.js
  function utf8Encode(str) {
    const s = String(str || "");
    if (typeof TextEncoder === "function") {
      try {
        return new TextEncoder().encode(s);
      } catch (e) {
      }
    }
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let code = s.charCodeAt(i);
      if (code >= 55296 && code <= 56319 && i + 1 < s.length) {
        const lo = s.charCodeAt(i + 1);
        if (lo >= 56320 && lo <= 57343) {
          code = 65536 + (code - 55296 << 10) + (lo - 56320);
          i++;
        }
      }
      if (code < 128) {
        out.push(code);
      } else if (code < 2048) {
        out.push(192 | code >> 6, 128 | code & 63);
      } else if (code < 65536) {
        out.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
      } else {
        out.push(
          240 | code >> 18,
          128 | code >> 12 & 63,
          128 | code >> 6 & 63,
          128 | code & 63
        );
      }
    }
    return new Uint8Array(out);
  }
  function utf8Decode(bytes) {
    if (!bytes || !bytes.length) return "";
    if (typeof TextDecoder === "function") {
      try {
        return new TextDecoder("utf-8").decode(bytes);
      } catch (e) {
      }
    }
    let out = "";
    let i = 0;
    const n = bytes.length;
    while (i < n) {
      const b = bytes[i];
      let code;
      if (b < 128) {
        code = b;
        i += 1;
      } else if (b >= 194 && b < 224 && i + 1 < n) {
        code = (b & 31) << 6 | bytes[i + 1] & 63;
        i += 2;
      } else if (b >= 224 && b < 240 && i + 2 < n) {
        code = (b & 15) << 12 | (bytes[i + 1] & 63) << 6 | bytes[i + 2] & 63;
        i += 3;
      } else if (b >= 240 && b < 245 && i + 3 < n) {
        code = (b & 7) << 18 | (bytes[i + 1] & 63) << 12 | (bytes[i + 2] & 63) << 6 | bytes[i + 3] & 63;
        i += 4;
      } else {
        code = 65533;
        i += 1;
      }
      if (code > 65535) {
        code -= 65536;
        out += String.fromCharCode(55296 + (code >> 10), 56320 + (code & 1023));
      } else {
        out += String.fromCharCode(code);
      }
    }
    return out;
  }
  function base64DecodeInternal(input, alphabet) {
    const lookup = {};
    for (let i = 0; i < alphabet.length; i++) lookup[alphabet[i]] = i;
    const clean = String(input || "").replace(/[^A-Za-z0-9+/=\-_]/g, "");
    const out = [];
    let bits = 0;
    let acc = 0;
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (c === "=") break;
      const v = lookup[c];
      if (v === void 0) continue;
      acc = acc << 6 | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push(acc >> bits & 255);
      }
    }
    return new Uint8Array(out);
  }
  function base64Decode(input) {
    return base64DecodeInternal(input, B64_ALPHABET);
  }
  function base64UrlDecode(input) {
    return base64DecodeInternal(input, B64_URL_ALPHABET);
  }
  function base64EncodeInternal(bytes, alphabet, pad) {
    const out = [];
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < len ? bytes[i + 1] : 0;
      const b2 = i + 2 < len ? bytes[i + 2] : 0;
      out.push(alphabet[b0 >> 2]);
      out.push(alphabet[(b0 & 3) << 4 | b1 >> 4]);
      out.push(i + 1 < len ? alphabet[(b1 & 15) << 2 | b2 >> 6] : pad ? "=" : "");
      out.push(i + 2 < len ? alphabet[b2 & 63] : pad ? "=" : "");
    }
    return out.join("");
  }
  function base64UrlEncode(bytes) {
    return base64EncodeInternal(bytes, B64_URL_ALPHABET, false);
  }
  function makeNonce() {
    const bytes = new Uint8Array(16);
    try {
      if (typeof crypto !== "undefined" && crypto && typeof crypto.getRandomValues === "function") {
        crypto.getRandomValues(bytes);
        return base64UrlEncode(bytes);
      }
    } catch (e) {
    }
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return base64UrlEncode(bytes);
  }
  var B64_ALPHABET, B64_URL_ALPHABET;
  var init_text = __esm({
    "src/utils/text.js"() {
      B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      B64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    }
  });

  // src/utils/crypto.js
  function sha256(input) {
    const msg = typeof input === "string" ? utf8Encode(input) : new Uint8Array(input || 0);
    const len = msg.length;
    const bitLenHi = Math.floor(len / 536870912);
    const bitLenLo = len << 3 >>> 0;
    const total = len + 9 + 63 >> 6 << 6;
    const block = new Uint8Array(total);
    block.set(msg);
    block[len] = 128;
    const dv = new DataView(block.buffer);
    dv.setUint32(total - 8, bitLenHi);
    dv.setUint32(total - 4, bitLenLo);
    let h0 = 1779033703, h1 = 3144134277, h2 = 1013904242, h3 = 2773480762;
    let h4 = 1359893119, h5 = 2600822924, h6 = 528734635, h7 = 1541459225;
    const w = new Int32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3;
        const s1 = (y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        const ch = e & f ^ ~e & g;
        const t1 = h + S1 + ch + K[i] + w[i] | 0;
        const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = S0 + maj | 0;
        h = g;
        g = f;
        f = e;
        e = d + t1 | 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 | 0;
      }
      h0 = h0 + a | 0;
      h1 = h1 + b | 0;
      h2 = h2 + c | 0;
      h3 = h3 + d | 0;
      h4 = h4 + e | 0;
      h5 = h5 + f | 0;
      h6 = h6 + g | 0;
      h7 = h7 + h | 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, h0);
    odv.setUint32(4, h1);
    odv.setUint32(8, h2);
    odv.setUint32(12, h3);
    odv.setUint32(16, h4);
    odv.setUint32(20, h5);
    odv.setUint32(24, h6);
    odv.setUint32(28, h7);
    return out;
  }
  function expandKey(key) {
    const nk = key.length / 4;
    const nr = nk + 6;
    const total = 4 * (nr + 1);
    const w = new Uint32Array(total);
    const dv = new DataView(key.buffer, key.byteOffset, key.byteLength);
    for (let i = 0; i < nk; i++) w[i] = dv.getUint32(i * 4);
    for (let i = nk; i < total; i++) {
      let temp = w[i - 1];
      if (i % nk === 0) {
        temp = (temp << 8 | temp >>> 24) >>> 0;
        temp = (SBOX[temp >>> 24 & 255] << 24 | SBOX[temp >>> 16 & 255] << 16 | SBOX[temp >>> 8 & 255] << 8 | SBOX[temp & 255]) >>> 0;
        temp = (temp ^ RCON[i / nk - 1] << 24) >>> 0;
      } else if (nk > 6 && i % nk === 4) {
        temp = (SBOX[temp >>> 24 & 255] << 24 | SBOX[temp >>> 16 & 255] << 16 | SBOX[temp >>> 8 & 255] << 8 | SBOX[temp & 255]) >>> 0;
      }
      w[i] = (w[i - nk] ^ temp) >>> 0;
    }
    return { w, nr };
  }
  function encryptBlock(ctx, blockIn, blockOut) {
    const { w, nr } = ctx;
    const s = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      const k = w[c];
      s[c * 4] = blockIn[c * 4] ^ k >>> 24;
      s[c * 4 + 1] = blockIn[c * 4 + 1] ^ k >>> 16 & 255;
      s[c * 4 + 2] = blockIn[c * 4 + 2] ^ k >>> 8 & 255;
      s[c * 4 + 3] = blockIn[c * 4 + 3] ^ k & 255;
    }
    for (let round = 1; round <= nr; round++) {
      const t = new Uint8Array(16);
      for (let i = 0; i < 16; i++) t[i] = SBOX[s[i]];
      let tmp;
      tmp = t[1];
      t[1] = t[5];
      t[5] = t[9];
      t[9] = t[13];
      t[13] = tmp;
      tmp = t[2];
      t[2] = t[10];
      t[10] = tmp;
      tmp = t[6];
      t[6] = t[14];
      t[14] = tmp;
      tmp = t[15];
      t[15] = t[11];
      t[11] = t[7];
      t[7] = t[3];
      t[3] = tmp;
      if (round < nr) {
        for (let c = 0; c < 4; c++) {
          const o = c * 4;
          const a0 = t[o], a1 = t[o + 1], a2 = t[o + 2], a3 = t[o + 3];
          const x = a0 ^ a1 ^ a2 ^ a3;
          t[o] = a0 ^ x ^ XTIME[a0 ^ a1];
          t[o + 1] = a1 ^ x ^ XTIME[a1 ^ a2];
          t[o + 2] = a2 ^ x ^ XTIME[a2 ^ a3];
          t[o + 3] = a3 ^ x ^ XTIME[a3 ^ a0];
        }
      }
      for (let c = 0; c < 4; c++) {
        const k = w[round * 4 + c];
        s[c * 4] = t[c * 4] ^ k >>> 24;
        s[c * 4 + 1] = t[c * 4 + 1] ^ k >>> 16 & 255;
        s[c * 4 + 2] = t[c * 4 + 2] ^ k >>> 8 & 255;
        s[c * 4 + 3] = t[c * 4 + 3] ^ k & 255;
      }
    }
    blockOut.set(s);
  }
  function aesGcmDecrypt(key, iv, data) {
    if (iv.length !== 12) throw new Error("AES-GCM: IV de 12 octets requis (re\xE7u " + iv.length + ")");
    const ctx = expandKey(key);
    const counter = new Uint8Array(16);
    counter.set(iv);
    counter[15] = 2;
    const out = new Uint8Array(data.length);
    const ks = new Uint8Array(16);
    const n = data.length;
    for (let off = 0; off < n; off += 16) {
      encryptBlock(ctx, counter, ks);
      const chunk = Math.min(16, n - off);
      for (let i = 0; i < chunk; i++) out[off + i] = data[off + i] ^ ks[i];
      for (let i = 15; i >= 12; i--) {
        counter[i] = counter[i] + 1 & 255;
        if (counter[i]) break;
      }
    }
    return out;
  }
  function aesGcmDecryptJson(key, iv, data) {
    const plain = aesGcmDecrypt(key, iv, data);
    return JSON.parse(utf8Decode(plain));
  }
  var K, SBOX, RCON, XTIME;
  var init_crypto = __esm({
    "src/utils/crypto.js"() {
      init_text();
      K = [
        1116352408,
        1899447441,
        3049323471,
        3921009573,
        961987163,
        1508970993,
        2453635748,
        2870763221,
        3624381080,
        310598401,
        607225278,
        1426881987,
        1925078388,
        2162078206,
        2614888103,
        3248222580,
        3835390401,
        4022224774,
        264347078,
        604807628,
        770255983,
        1249150122,
        1555081692,
        1996064986,
        2554220882,
        2821834349,
        2952996808,
        3210313671,
        3336571891,
        3584528711,
        113926993,
        338241895,
        666307205,
        773529912,
        1294757372,
        1396182291,
        1695183700,
        1986661051,
        2177026350,
        2456956037,
        2730485921,
        2820302411,
        3259730800,
        3345764771,
        3516065817,
        3600352804,
        4094571909,
        275423344,
        430227734,
        506948616,
        659060556,
        883997877,
        958139571,
        1322822218,
        1537002063,
        1747873779,
        1955562222,
        2024104815,
        2227730452,
        2361852424,
        2428436474,
        2756734187,
        3204031479,
        3329325298
      ];
      SBOX = new Uint8Array([
        99,
        124,
        119,
        123,
        242,
        107,
        111,
        197,
        48,
        1,
        103,
        43,
        254,
        215,
        171,
        118,
        202,
        130,
        201,
        125,
        250,
        89,
        71,
        240,
        173,
        212,
        162,
        175,
        156,
        164,
        114,
        192,
        183,
        253,
        147,
        38,
        54,
        63,
        247,
        204,
        52,
        165,
        229,
        241,
        113,
        216,
        49,
        21,
        4,
        199,
        35,
        195,
        24,
        150,
        5,
        154,
        7,
        18,
        128,
        226,
        235,
        39,
        178,
        117,
        9,
        131,
        44,
        26,
        27,
        110,
        90,
        160,
        82,
        59,
        214,
        179,
        41,
        227,
        47,
        132,
        83,
        209,
        0,
        237,
        32,
        252,
        177,
        91,
        106,
        203,
        190,
        57,
        74,
        76,
        88,
        207,
        208,
        239,
        170,
        251,
        67,
        77,
        51,
        133,
        69,
        249,
        2,
        127,
        80,
        60,
        159,
        168,
        81,
        163,
        64,
        143,
        146,
        157,
        56,
        245,
        188,
        182,
        218,
        33,
        16,
        255,
        243,
        210,
        205,
        12,
        19,
        236,
        95,
        151,
        68,
        23,
        196,
        167,
        126,
        61,
        100,
        93,
        25,
        115,
        96,
        129,
        79,
        220,
        34,
        42,
        144,
        136,
        70,
        238,
        184,
        20,
        222,
        94,
        11,
        219,
        224,
        50,
        58,
        10,
        73,
        6,
        36,
        92,
        194,
        211,
        172,
        98,
        145,
        149,
        228,
        121,
        231,
        200,
        55,
        109,
        141,
        213,
        78,
        169,
        108,
        86,
        244,
        234,
        101,
        122,
        174,
        8,
        186,
        120,
        37,
        46,
        28,
        166,
        180,
        198,
        232,
        221,
        116,
        31,
        75,
        189,
        139,
        138,
        112,
        62,
        181,
        102,
        72,
        3,
        246,
        14,
        97,
        53,
        87,
        185,
        134,
        193,
        29,
        158,
        225,
        248,
        152,
        17,
        105,
        217,
        142,
        148,
        155,
        30,
        135,
        233,
        206,
        85,
        40,
        223,
        140,
        161,
        137,
        13,
        191,
        230,
        66,
        104,
        65,
        153,
        45,
        15,
        176,
        84,
        187,
        22
      ]);
      RCON = new Uint8Array([1, 2, 4, 8, 16, 32, 64, 128, 27, 54, 108, 216, 171, 77]);
      XTIME = (() => {
        const t = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
          let v = i << 1;
          if (v & 256) v ^= 283;
          t[i] = v & 255;
        }
        return t;
      })();
    }
  });

  // src/hosts/unpack.js
  function toBase(n, b) {
    const digit = (c) => c < 36 ? c.toString(36) : String.fromCharCode(c + 29);
    return (n < b ? "" : toBase(Math.floor(n / b), b)) + digit(n % b);
  }
  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function unpack(packed) {
    const text = String(packed || "");
    const m = PACKED_RE.exec(text);
    if (!m) return text;
    const payload = m[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    const base = parseInt(m[2], 10) || 10;
    const count = parseInt(m[3], 10) || 0;
    const keys = m[4].split("|");
    let result = payload;
    for (let i = count - 1; i >= 0; i--) {
      if (i < keys.length && keys[i]) {
        const token = toBase(i, base);
        const word = keys[i];
        result = result.replace(new RegExp("\\b" + escapeRe(token) + "\\b", "g"), () => word);
      }
    }
    return result;
  }
  function findPackedScript(html) {
    const m = /eval\s*\(function\s*\(p,a,c,k[\s\S]*?<\/script>/.exec(String(html || ""));
    return m ? m[0] : "";
  }
  var PACKED_RE;
  var init_unpack = __esm({
    "src/hosts/unpack.js"() {
      PACKED_RE = /\}\s*\('((?:[^']|\\.)+)',\s*(\d+)\s*,\s*(\d+)\s*,'((?:[^']|\\.)*?)'\s*\.split\('\|'\)/;
    }
  });

  // src/hosts/vidzyShared.js
  function hostOffset(hostname) {
    let total = 0;
    const h = String(hostname || "");
    for (let i = 0; i < h.length; i++) {
      total = total + h.charCodeAt(i) & 255;
    }
    return total;
  }
  function keystreams(body, length, hostname) {
    const streams = [];
    let am;
    ARRAY_KEY_RE.lastIndex = 0;
    while ((am = ARRAY_KEY_RE.exec(body)) !== null) {
      const key = am[1].split(",").map((x) => parseInt(x, 10)).filter(Number.isFinite);
      if (key.length) {
        const ks = new Array(length);
        for (let i = 0; i < length; i++) ks[i] = key[i % key.length];
        streams.push(ks);
      }
    }
    const host = hostOffset(hostname);
    const layout = LAYOUT_RE.exec(body);
    const layoutOffset = layout ? 96 + parseInt(layout[1], 10) - parseInt(layout[2], 10) : 0;
    const offsets = {};
    [0, host, layoutOffset, host + layoutOffset].forEach((o) => {
      offsets[o] = true;
    });
    let rm;
    RAMP_KEY_RE.lastIndex = 0;
    while ((rm = RAMP_KEY_RE.exec(body)) !== null) {
      const seed = rm[1].toLowerCase().indexOf("0x") === 0 ? parseInt(rm[1], 16) : parseInt(rm[1], 10);
      const step = parseInt(rm[2], 10);
      if (!Number.isFinite(seed) || !Number.isFinite(step)) continue;
      for (const offStr of Object.keys(offsets)) {
        const off = parseInt(offStr, 10) || 0;
        const ks = new Array(length);
        for (let i = 0; i < length; i++) ks[i] = seed + i * step + off & 255;
        streams.push(ks);
      }
    }
    return streams;
  }
  function reverse(s) {
    return s.split("").reverse().join("");
  }
  function deobfuscateSrc(body, payloadB64, hostname) {
    const raw = base64Decode(payloadB64);
    let tried = 0;
    for (const ks of keystreams(body, raw.length, hostname)) {
      for (let srcFlip = 0; srcFlip < 2; srcFlip++) {
        const source = srcFlip === 0 ? raw : reverseBytes(raw);
        let decoded = "";
        for (let i = 0; i < source.length; i++) {
          decoded += String.fromCharCode(source[i] ^ ks[i]);
        }
        for (let flip = 0; flip < 2; flip++) {
          const candidate = flip === 0 ? decoded : reverse(decoded);
          tried++;
          if (candidate.indexOf(".m3u8") !== -1 && candidate.indexOf("/troll/") === -1) {
            return candidate;
          }
        }
      }
    }
    throw new Error(
      "aucun sch\xE9ma d obfuscation connu n a d\xE9cod\xE9 le src (" + tried + " combinaisons test\xE9es) \u2014 l embed a probablement pivot\xE9 vers un nouveau"
    );
  }
  function reverseBytes(arr) {
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[arr.length - 1 - i];
    return out;
  }
  function plainSrc(unpacked) {
    const m = SRC_RE.exec(unpacked);
    return m ? m[1] : null;
  }
  function withGateKey(page, streamUrl, referer, timeoutMs) {
    return __async(this, null, function* () {
      const gate = GATE_RE.exec(page);
      if (!gate) return streamUrl;
      const qs = Object.keys(GATE_PARAMS).map((k) => k + "=" + encodeURIComponent(GATE_PARAMS[k])).join("&");
      try {
        const data = yield fetchJsonSafe(gate[0] + "?" + qs, {
          timeout: Math.min(timeoutMs || 1e4, 1e4),
          headers: { Origin: String(referer || "").replace(/\/$/, ""), Referer: referer || "" }
        });
        const key = data && data.gk ? String(data.gk) : "";
        if (!key) return streamUrl;
        return streamUrl + (streamUrl.indexOf("?") !== -1 ? "&" : "?") + "gk=" + encodeURIComponent(key);
      } catch (e) {
        console.warn("[sestudio] gate vidzy muette (\u224890 s jouables) : " + (e && e.message ? e.message : e));
        return streamUrl;
      }
    });
  }
  var ARRAY_KEY_RE, RAMP_KEY_RE, LAYOUT_RE, SRC_RE, GATE_RE, GATE_PARAMS;
  var init_vidzyShared = __esm({
    "src/hosts/vidzyShared.js"() {
      init_text();
      init_http();
      ARRAY_KEY_RE = /k=\[([\d,]+)\]/g;
      RAMP_KEY_RE = /\(\s*(0x[0-9a-fA-F]+|\d+)\s*\+\s*i\s*\*\s*(\d+)\s*(?:\+\s*[A-Za-z_$][\w$]*\s*)*\)\s*&\s*255/g;
      LAYOUT_RE = /calc\(\s*1in\s*\+\s*(\d+)px\s*\)[\s\S]*?calc\(\s*100%\s*-\s*(\d+)px\s*\)/;
      SRC_RE = /src\s*:\s*["']([^"']+\.m3u8[^"']*)["']/;
      GATE_RE = /https:\/\/[\w.-]+\/gate\.php/;
      GATE_PARAMS = {
        v: "p1",
        cw: "141.48",
        cw2: "155.03",
        wg: "1",
        dpr: "1",
        sw: "1920",
        hw: "8",
        ft: "https://fstream.top",
        rf: "fstream.top"
      };
    }
  });

  // src/hosts/subtitles.js
  function isPlaceholder(url) {
    const path = String(url || "").split("?")[0];
    const file = path.split("/").pop().toLowerCase();
    return file === "empty.vtt" || file === "empty.srt";
  }
  function htmlUnescape2(s) {
    return String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'");
  }
  function build(url, attrs, baseUrl) {
    const kind = String(attrs.kind || "subtitles").toLowerCase();
    if (!TEXT_KINDS[kind]) return null;
    const absolute = resolveUrl(baseUrl, htmlUnescape2(url));
    if (isPlaceholder(absolute)) return null;
    const lang = attrs.srclang || "";
    const isDefault = "default" in attrs && String(attrs["default"]).toLowerCase() !== "false";
    return {
      url: absolute,
      lang,
      label: attrs.label || lang || "Subtitles",
      default: isDefault
    };
  }
  function fromLoadTracks(page, baseUrl) {
    const found = [];
    let call;
    LOAD_TRACKS_RE.lastIndex = 0;
    while ((call = LOAD_TRACKS_RE.exec(page)) !== null) {
      const body = call[1];
      let start = 0;
      let urlMatch;
      SUB_URL_RE.lastIndex = 0;
      while ((urlMatch = SUB_URL_RE.exec(body)) !== null) {
        const close = body.indexOf("}", urlMatch.index + urlMatch[0].length);
        const end = close < 0 ? body.length : close;
        const segment = body.slice(start, end);
        const attrs = {};
        let km;
        KEY_RE.lastIndex = 0;
        while ((km = KEY_RE.exec(segment)) !== null) {
          attrs[km[1]] = km[2] !== void 0 ? km[2] : km[3];
        }
        const sub = build(urlMatch[1], attrs, baseUrl);
        if (sub) found.push(sub);
        start = end;
      }
    }
    return found;
  }
  function fromHtmlTracks(page, baseUrl) {
    const found = [];
    let track;
    HTML_TRACK_RE.lastIndex = 0;
    while ((track = HTML_TRACK_RE.exec(page)) !== null) {
      const attrs = {};
      let am;
      ATTR_RE.lastIndex = 0;
      while ((am = ATTR_RE.exec(track[1])) !== null) {
        attrs[am[1].toLowerCase()] = am[2];
      }
      if (!attrs.src) continue;
      const sub = build(attrs.src, attrs, baseUrl);
      if (sub) found.push(sub);
    }
    return found;
  }
  function extractSubtitles(page, baseUrl) {
    const found = fromLoadTracks(page, baseUrl).concat(fromHtmlTracks(page, baseUrl));
    const seen = {};
    const unique = [];
    for (const s of found) {
      if (seen[s.url]) continue;
      seen[s.url] = true;
      unique.push(s);
    }
    return unique;
  }
  var LOAD_TRACKS_RE, HTML_TRACK_RE, ATTR_RE, KEY_RE, SUB_URL_RE, TEXT_KINDS;
  var init_subtitles = __esm({
    "src/hosts/subtitles.js"() {
      init_http();
      LOAD_TRACKS_RE = /loadTracks\s*\(\s*\[([\s\S]{0,4000}?)\]\s*\)/g;
      HTML_TRACK_RE = /<track\b([^>]*)>/gi;
      ATTR_RE = /(\w[\w-]*)\s*=\s*["']([^"']*)["']/g;
      KEY_RE = /\b(kind|srclang|label|default)\s*:\s*(?:["']([^"']*)["']|(\w+))/g;
      SUB_URL_RE = /["']([^"']+\.(?:vtt|srt)(?:\?[^"']*)?)["']/gi;
      TEXT_KINDS = { subtitles: true, captions: true };
    }
  });

  // src/hosts/index.js
  function originOf2(url) {
    const m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ""));
    return m ? m[1] : "";
  }
  function hostnameOf(url) {
    const m = /^https?:\/\/([^/?#]+)/i.exec(String(url || ""));
    if (!m) return "";
    return m[1].split(":")[0].toLowerCase();
  }
  function resolveUqload(embedUrl, opts) {
    return __async(this, null, function* () {
      const referer = "https://uqload.is/";
      const res = yield fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: {
          Referer: referer,
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site"
        },
        signal: opts.signal
      });
      const packed = findPackedScript(res.text);
      if (packed) {
        const m = FILE_RE.exec(unpack(packed));
        if (m) return { url: m[1], referer, ua: BROWSER_UA };
      }
      const mp4 = MP4_RE.exec(res.text);
      if (mp4) return { url: mp4[1], referer, ua: BROWSER_UA };
      throw new Error("aucune URL de flux dans l embed uqload");
    });
  }
  function resolveVidzyFamily(embedUrl, opts, variant) {
    return __async(this, null, function* () {
      const referer = variant === "premium" ? "https://fsvid.lol/" : "https://vidzy.org/";
      const res = yield fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: {
          Referer: referer,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site"
        },
        signal: opts.signal
      });
      const packed = findPackedScript(res.text);
      const unpacked = packed ? unpack(packed) : res.text;
      let streamUrl = null;
      const obf = INLINE_SRC_LOCAL.exec(unpacked);
      if (obf) {
        streamUrl = deobfuscateSrc(obf[1], obf[2], hostnameOf(res.finalUrl));
      } else {
        streamUrl = plainSrc(unpacked);
      }
      if (!streamUrl || streamUrl.indexOf(".m3u8") === -1) {
        throw new Error("source m3u8 introuvable dans l embed " + variant);
      }
      let finalUrl = streamUrl;
      if (variant === "vidzy") {
        finalUrl = yield withGateKey(res.text, streamUrl, referer, opts.timeout);
      }
      return {
        url: finalUrl,
        referer,
        ua: BROWSER_UA,
        subtitles: extractSubtitles(res.text, res.finalUrl),
        // vidzy : segments refusés au player natif (TLS Chrome + gk=) même
        // quand la playlist passe — stream.js rangera ce flux en dernier ⚠.
        weakPlayer: variant === "vidzy"
      };
    });
  }
  function resolveNetu(embedUrl, opts) {
    return __async(this, null, function* () {
      const first = yield fetchText(embedUrl, {
        timeout: opts.timeout,
        headers: { Referer: embedUrl },
        signal: opts.signal
      });
      const finalUrl = first.finalUrl;
      const cm = /\/e\/([a-zA-Z0-9]+)/.exec(finalUrl);
      if (!cm) throw new Error("code vid\xE9o introuvable dans la redirection netu : " + finalUrl);
      const code = cm[1];
      const apiBase = originOf2(finalUrl);
      const referer = apiBase + "/e/" + code;
      const data = yield fetchJson(apiBase + "/api/videos/" + code + "/", {
        timeout: opts.timeout,
        headers: { Referer: referer, Accept: "application/json" },
        signal: opts.signal
      });
      const pb = data && data.playback;
      if (!pb || !pb.key_parts) throw new Error("config playback absente (netu " + code + ")");
      let sources;
      try {
        const key = concatBytes(pb.key_parts.map((p) => base64UrlDecode(p)));
        const iv = base64UrlDecode(pb.iv);
        let payload = base64UrlDecode(pb.payload);
        if (payload.length > 16) payload = payload.slice(0, payload.length - 16);
        sources = aesGcmDecryptJson(key, iv, payload).sources || [];
      } catch (e) {
        throw new Error("d\xE9chiffrement playback netu impossible (" + code + ")");
      }
      if (!sources.length) throw new Error("aucune source dans la config netu (" + code + ")");
      let best = sources[0];
      for (const s of sources) {
        if (s && s.quality === "h") {
          best = s;
          break;
        }
      }
      return { url: best.url, referer, ua: BROWSER_UA };
    });
  }
  function concatBytes(list) {
    let total = 0;
    for (const a of list) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of list) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  }
  function resolveLuluvid(embedUrl, opts) {
    return __async(this, null, function* () {
      const cm = LULU_CODE_RE.exec(embedUrl);
      if (!cm) throw new Error("code luluvid introuvable dans : " + embedUrl);
      const code = cm[1];
      let lastError = "aucun host candidat n a r\xE9pondu";
      for (const host of LULU_HOSTS) {
        const url = "https://" + host + "/e/" + code;
        let text;
        try {
          const res = yield fetchText(url, {
            timeout: opts.timeout,
            headers: {
              Referer: "https://luluvdo.com/",
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Sec-Fetch-Dest": "iframe",
              "Sec-Fetch-Mode": "navigate",
              "Sec-Fetch-Site": "cross-site"
            },
            signal: opts.signal
          });
          text = res.text;
        } catch (err) {
          lastError = host + " : " + (err && err.message ? err.message : err);
          continue;
        }
        const low = text.toLowerCase();
        if (text.indexOf("no longer available") !== -1 || low.indexOf("expired") !== -1) {
          throw new Error("fichier luluvid expir\xE9 ou supprim\xE9 (" + code + ")");
        }
        const packed = findPackedScript(text);
        if (!packed) {
          lastError = host + " : pas de player pack\xE9";
          continue;
        }
        const m = /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/.exec(unpack(packed));
        if (!m) {
          lastError = host + " : pas de source m3u8";
          continue;
        }
        return { url: m[1], referer: "https://luluvdo.com/", ua: BROWSER_UA };
      }
      throw new Error("luluvid irresolvable (" + lastError + ")");
    });
  }
  function resolveFilmoon(embedUrl, opts) {
    return __async(this, null, function* () {
      let resolved = embedUrl;
      let cm = FILMOON_CODE_RE.exec(embedUrl);
      if (!cm) {
        const res = yield fetchText(embedUrl, {
          timeout: Math.min(opts.timeout || 15e3, 1e4),
          headers: { Referer: embedUrl },
          signal: opts.signal
        });
        resolved = res.finalUrl;
        cm = FILMOON_CODE_RE.exec(resolved);
        if (!cm) {
          throw new Error("wrapper filmoon sans filecode : " + embedUrl + " \u2192 " + resolved);
        }
      }
      const code = cm[1];
      const data = yield fetchJson(originOf2(resolved) + "/api/stream", {
        method: "POST",
        body: { filecode: code, device: "web" },
        timeout: opts.timeout,
        headers: {
          Referer: resolved,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        signal: opts.signal
      });
      const streamUrl = data && data.streaming_url || "";
      if (!streamUrl) throw new Error("streaming_url absente de la r\xE9ponse filmoon (" + code + ")");
      return { url: streamUrl, referer: resolved, ua: BROWSER_UA };
    });
  }
  function rot13(s) {
    return String(s || "").replace(/[a-zA-Z]/g, (c) => {
      const base = c <= "Z" ? 65 : 97;
      return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
    });
  }
  function b64Loose(text) {
    const cleaned = String(text || "").replace(/[^A-Za-z0-9+/=]/g, "");
    return utf8Decode(base64Decode(cleaned));
  }
  function decodeVoeConfig(payload) {
    let stage = rot13(payload);
    for (const junk of JUNK_DIGRAPHS) stage = stage.split(junk).join("_");
    stage = b64Loose(stage);
    let shifted = "";
    for (let i = 0; i < stage.length; i++) shifted += String.fromCharCode(stage.charCodeAt(i) - 3);
    shifted = shifted.split("").reverse().join("");
    const config = JSON.parse(b64Loose(shifted));
    if (!config || typeof config !== "object") throw new Error("config voe non objet");
    return config;
  }
  function extractVoePayload(html) {
    const m = JSON_BLOB_RE.exec(html);
    if (!m) return null;
    const blob = m[1].trim();
    try {
      const parsed = JSON.parse(blob);
      if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === "string") return parsed[0];
      if (typeof parsed === "string") return parsed;
    } catch (e) {
      return blob || null;
    }
    return null;
  }
  function resolveVoe(embedUrl, opts) {
    return __async(this, null, function* () {
      let url = embedUrl;
      let payload = null;
      let finalUrl = embedUrl;
      const MAX_JS_HOPS = 6;
      let reached = false;
      for (let hop = 0; hop < MAX_JS_HOPS; hop++) {
        const res = yield fetchText(url, {
          timeout: opts.timeout,
          headers: { Referer: url, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
          signal: opts.signal
        });
        finalUrl = res.finalUrl;
        payload = extractVoePayload(res.text);
        if (payload) {
          reached = true;
          break;
        }
        const low = finalUrl.toLowerCase();
        if (LULU_HANDOFF.some((h) => low.indexOf(h) !== -1)) {
          return resolveLuluvid(finalUrl, opts);
        }
        const next = JS_LOCATION_RE.exec(res.text);
        if (!next) {
          throw new Error("cha\xEEne voe bloqu\xE9e \xE0 " + finalUrl + " (ni config, ni redirection)");
        }
        url = resolveUrl(finalUrl, next[1]);
      }
      if (!reached) throw new Error("cha\xEEne voe : trop de sauts JS depuis " + embedUrl);
      let config;
      try {
        config = decodeVoeConfig(payload);
      } catch (e) {
        throw new Error("d\xE9codage config voe impossible depuis " + finalUrl);
      }
      const streamUrl = config.source || config.direct_access_url || "";
      if (!streamUrl) throw new Error("source absente de la config voe (" + finalUrl + ")");
      return { url: streamUrl, referer: finalUrl, ua: BROWSER_UA };
    });
  }
  function providerFromEmbedUrl(src) {
    const low = String(src || "").toLowerCase();
    const hints = [
      ["uqload", "uqload"],
      ["vidzy", "vidzy"],
      ["fsvid", "premium"],
      ["premium", "premium"],
      ["luluvdo", "luluvid"],
      ["luluvid", "luluvid"],
      ["lulustream", "luluvid"],
      ["vidhsareup", "luluvid"],
      ["voe", "voe"],
      ["vidaraa", "filmoon"],
      ["filmoon", "filmoon"],
      ["/viper", "filmoon"],
      ["chamber_go", "filmoon"],
      ["netu", "netu"],
      ["/moon", "netu"],
      ["byse", "netu"]
    ];
    for (const [hint, provider] of hints) {
      if (low.indexOf(hint) !== -1) return provider;
    }
    return null;
  }
  function resolveEmbed(_0, _1) {
    return __async(this, arguments, function* (provider, embedUrl, opts = {}) {
      const name = provider || providerFromEmbedUrl(embedUrl);
      if (!name || !RESOLVERS[name]) {
        throw new Error("pas d extracteur pour cet embed : " + embedUrl);
      }
      const out = yield RESOLVERS[name](embedUrl, opts);
      if (!out || !out.url) throw new Error("r\xE9solution vide (" + name + ")");
      return {
        provider: name,
        url: out.url,
        referer: out.referer || "",
        ua: out.ua || BROWSER_UA,
        subtitles: out.subtitles || [],
        weakPlayer: out.weakPlayer === true
      };
    });
  }
  function resolveEmbeds(_0) {
    return __async(this, arguments, function* (embedUrls, opts = {}) {
      const max = opts.maxResults || 2;
      const errors = [];
      const ordered = [];
      const seen = {};
      for (const p of PROVIDER_ORDER2) {
        if (embedUrls[p] && !seen[p]) {
          ordered.push([p, embedUrls[p]]);
          seen[p] = true;
        }
      }
      for (const p of Object.keys(embedUrls)) {
        if (!seen[p] && embedUrls[p]) {
          const guessed = providerFromEmbedUrl(embedUrls[p]);
          ordered.push([guessed || p, embedUrls[p]]);
          seen[p] = true;
        }
      }
      const attempts = ordered.slice(0, opts.maxAttempts || 4);
      const settled = yield Promise.all(
        attempts.map(
          ([provider, embedUrl]) => resolveEmbed(provider, embedUrl, opts).then(
            (got) => ({ ok: true, provider, got }),
            (err) => {
              const msg = err && err.message ? err.message : String(err);
              return { ok: false, provider, msg };
            }
          )
        )
      );
      const out = [];
      for (const s of settled) {
        if (s.ok) {
          if (out.length < max) out.push(s.got);
        } else {
          errors.push(s.provider + ": " + s.msg);
          console.warn("[sestudio] host " + s.provider + " \xE9chou\xE9 : " + s.msg);
        }
      }
      if (!out.length && errors.length) {
        throw new Error("tous les hosts ont \xE9chou\xE9 \u2014 " + errors.join(" | "));
      }
      return out;
    });
  }
  var BROWSER_UA, PROVIDER_ORDER2, FILE_RE, MP4_RE, INLINE_SRC_LOCAL, LULU_HOSTS, LULU_CODE_RE, FILMOON_CODE_RE, JSON_BLOB_RE, JS_LOCATION_RE, JUNK_DIGRAPHS, LULU_HANDOFF, RESOLVERS;
  var init_hosts = __esm({
    "src/hosts/index.js"() {
      init_http();
      init_text();
      init_crypto();
      init_unpack();
      init_vidzyShared();
      init_subtitles();
      BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      PROVIDER_ORDER2 = ["uqload", "netu", "filmoon", "voe", "luluvid", "premium", "vidzy"];
      FILE_RE = /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/;
      MP4_RE = /(https:\/\/strm[^"'<>\s]+\/v\.mp4)/;
      INLINE_SRC_LOCAL = /src\s*:\s*\(function\(s\)\{([\s\S]{0,4000}?)\}\)\("([A-Za-z0-9+/=]+)"\)/;
      LULU_HOSTS = ["luluvdo.com", "luluvid.com"];
      LULU_CODE_RE = /(?:embed[-/]|\/e\/|\/d\/|\/f\/)([A-Za-z0-9]+)/;
      FILMOON_CODE_RE = /\/(?:[edf]\/|embed[-/])([A-Za-z0-9]+)/;
      JSON_BLOB_RE = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/;
      JS_LOCATION_RE = /window\.location\.href\s*=\s*['"]([^'"]+)['"]/;
      JUNK_DIGRAPHS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
      LULU_HANDOFF = ["luluvdo.com", "luluvid.com", "lulustream.com"];
      RESOLVERS = {
        uqload: resolveUqload,
        vidzy: (u, o) => resolveVidzyFamily(u, o, "vidzy"),
        premium: (u, o) => resolveVidzyFamily(u, o, "premium"),
        netu: resolveNetu,
        luluvid: resolveLuluvid,
        filmoon: resolveFilmoon,
        voe: resolveVoe
      };
    }
  });

  // src/core/stream.js
  function langLabel(langKey) {
    return LANG_LABELS[langKey] || String(langKey || "").toUpperCase();
  }
  function makeStream(parts) {
    const st = {
      title: String(parts.title || "").trim() || "Flux",
      url: String(parts.url || ""),
      quality: parts.quality || "Direct",
      language: parts.language || "",
      headers: parts.headers && Object.keys(parts.headers).length ? parts.headers : void 0,
      subtitles: parts.subtitles && parts.subtitles.length ? parts.subtitles : void 0,
      _langKey: parts._langKey || "vo",
      _site: parts._site || ""
    };
    if (parts._weakPlayer === true) st._weakPlayer = true;
    return st;
  }
  function composeTitle({ site, episode, host, url, lang }) {
    const kind = /\.m3u8(\?|$)/i.test(String(url || "")) ? "HLS" : "MP4";
    const epLabel = episode > 0 ? " \xB7 E" + String(episode).padStart(2, "0") : "";
    return `${site}${epLabel} \xB7 ${host} \xB7 ${kind} \xB7 ${langLabel(lang)}`;
  }
  function displayName(s) {
    if (s.name) return s.name;
    const parts = String(s.title || "").split(" \xB7 ");
    let ep = "";
    const rest = [];
    parts.forEach(function(p, i) {
      if (i > 0 && /^E\d{1,4}$/.test(p)) ep = p;
      else rest.push(p);
    });
    const host = rest.length > 1 ? rest[1] : "";
    return PROVIDER_NAME + (s._site ? " \xB7 " + s._site : "") + (host ? " \xB7 " + host : "") + (ep ? " \xB7 " + ep : "");
  }
  function finalizeStreams(streams, cfg) {
    const order = cfg.fallbackLangs;
    const allowed = cfg.allowOtherLang ? order : order.slice(0, 1);
    const idxOf = (key) => {
      const i = order.indexOf(key);
      return i === -1 ? 99 : i;
    };
    const relevant = (streams || []).filter((s) => s && s.url && allowed.indexOf(s._langKey) !== -1);
    const sorted = relevant.slice().sort((a, b) => idxOf(a._langKey) - idxOf(b._langKey));
    const seen = {};
    const good = [];
    const weak = [];
    for (const s of sorted) {
      if (seen[s.url]) continue;
      seen[s.url] = true;
      const clean = {
        name: displayName(s),
        title: s.title,
        url: s.url,
        quality: s.quality || "Direct",
        language: s.language || LANG_LABELS[s._langKey] || String(s._langKey || "").toUpperCase()
      };
      if (s.headers && Object.keys(s.headers).length) clean.headers = s.headers;
      if (s.subtitles && s.subtitles.length) clean.subtitles = s.subtitles;
      (s._weakPlayer === true ? weak : good).push(clean);
    }
    return good.concat(
      weak.map(function(w) {
        if (!/ ⚠$/.test(w.name)) w.name += " \u26A0";
        return w;
      })
    );
  }
  var LANG_LABELS, PROVIDER_NAME, TEST_STREAMS;
  var init_stream = __esm({
    "src/core/stream.js"() {
      LANG_LABELS = {
        vf: "VF",
        vostfr: "VOSTFR",
        vo: "VO"
      };
      PROVIDER_NAME = "Fluxio";
      TEST_STREAMS = [
        { name: "Fluxio \xB7 TEST HLS (mux.dev)", title: "Test HLS", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", quality: "Auto (HLS)", language: "TEST" },
        {
          name: "Fluxio \xB7 TEST MP4",
          title: "Test MP4",
          url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4",
          quality: "Direct",
          language: "TEST",
          // Headers de test : le lecteur Nuvio bufferise parfois les MP4 progressifs
          // sans aucun header (alors que les MP4 webflix avec Referer/UA jouent).
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "*/*",
            "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"
          }
        }
      ];
    }
  });

  // src/sources/dle-runner.js
  function runDleSite(ctx, siteId) {
    return __async(this, null, function* () {
      const { cfg, signal, push, shouldStop } = ctx;
      const site = DLE_SITES[siteId];
      if (!site) return;
      let meta;
      try {
        meta = yield ctx.meta;
      } catch (e) {
        meta = null;
      }
      if (!meta || !meta.titles.length) {
        console.error(`[dle] ${siteId} : TMDB n'a fourni aucun titre, recherche impossible.`);
        return;
      }
      let confident = null;
      const allCards = [];
      for (const query of meta.titles.slice(0, 2)) {
        if (shouldStop()) break;
        let cards = [];
        try {
          cards = yield searchDle(siteId, query, { timeout: cfg.timeoutMs, signal });
        } catch (err) {
          console.warn(
            `[dle] Recherche ${siteId} \xAB ${query} \xBB \xE9chou\xE9e : ` + (err && err.message ? err.message : err)
          );
          continue;
        }
        if (!cards.length) continue;
        for (const c of cards) allCards.push(c);
        const ranked = rankCards(allCards, meta, ctx.mediaType, ctx.season);
        if (ranked.length) {
          confident = ranked;
          if (ranked[0].score >= 95) break;
        }
      }
      if (!confident) {
        console.log(`[dle] ${siteId} : aucune carte pour \xAB ${meta.titles[0]} \xBB`);
        return;
      }
      const wantedEp = parseInt(ctx.episode, 10) || 0;
      if (ctx.mediaType === "tv" && wantedEp > 0) {
        confident = confident.map((r) => {
          const range = /(\d{1,4})\s*[-–]\s*(\d{1,4})/.exec(r.card.title || "");
          if (range) {
            const lo = parseInt(range[1], 10);
            const hi = parseInt(range[2], 10);
            if (wantedEp < lo || wantedEp > hi) {
              return { card: r.card, score: r.score - 40 };
            }
          }
          return r;
        }).sort((a, b) => b.score - a.score);
      }
      const threshold = Math.max(MIN_CARD_SCORE, confident[0].score - 30);
      const bestCards = confident.filter((r) => r.score >= threshold && r.card.source).slice(0, MAX_CARDS_PER_SITE);
      if (!bestCards.length) return;
      console.log(
        `[dle] ${siteId} : \xAB ${meta.titles[0]} \xBB \u2192 ` + bestCards.map((r) => `"${r.card.title}" (${r.score})`).join(", ")
      );
      const isMovie = ctx.mediaType !== "tv";
      let streams = 0;
      for (const cand of bestCards) {
        if (shouldStop() || streams >= MAX_STREAMS_PER_SITE) break;
        try {
          const got = yield resolveCard(ctx, siteId, cand.card, isMovie);
          streams += got.length;
        } catch (err) {
          console.warn(
            `[dle] Carte ${siteId} "${cand.card.title}" \xE9chou\xE9e : ` + (err && err.message ? err.message : err)
          );
        }
      }
    });
  }
  function resolveCard(ctx, siteId, card, isMovie) {
    return __async(this, null, function* () {
      const { cfg, signal, push, shouldStop } = ctx;
      const site = DLE_SITES[siteId] || { label: siteId };
      const langsToTry = cfg.fallbackLangs.slice(0, cfg.allowOtherLang ? 3 : 1);
      const tried = [];
      let count = 0;
      for (const lang of langsToTry) {
        if (shouldStop() || count >= MAX_STREAMS_PER_SITE) break;
        if (tried.indexOf(lang) !== -1) continue;
        tried.push(lang);
        let page;
        try {
          page = yield fetchDlePage(siteId, card.page_url, lang, {
            timeout: cfg.timeoutMs,
            signal
          });
        } catch (err) {
          console.warn(
            `[dle] Page injoignable (${siteId}, lang=${lang}) : ` + (err && err.message ? err.message : err)
          );
          continue;
        }
        const ep = pickEpisode(page, isMovie, ctx.episode);
        if (!ep || !ep.embed_urls || !Object.keys(ep.embed_urls).length) {
          if (episodeExistsInPage(page, isMovie, ctx.episode)) {
            const others = (pickAnyEpisode(page, isMovie, ctx.episode, true) || { langs: [] }).langs || [];
            for (const o of others) {
              const l = String(o || "").toLowerCase();
              if (l && langsToTry.indexOf(l) !== -1 && tried.indexOf(l) === -1) tried.push(l);
            }
            continue;
          }
          if (!isMovie && page.episodes && page.episodes.length) break;
          continue;
        }
        let resolved;
        try {
          resolved = yield resolveEmbeds(ep.embed_urls, {
            timeout: HOST_TIMEOUT_MS,
            signal,
            maxResults: 2,
            maxAttempts: 4
          });
        } catch (err) {
          console.warn(
            `[dle] R\xE9solution hosts \xE9chou\xE9e (${siteId} E${ep.number}) : ` + (err && err.message ? err.message : err)
          );
          resolved = [];
        }
        if (!resolved.length) {
          const others = (ep.langs || []).filter(
            (l) => langsToTry.indexOf(l) !== -1 && tried.indexOf(l) === -1
          );
          for (const o of others) tried.push(o);
          continue;
        }
        const epNumber = isMovie || !(ep.number > 0) ? 0 : ep.number;
        for (const r of resolved) {
          const langLabel3 = LANG_LABELS2[lang] || String(lang).toUpperCase();
          push(
            makeStream({
              title: composeTitle({ site: site.label || siteId, episode: epNumber, host: r.provider, url: r.url, lang: langLabel3 }),
              url: r.url,
              quality: /\.m3u8(\?|$)/i.test(String(r.url || "")) ? "Auto (HLS)" : "Direct",
              language: langLabel3,
              headers: buildHeaders(r.referer, r.ua),
              subtitles: (r.subtitles || []).map((sub) => ({
                url: sub.url,
                title: sub.label || String(sub.lang || "").toUpperCase(),
                lang: sub.lang || "fre"
              })),
              _weakPlayer: r.weakPlayer === true,
              _langKey: lang,
              _site: siteId
            })
          );
          count++;
        }
        if (count) break;
      }
      return count;
    });
  }
  function buildHeaders(referer, ua) {
    const headers = {};
    if (referer) headers.Referer = referer;
    if (ua) headers["User-Agent"] = ua;
    return headers;
  }
  function pickEpisode(page, isMovie, episode) {
    const eps = (page.episodes || []).filter(
      (e) => e && e.embed_urls && Object.keys(e.embed_urls).length
    );
    if (!eps.length) return null;
    if (isMovie || page.is_film) return eps[0];
    const wanted = parseInt(episode, 10) || 0;
    if (wanted > 0) {
      const exact = eps.find((e) => parseInt(e.number, 10) === wanted);
      if (exact) return exact;
      const loose = eps.find((e) => {
        const n = parseFloat(e.number);
        return Number.isFinite(n) && Math.round(n) === wanted && Math.abs(n - wanted) < 1;
      });
      if (loose) return loose;
    }
    return null;
  }
  function episodeExistsInPage(page, isMovie, episode) {
    return pickAnyEpisode(page, isMovie, episode, false) !== null;
  }
  function pickAnyEpisode(page, isMovie, episode, embedsOnly) {
    const eps = (page.episodes || []).filter((e) => {
      if (!e) return false;
      if (embedsOnly) return e.embed_urls && Object.keys(e.embed_urls).length;
      return true;
    });
    if (!eps.length) return null;
    if (isMovie || page.is_film) return eps[0];
    const wanted = parseInt(episode, 10) || 0;
    if (wanted > 0) {
      const exact = eps.find((e) => parseInt(e.number, 10) === wanted);
      if (exact) return exact;
      const loose = eps.find((e) => {
        const n = parseFloat(e.number);
        return Number.isFinite(n) && Math.round(n) === wanted && Math.abs(n - wanted) < 1;
      });
      if (loose) return loose;
    }
    return null;
  }
  var MAX_CARDS_PER_SITE, MIN_CARD_SCORE, HOST_TIMEOUT_MS, MAX_STREAMS_PER_SITE, LANG_LABELS2;
  var init_dle_runner = __esm({
    "src/sources/dle-runner.js"() {
      init_dle_common();
      init_match();
      init_hosts();
      init_stream();
      MAX_CARDS_PER_SITE = 2;
      MIN_CARD_SCORE = 40;
      HOST_TIMEOUT_MS = 6e3;
      MAX_STREAMS_PER_SITE = 3;
      LANG_LABELS2 = { vf: "VF", vostfr: "VOSTFR", vo: "VO" };
    }
  });

  // src/sources/fstream.js
  var fstream_default;
  var init_fstream = __esm({
    "src/sources/fstream.js"() {
      init_dle_runner();
      fstream_default = {
        id: "fstream",
        label: "FStream",
        needsMeta: true,
        // recherche par titre → attend les métadonnées TMDB
        run(ctx) {
          return __async(this, null, function* () {
            return runDleSite(ctx, "fstream");
          });
        }
      };
    }
  });

  // src/sources/french-manga.js
  var french_manga_default;
  var init_french_manga = __esm({
    "src/sources/french-manga.js"() {
      init_dle_runner();
      french_manga_default = {
        id: "french-manga",
        label: "French-Manga",
        needsMeta: true,
        run(ctx) {
          return __async(this, null, function* () {
            return runDleSite(ctx, "french-manga");
          });
        }
      };
    }
  });

  // src/sources/bflix-scrape.js
  function getSecret(timeoutMs, signal, force) {
    return __async(this, null, function* () {
      if (!force && secretCache.secret && secretCache.expires > Date.now()) return secretCache.secret;
      if (!force) return DEFAULT_SECRET;
      try {
        const page = yield fetchText(VIDNEST + "/movie/550", {
          timeout: Math.min(timeoutMs, 15e3),
          headers: { "User-Agent": BROWSER_UA2 },
          signal
        });
        const chunks = [];
        let cm;
        CHUNK_RE.lastIndex = 0;
        while ((cm = CHUNK_RE.exec(page.text)) !== null) {
          if (chunks.indexOf(cm[0]) === -1) chunks.push(cm[0]);
          if (chunks.length >= 6) break;
        }
        for (const chunk of chunks) {
          try {
            const js = yield fetchText(resolveUrl(VIDNEST, chunk), {
              timeout: Math.min(timeoutMs, 15e3),
              headers: { "User-Agent": BROWSER_UA2 },
              signal
            });
            const found = SECRET_RE.exec(js.text);
            if (found) {
              secretCache = { secret: found[1], expires: Date.now() + 6 * 3600 * 1e3 };
              return secretCache.secret;
            }
          } catch (e) {
          }
        }
      } catch (e) {
      }
      return DEFAULT_SECRET;
    });
  }
  function promoteSecret(secret) {
    if (secret) secretCache = { secret, expires: Date.now() + 6 * 3600 * 1e3 };
  }
  function decryptV2(data, secret) {
    const blob = base64UrlDecode(data.d);
    const key = sha256(String(data.n || "") + "|" + secret);
    if (blob.length <= 12 + 16) throw new Error("payload vidnest trop courte");
    const ct = blob.slice(12, blob.length - 16);
    return aesGcmDecryptJson(key, blob.slice(0, 12), ct);
  }
  function vidnestGet(path, timeoutMs, signal, secretBox) {
    return __async(this, null, function* () {
      const sep = path.indexOf("?") === -1 ? "?" : "&";
      const url = API + "/" + path + sep + "_n=" + makeNonce();
      const data = yield fetchJson(url, {
        timeout: Math.min(Math.max(timeoutMs, 2e4), 3e4),
        headers: { "User-Agent": BROWSER_UA2, Referer: VIDNEST + "/", Origin: VIDNEST },
        signal
      });
      if (data && data.v === 2 && data.d) {
        try {
          const plain = decryptV2(data, secretBox.secret);
          promoteSecret(secretBox.secret);
          return plain;
        } catch (err) {
          if (secretBox.noRefresh) throw err;
          const fresh = yield getSecret(timeoutMs, signal, true);
          if (fresh && fresh !== secretBox.secret) {
            secretBox.secret = fresh;
            const plain2 = decryptV2(data, fresh);
            promoteSecret(fresh);
            return plain2;
          }
          throw err;
        }
      }
      return data;
    });
  }
  function resolveBflix(_0, _1, _2, _3) {
    return __async(this, arguments, function* (tmdbId, mediaType, season2, episode, opts = {}) {
      const timeoutMs = opts.timeout || 25e3;
      const secretBox = {
        secret: opts.noSecretRefresh ? DEFAULT_SECRET : yield getSecret(timeoutMs, opts.signal, false),
        noRefresh: !!opts.noSecretRefresh
      };
      const isTv = mediaType === "tv";
      const path = isTv ? "tv/" + tmdbId + "/" + (parseInt(season2, 10) || 1) + "/" + (parseInt(episode, 10) || 1) : "movie/" + tmdbId;
      const results = [];
      const errors = [];
      for (const server of SERVERS) {
        try {
          const got = yield vidnestGet(server + "/" + path, timeoutMs, opts.signal, secretBox);
          if (!got || typeof got !== "object") throw new Error("r\xE9ponse inattendue");
          const streams = Array.isArray(got.streams) ? got.streams : [got];
          let picked = null;
          for (const s of streams) {
            if (s && String(s.url || "").indexOf("http") === 0) {
              picked = s;
              break;
            }
          }
          if (!picked) throw new Error("aucun flux absolu pour " + path);
          const headers = picked.headers || got.headers || {};
          results.push({
            provider: server,
            url: picked.url,
            referer: headers.Referer || VIDNEST + "/",
            ua: BROWSER_UA2
          });
          if (results.length >= (opts.maxServers || 2)) break;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          errors.push(server + " : " + msg);
        }
      }
      if (!results.length) {
        throw new Error("vidnest irresolvable pour " + path + " \u2014 " + errors.join(" | "));
      }
      return results;
    });
  }
  function bflixSubtitles(_0) {
    return __async(this, arguments, function* (path, opts = {}) {
      const timeoutMs = Math.min(opts.timeout || 12e3, 12e3);
      const parts = String(path || "").split("/");
      const wyzieParams = ["id=" + encodeURIComponent(parts[1] || "")];
      if (parts[0] === "tv") {
        wyzieParams.push("season=" + encodeURIComponent(parts[2] || ""));
        wyzieParams.push("episode=" + encodeURIComponent(parts[3] || ""));
      }
      const found = [];
      const jobs = [
        (() => __async(this, null, function* () {
          const listed = yield fetchJsonSafe("https://sub.vdrk.site/v2/" + path, {
            timeout: timeoutMs,
            headers: { "User-Agent": BROWSER_UA2 },
            signal: opts.signal
          });
          if (!Array.isArray(listed)) return;
          for (const s of listed) {
            const code = VDRK_LABELS[s && s.label] || "";
            if (code && s.file) found.push({ url: s.file, lang: code, label: SUB_LABELS[code] });
          }
        }))(),
        (() => __async(this, null, function* () {
          const listed = yield fetchJsonSafe("https://vidcore.io/wyzie?" + wyzieParams.join("&"), {
            timeout: timeoutMs,
            headers: { "User-Agent": BROWSER_UA2 },
            signal: opts.signal
          });
          if (!Array.isArray(listed)) return;
          const sorted = listed.slice().sort((a, b) => (a && a.isHearingImpaired ? 1 : 0) - (b && b.isHearingImpaired ? 1 : 0));
          for (const s of sorted) {
            if (s && s.language && SUB_LABELS[s.language] && s.url) {
              found.push({ url: s.url + "#srt", lang: s.language, label: SUB_LABELS[s.language] });
            }
          }
        }))()
      ];
      yield Promise.all(jobs.map((p) => p.catch(() => null)));
      const byLang = {};
      for (const s of found) {
        if (!byLang[s.lang]) byLang[s.lang] = s;
      }
      const kept = Object.keys(byLang).map((l) => byLang[l]);
      kept.sort((a, b) => (a.lang === "fr" ? -1 : 1) - (b.lang === "fr" ? -1 : 1));
      return kept;
    });
  }
  var VIDNEST, API, BROWSER_UA2, DEFAULT_SECRET, SECRET_RE, CHUNK_RE, SERVERS, SUB_LABELS, VDRK_LABELS, secretCache;
  var init_bflix_scrape = __esm({
    "src/sources/bflix-scrape.js"() {
      init_http();
      init_text();
      init_crypto();
      VIDNEST = "https://vidnest.fun";
      API = "https://new.vidnest.fun";
      BROWSER_UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      DEFAULT_SECRET = "K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2";
      SECRET_RE = /"([A-Za-z0-9_-]{32,})",\w+="https:\/\/new\.vidnest\.fun"/;
      CHUNK_RE = /\/_next\/static\/chunks\/[\w.-]+\.js/g;
      SERVERS = ["flixhq", "nextgencloudfabric", "rpmvid", "ophim"];
      SUB_LABELS = { fr: "Fran\xE7ais", en: "English" };
      VDRK_LABELS = { French: "fr", English: "en" };
      secretCache = { secret: "", expires: 0 };
    }
  });

  // src/sources/bflix.js
  var bflix_default;
  var init_bflix = __esm({
    "src/sources/bflix.js"() {
      init_bflix_scrape();
      init_stream();
      bflix_default = {
        id: "bflix",
        label: "BFlix",
        needsMeta: false,
        run(ctx) {
          return __async(this, null, function* () {
            const { cfg, signal, push, tmdbId, mediaType, season: season2, episode } = ctx;
            if (cfg.language === "vf" && !cfg.allowOtherLang) return;
            const isTv = mediaType === "tv";
            const s = parseInt(season2, 10) || 1;
            const e = parseInt(episode, 10) || 1;
            const path = isTv ? "tv/" + tmdbId + "/" + s + "/" + e : "movie/" + tmdbId;
            let resolved;
            try {
              resolved = yield resolveBflix(tmdbId, mediaType, isTv ? s : 0, isTv ? e : 0, {
                timeout: cfg.timeoutMs,
                signal
              });
            } catch (err) {
              console.warn("[bflix] \xE9chou\xE9 : " + (err && err.message ? err.message : err));
              return;
            }
            if (!resolved.length) return;
            let subs = [];
            try {
              subs = yield bflixSubtitles(path, { timeout: cfg.timeoutMs, signal });
            } catch (err) {
            }
            const nuvioSubs = subs.map((sub) => {
              const track = {
                url: sub.url,
                title: sub.label || String(sub.lang || "").toUpperCase(),
                lang: sub.lang === "fr" ? "fre" : sub.lang
              };
              if (sub.lang === "fr") track.default = true;
              return track;
            });
            const hasFr = subs.some((x) => x.lang === "fr");
            const langKey = hasFr ? "vostfr" : "vo";
            const langLabel3 = hasFr ? "VOSTFR" : "VO";
            for (const r of resolved) {
              const kind = /\.m3u8(\?|$)/i.test(String(r.url || "")) ? "HLS" : "MP4";
              const headers = {};
              if (r.referer) headers.Referer = r.referer;
              if (r.ua) headers["User-Agent"] = r.ua;
              if (r.provider !== "flixhq") headers.Origin = "https://vidnest.fun";
              push(
                makeStream({
                  title: `BFlix \xB7 ${r.provider} \xB7 ${kind} \xB7 ${langLabel3}`,
                  url: r.url,
                  quality: kind === "HLS" ? "Auto (HLS)" : "Direct",
                  language: langLabel3,
                  headers,
                  subtitles: nuvioSubs,
                  _langKey: langKey,
                  _site: "bflix"
                })
              );
            }
          });
        }
      };
    }
  });

  // src/sources/papadustream.js
  function run(ctx) {
    return __async(this, null, function* () {
      const { cfg, signal, push, shouldStop } = ctx;
      const isTv = ctx.mediaType === "tv";
      let imdbId = yield getImdbId(ctx.tmdbId, ctx.mediaType, {
        timeout: cfg.timeoutMs,
        signal
      });
      if (!imdbId) {
        imdbId = yield resolveByTitle(ctx);
      }
      if (!imdbId) {
        console.log("[papa] IMDb introuvable pour TMDB " + ctx.tmdbId);
        return;
      }
      const pagePath = isTv ? "/series/" + imdbId : "/films/" + imdbId;
      const cacheKey = "page_" + imdbId + (isTv ? "_tv" : "_mv");
      let html = yield cachedPage(cacheKey, pagePath, cfg, signal, false);
      if (!html) {
        console.log("[papa] page inaccessible : " + pagePath);
        return;
      }
      if (isTv) {
        let candidates = parseEpisodesJson(html);
        if (!candidates.length) candidates = extractHlsUrls(html);
        const targetSeason = parseInt(ctx.season, 10) || 1;
        const targetEp = parseInt(ctx.episode, 10) || 1;
        const selected = candidates.filter(
          (c) => c.season === targetSeason && c.episode === targetEp
        );
        if (!selected.length) {
          const avail = candidates.filter((c) => c.season === targetSeason).map((c) => "E" + c.episode).slice(0, 20).join(" ");
          console.log(
            `[papa] pas de S${targetSeason}E${targetEp} \u2014 dispos sur le site : ${avail || "aucun"}`
          );
          return;
        }
        for (const ep of selected) {
          if (shouldStop()) break;
          const title = yield emitForUrl(ctx, ep.url, ep, imdbId, cacheKey, pagePath);
          if (title) push(title);
        }
      } else {
        const movieUrl = extractMovieHlsUrl(html, imdbId);
        if (!movieUrl) {
          console.log("[papa] pas de HLS film pour " + imdbId);
          return;
        }
        const st = yield emitForUrl(ctx, movieUrl, null, imdbId, cacheKey, pagePath);
        if (st) push(st);
      }
    });
  }
  function emitForUrl(ctx, hlsUrl, epInfo, imdbId, cacheKey, pagePath) {
    return __async(this, null, function* () {
      const { cfg, signal, shouldStop } = ctx;
      const probe = yield probeMaster(hlsUrl, cfg, signal);
      let finalUrl = hlsUrl;
      let langs = probe.langs;
      let ok = probe.ok;
      if (!ok && !shouldStop()) {
        console.log("[papa] token HLS expir\xE9, refresh de la page");
        const freshHtml = yield cachedPage(cacheKey, pagePath, cfg, signal, true);
        let freshList = freshHtml ? parseEpisodesJson(freshHtml) : [];
        if (!freshList.length && freshHtml) freshList = extractHlsUrls(freshHtml);
        let freshUrl = null;
        if (epInfo) {
          const freshEp = freshList.find(
            (c) => c.season === epInfo.season && c.episode === epInfo.episode
          );
          freshUrl = freshEp ? freshEp.url : null;
        } else {
          freshUrl = extractMovieHlsUrl(freshHtml || "", imdbId);
        }
        if (!freshUrl) return null;
        const probe2 = yield probeMaster(freshUrl, cfg, signal);
        if (!probe2.ok) return null;
        finalUrl = freshUrl;
        langs = probe2.langs;
        ok = true;
      }
      if (!ok) return null;
      const hasFr = langs.size === 0 || langs.has("fr");
      const hasEn = langs.size > 0 && langs.has("en");
      let absUrl = finalUrl.startsWith("http") ? finalUrl : BASE_URL_WWW + finalUrl;
      absUrl = absUrl.replace("https://papadustream.club", BASE_URL_WWW);
      const label = {
        site: "Papadustream",
        episode: epInfo ? epInfo.episode : 0,
        host: "HLS",
        url: absUrl
      };
      if (hasFr) {
        return makeStream({
          title: composeTitle(__spreadProps(__spreadValues({}, label), { lang: "VF" })),
          url: absUrl,
          quality: "Auto (HLS)",
          language: "VF",
          _langKey: "vf",
          _site: "papadustream"
        });
      }
      if (hasEn) {
        return makeStream({
          title: composeTitle(__spreadProps(__spreadValues({}, label), { lang: "VO" })),
          url: absUrl,
          quality: "Auto (HLS)",
          language: "VO",
          _langKey: "vo",
          _site: "papadustream"
        });
      }
      return null;
    });
  }
  function cachedPage(cacheKey, path, cfg, signal, bypass) {
    return __async(this, null, function* () {
      if (!bypass) {
        const hit = pageCache.get(cacheKey);
        if (hit) return hit;
      } else {
        pageCache.set(cacheKey, null, 1);
      }
      for (const domain of DOMAINS) {
        if (signal && signal.aborted) return null;
        try {
          const res = yield fetchText("https://" + domain + path, {
            timeout: Math.min(cfg.timeoutMs, 12e3),
            headers: __spreadProps(__spreadValues({}, PAGE_HEADERS), { Referer: "https://" + domain + "/", Origin: "https://" + domain }),
            signal
          });
          pageCache.set(cacheKey, res.text, PAGE_TTL_MS);
          return res.text;
        } catch (err) {
          const status = err && err.status ? err.status : 0;
          if (status === 404) return null;
          continue;
        }
      }
      return null;
    });
  }
  function probeMaster(url, cfg, signal) {
    return __async(this, null, function* () {
      const langs = /* @__PURE__ */ new Set();
      try {
        const res = yield fetchText(url, {
          timeout: 8e3,
          headers: __spreadValues({}, PAGE_HEADERS),
          signal
        });
        if (!res.text || res.text.indexOf("#EXTM3U") === -1) return { ok: false, langs };
        const langRe = /LANGUAGE="([A-Za-z-]+)"/;
        const lines = res.text.split("\n");
        for (const line of lines) {
          if (line.indexOf("TYPE=AUDIO") === -1) continue;
          const m = langRe.exec(line);
          if (m) langs.add(m[1].toLowerCase().split("-")[0]);
        }
        return { ok: true, langs };
      } catch (e) {
        return { ok: false, langs };
      }
    });
  }
  function parseEpisodesJson(html) {
    if (!html) return [];
    const marker = "EPISODES=[";
    const start = html.indexOf(marker);
    if (start === -1) return [];
    const slice = html.slice(start + marker.length - 1);
    const end = slice.indexOf("];");
    const raw = end !== -1 ? slice.slice(0, end + 1) : null;
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (const e of arr) {
        if (e && typeof e.url === "string" && e.url.indexOf("/hls/") !== -1 && Number.isFinite(Number(e.season)) && Number.isFinite(Number(e.episode))) {
          out.push({
            url: e.url,
            title: typeof e.title === "string" ? e.title : "",
            season: Number(e.season),
            episode: Number(e.episode)
          });
        }
      }
      return out;
    } catch (e) {
      console.warn("[papa] JSON EPISODES invalide : " + (e && e.message ? e.message : e));
      return [];
    }
  }
  function extractHlsUrls(html) {
    if (!html) return [];
    const results = [];
    const re = new RegExp(HLS_SERIAL_RE.source, "g");
    let match;
    while ((match = re.exec(html)) !== null) {
      results.push({
        url: match[0],
        title: "",
        season: parseInt(match[1], 10),
        episode: parseInt(match[2], 10)
      });
    }
    return results;
  }
  function extractMovieHlsUrl(html, imdbId) {
    if (!html) return null;
    const re = new RegExp(HLS_MOVIE_RE.source, "g");
    let match;
    while ((match = re.exec(html)) !== null) {
      if (!imdbId || match[0].indexOf("/" + imdbId + "/") !== -1) return match[0];
    }
    return null;
  }
  function resolveByTitle(ctx) {
    return __async(this, null, function* () {
      const { cfg, signal } = ctx;
      let meta = null;
      try {
        meta = yield ctx.meta;
      } catch (e) {
        meta = null;
      }
      if (!meta || !meta.titles.length) return "";
      const kindSeg = ctx.mediaType === "tv" ? "series" : "films";
      const re = new RegExp("/(?:" + kindSeg + ")\\/(tt\\d+)", "g");
      for (const title of meta.titles.slice(0, 2)) {
        for (const domain of DOMAINS) {
          if (signal && signal.aborted) return "";
          try {
            const r = yield fetchText(
              "https://" + domain + "/search?q=" + encodeURIComponent(title),
              {
                timeout: Math.min(cfg.timeoutMs, 12e3),
                headers: __spreadProps(__spreadValues({}, PAGE_HEADERS), { Referer: "https://" + domain + "/" }),
                signal
              }
            );
            const m = re.exec(r.text);
            re.lastIndex = 0;
            if (m) {
              console.log("[papa] recherche titre \xAB " + title + " \xBB \u2192 " + m[1]);
              return m[1];
            }
            break;
          } catch (e) {
            continue;
          }
        }
      }
      return "";
    });
  }
  var DOMAINS, BASE_URL_WWW, PAGE_HEADERS, HLS_SERIAL_RE, HLS_MOVIE_RE, pageCache, PAGE_TTL_MS, papadustream_default;
  var init_papadustream = __esm({
    "src/sources/papadustream.js"() {
      init_http();
      init_tmdb();
      init_stream();
      DOMAINS = ["papadustream.club", "www.papadustream.club", "papadustreami.living"];
      BASE_URL_WWW = "https://www.papadustream.club";
      PAGE_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"
      };
      HLS_SERIAL_RE = /\/hls\/(?:p\/\d+\/[A-Za-z0-9_-]+\/)?s\d+\/serial\/tt\d+\/(\d+)\/(\d+)\/playlist\.m3u8/g;
      HLS_MOVIE_RE = /\/hls\/(?:p\/\d+\/[A-Za-z0-9_-]+\/)?s\d+\/movie\/tt\d+\/playlist\.m3u8/g;
      pageCache = createTtlCache(20);
      PAGE_TTL_MS = 5 * 60 * 1e3;
      papadustream_default = {
        id: "papadustream",
        label: "Papadustream",
        needsMeta: false,
        // IMDb résolu par tmdbId ; fallback titre utilise meta si dispo
        run(ctx) {
          return __async(this, null, function* () {
            try {
              yield run(ctx);
            } catch (err) {
              console.warn("[papa] \xE9chou\xE9 : " + (err && err.message ? err.message : err));
            }
          });
        }
      };
    }
  });

  // src/sources/webflix.js
  function run2(ctx) {
    return __async(this, null, function* () {
      const { cfg, signal, push, shouldStop } = ctx;
      const isTv = ctx.mediaType === "tv";
      const s = parseInt(ctx.season, 10) || 1;
      const e = parseInt(ctx.episode, 10) || 1;
      if (isTv) {
        const disc = yield discovery(ctx.tmdbId, cfg, signal);
        const entry = disc && disc[s + "-" + e];
        if (entry && entry.url && typeof entry.url === "string") {
          console.log("[webflix] discovery direct S" + s + "E" + e);
          const langKey = yield langKeyFor(ctx, entry.url, entry.language);
          push(directStream(ctx, entry.url, "Discovery", langKey, e));
          if (String(entry.url).indexOf("/animes/VF/") !== -1) {
            const vost = buildVostfrMirror(entry.url);
            if (vost) push(directStream(ctx, vost, "Discovery", "vostfr", e));
          }
          return;
        }
        const ff = yield fastfluxEpisode(ctx.tmdbId, s, e, cfg, signal);
        if (ff && ff.url) {
          console.log("[webflix] fastflux direct S" + s + "E" + e);
          const langKey = yield langKeyFor(ctx, ff.url, ff.language);
          push(directStream(ctx, ff.url, "FastFlux", langKey, e));
          if (String(ff.url).indexOf("/animes/VF/") !== -1) {
            const vost = buildVostfrMirror(ff.url);
            if (vost) push(directStream(ctx, vost, "FastFlux", "vostfr", e));
          }
          return;
        }
      } else {
        const ff = yield fastfluxMovie(ctx.tmdbId, cfg, signal);
        if (ff && ff.url) {
          console.log("[webflix] fastflux direct film");
          const langKey = yield langKeyFor(ctx, ff.url, ff.language);
          push(directStream(ctx, ff.url, "FastFlux", langKey, 0));
          return;
        }
      }
      if (shouldStop()) return;
      const embeds = buildTmdbEmbeds(ctx.tmdbId, isTv, s, e);
      let count = 0;
      let attempts = 0;
      for (const emb of embeds) {
        if (shouldStop() || count >= MAX_STREAMS || attempts >= MAX_EMBEDS_TO_TRY) break;
        attempts++;
        try {
          if (emb.url.indexOf("fluxora.sbs/embed/zenix") !== -1) {
            count += yield resolveZenix(ctx, emb, push);
          } else {
            count += yield resolveEmbedPage(ctx, emb, push);
          }
        } catch (err) {
          console.log(
            "[webflix] " + emb.source + " \xE9chou\xE9 : " + (err && err.message ? err.message : err)
          );
        }
      }
    });
  }
  function fastfluxMovie(tmdbId, cfg, signal) {
    return __async(this, null, function* () {
      try {
        const data = yield fetchJson(
          SITE + "/api/fastflux?type=movie&tmdb_id=" + encodeURIComponent(tmdbId),
          { timeout: TIMEOUTS.FASTFLUX, headers: HEADERS2, signal }
        );
        if (!data || data.success !== true || data.available !== true) return null;
        return data.data && data.data.url ? data.data : null;
      } catch (e) {
        return null;
      }
    });
  }
  function fastfluxEpisode(tmdbId, season2, episode, cfg, signal) {
    return __async(this, null, function* () {
      try {
        const data = yield fetchJson(
          SITE + "/api/fastflux?type=episode&tmdb_id=" + encodeURIComponent(tmdbId) + "&season=" + season2 + "&episode=" + episode,
          { timeout: TIMEOUTS.FASTFLUX, headers: HEADERS2, signal }
        );
        if (!data || data.success !== true || data.available !== true) return null;
        return data.data && data.data.url ? data.data : null;
      } catch (e) {
        return null;
      }
    });
  }
  function discovery(tmdbId, cfg, signal) {
    return __async(this, null, function* () {
      try {
        const data = yield fetchJson(
          SITE + "/api/series-season-discovery?tmdb_id=" + encodeURIComponent(tmdbId),
          { timeout: TIMEOUTS.DISCOVERY, headers: HEADERS2, signal }
        );
        if (!data || data.success !== true || !data.fastflux) return null;
        return data.fastflux;
      } catch (e) {
        return null;
      }
    });
  }
  function buildTmdbEmbeds(tmdbId, isTv, s, e) {
    const id = encodeURIComponent(tmdbId);
    const out = [];
    if (!isTv) {
      out.push({ url: "https://fluxora.sbs/embed/zenix?tmdb=" + id + "&type=movie&season=&episode=&lang=vf", lang: "vf", source: "Zenix" });
      out.push({ url: "https://fluxora.sbs/embed/zenix?tmdb=" + id + "&type=movie&season=&episode=&lang=vostfr", lang: "vostfr", source: "Zenix" });
      out.push({ url: "https://frembed.cyou/api/film.php?id=" + id, lang: "vf", source: "Frembed" });
    } else {
      out.push({ url: "https://fluxora.sbs/embed/zenix?tmdb=" + id + "&type=tv&season=" + s + "&episode=" + e + "&lang=vf", lang: "vf", source: "Zenix" });
      out.push({ url: "https://fluxora.sbs/embed/zenix?tmdb=" + id + "&type=tv&season=" + s + "&episode=" + e + "&lang=vostfr", lang: "vostfr", source: "Zenix" });
      out.push({ url: "https://frembed.cyou/api/serie.php?id=" + id + "&sa=" + s + "&ep=" + e, lang: "vf", source: "Frembed" });
    }
    return out;
  }
  function resolveEmbedPage(ctx, emb, push) {
    return __async(this, null, function* () {
      const { cfg, signal, shouldStop } = ctx;
      let html;
      try {
        const res = yield fetchText(emb.url, {
          timeout: TIMEOUTS.EMBED,
          headers: __spreadProps(__spreadValues({}, HEADERS2), { Accept: "text/html,*/*", Referer: SITE + "/" }),
          signal
        });
        html = res.text;
      } catch (e) {
        return 0;
      }
      if (!html || isCfBlock(html)) return 0;
      const found = extractStreamUrls(html, emb.url);
      if (!found.length) return 0;
      let count = 0;
      const iframes = [];
      for (const u of found) {
        if (shouldStop() || count >= MAX_STREAMS) break;
        if (/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) {
          push(directStream(ctx, u, emb.source, emb.lang, ctx.mediaType === "tv" ? ctx.episode : 0));
          count++;
        } else if (providerFromEmbedUrl(u)) {
          iframes.push(u);
        }
      }
      if (iframes.length && count < MAX_STREAMS && !shouldStop()) {
        const map = {};
        for (const u of iframes) {
          const p = providerFromEmbedUrl(u);
          if (p && !map[p]) map[p] = u;
        }
        if (Object.keys(map).length) {
          let resolved = [];
          try {
            resolved = yield resolveEmbeds(map, {
              timeout: 6e3,
              // < échéance douce 9 s : un host qui pend ne mange pas la fenêtre
              signal,
              maxResults: 2,
              maxAttempts: 4
            });
          } catch (e) {
            resolved = [];
          }
          for (const r of resolved) {
            if (count >= MAX_STREAMS) break;
            push(
              makeStream({
                title: composeTitle({
                  site: emb.source,
                  episode: ctx.mediaType === "tv" ? parseInt(ctx.episode, 10) || 0 : 0,
                  host: r.provider,
                  url: r.url,
                  lang: langLabel2(emb.lang)
                }),
                url: r.url,
                quality: /\.m3u8(\?|$)/i.test(String(r.url || "")) ? "Auto (HLS)" : "Direct",
                language: langLabel2(emb.lang),
                headers: buildHeaders2(r.referer, r.ua),
                subtitles: (r.subtitles || []).map((sub) => ({
                  url: sub.url,
                  title: sub.label || String(sub.lang || "").toUpperCase(),
                  lang: sub.lang || "fre"
                })),
                _weakPlayer: r.weakPlayer === true,
                _langKey: emb.lang,
                _site: "webflix"
              })
            );
            count++;
          }
        }
      }
      return count;
    });
  }
  function resolveZenix(ctx, emb, push) {
    return __async(this, null, function* () {
      const { cfg, signal, shouldStop } = ctx;
      try {
        const res = yield fetchText(emb.url, {
          timeout: TIMEOUTS.EMBED,
          headers: __spreadProps(__spreadValues({}, HEADERS2), { Accept: "text/html,*/*", Referer: SITE + "/" }),
          signal
        });
        const html = res.text;
        if (!html || isCfBlock(html)) return 0;
        const sid = (String(html).match(/const SID\s*=\s*"([^"]{4,80})"/) || [])[1];
        if (!sid) return 0;
        if (shouldStop()) return 0;
        const langParam = emb.lang === "vostfr" ? "vostfr" : "vf";
        let play = null;
        try {
          play = yield fetchJson(FLUXORA_ORIGIN + "/api/embed-player/play", {
            method: "POST",
            timeout: 1e4,
            headers: __spreadProps(__spreadValues({}, HEADERS2), {
              Referer: emb.url,
              Origin: FLUXORA_ORIGIN,
              "Content-Type": "application/json"
            }),
            body: { sid, lang: langParam, embed_mobile: 0 },
            signal
          });
        } catch (e) {
          play = null;
        }
        if (!play || play.ok !== true || !play.stream_url) return 0;
        if (shouldStop()) return 0;
        const pageRes = yield fetchText(play.stream_url, {
          timeout: TIMEOUTS.EMBED,
          headers: __spreadProps(__spreadValues({}, HEADERS2), { Accept: "text/html,*/*", Referer: emb.url }),
          signal
        });
        const playerHtml = pageRes.text;
        if (!playerHtml || isCfBlock(playerHtml)) return 0;
        const urls = extractStreamUrls(playerHtml, play.stream_url);
        let count = 0;
        for (const u of urls) {
          if (count >= MAX_STREAMS || shouldStop()) break;
          if (/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) {
            push(directStream(ctx, u, "Zenix", emb.lang, ctx.mediaType === "tv" ? ctx.episode : 0));
            count++;
          }
        }
        return count;
      } catch (e) {
        return 0;
      }
    });
  }
  function extractStreamUrls(html, baseUrl) {
    const out = [];
    const push2 = (u) => {
      if (!u || typeof u !== "string") return;
      const clean = u.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
      if (/^https?:\/\//i.test(clean) && out.indexOf(clean) === -1) out.push(clean);
    };
    const raw = String(html || "");
    try {
      const m = raw.match(/videoUrl\s*=\s*(?:window\.ZenixCdnDirect\s*\?\s*window\.ZenixCdnDirect\.prepare\s*\(\s*)?"([^"]{20,600})"/i);
      if (m && /^https?:\/\//i.test(m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/"))) {
        push2(m[1]);
      }
    } catch (e) {
    }
    try {
      const marker = "stream.fluxora.sbs/v1/";
      let idx = raw.indexOf(marker);
      while (idx !== -1) {
        const start = raw.lastIndexOf('"', idx);
        const end = raw.indexOf('"', idx);
        if (start !== -1 && end !== -1 && end > idx + marker.length && end - start < 600) {
          const cleaned = raw.slice(start + 1, end).replace(/\\u0026/g, "&").replace(/\\\//g, "/");
          if (/^https:\/\/stream\.fluxora\.sbs\/v1\/[^\s"]+$/.test(cleaned)) push2(cleaned);
        }
        idx = raw.indexOf(marker, idx + 1);
      }
    } catch (e) {
    }
    try {
      const arrRe = /urls\s*=\s*\[([^\]]{0,4000})\]/g;
      let m;
      while ((m = arrRe.exec(raw)) !== null) {
        const qRe = /"((?:[^"\\]|\\.)*)"/g;
        let q;
        while ((q = qRe.exec(m[1])) !== null) push2(q[1]);
      }
    } catch (e) {
    }
    try {
      const ifrRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
      let m;
      while ((m = ifrRe.exec(raw)) !== null) {
        const src = m[1];
        if (src && !/^about:blank/i.test(src) && !/^javascript:/i.test(src) && !/^data:/i.test(src)) {
          try {
            push2(resolveUrl(baseUrl, src));
          } catch (e) {
            push2(src);
          }
        }
      }
    } catch (e) {
    }
    try {
      const loose = raw.match(/https?:\/\/[^"'\\\s]+\.(?:m3u8|mp4)[^"'\\\s]*/gi) || [];
      for (const u of loose) push2(u);
    } catch (e) {
    }
    return out;
  }
  function isCfBlock(text) {
    if (!text || typeof text !== "string") return false;
    return text.indexOf("Just a moment") !== -1 || text.indexOf("challenge-platform") !== -1 || text.indexOf("cf-browser-verification") !== -1 || text.indexOf("error code: 1010") !== -1;
  }
  function langKeyFor(ctx, url, apiLang) {
    return __async(this, null, function* () {
      const raw = String(apiLang || "").toUpperCase();
      if (raw.indexOf("VOSTFR") !== -1) return "vostfr";
      if (raw === "VF" || raw === "FR") return "vf";
      if (raw === "VO" || raw === "EN" || raw === "ENGLISH") return "vo";
      if (String(url).indexOf("/animes/VF/") !== -1) return "vf";
      if (String(url).indexOf("/animes/VOSTFR/") !== -1) return "vostfr";
      let meta = null;
      try {
        meta = yield ctx.meta;
      } catch (e) {
        meta = null;
      }
      const orig = meta && meta.originalLanguage ? meta.originalLanguage : "";
      return orig && orig !== "fr" ? "vo" : "vf";
    });
  }
  function buildVostfrMirror(url) {
    const vost = String(url || "").replace("/animes/VF/", "/animes/VOSTFR/");
    return vost !== url ? vost : null;
  }
  function langLabel2(key) {
    return key === "vostfr" ? "VOSTFR" : key === "vo" ? "VO" : "VF";
  }
  function buildHeaders2(referer, ua) {
    const headers = {};
    if (referer) headers.Referer = referer;
    if (ua) headers["User-Agent"] = ua;
    return headers;
  }
  function directStream(ctx, url, source, langKey, episode) {
    const kind = /\.m3u8(\?|$)/i.test(String(url || "")) ? "HLS" : "MP4";
    return makeStream({
      title: composeTitle({
        site: "Webflix",
        episode: parseInt(episode, 10) || 0,
        host: source,
        url,
        lang: langLabel2(langKey)
      }),
      url,
      quality: kind === "HLS" ? "Auto (HLS)" : "Direct",
      language: langLabel2(langKey),
      headers: {
        "User-Agent": HEADERS2["User-Agent"],
        Accept: "*/*",
        "Accept-Language": HEADERS2["Accept-Language"],
        Referer: SITE + "/"
      },
      _langKey: langKey,
      _site: "webflix"
    });
  }
  var SITE, HEADERS2, TIMEOUTS, MAX_EMBEDS_TO_TRY, MAX_STREAMS, FLUXORA_ORIGIN, webflix_default;
  var init_webflix = __esm({
    "src/sources/webflix.js"() {
      init_http();
      init_hosts();
      init_stream();
      SITE = "https://webflix.art";
      HEADERS2 = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        Origin: SITE,
        Referer: SITE + "/"
      };
      TIMEOUTS = { FASTFLUX: 1e4, DISCOVERY: 12e3, EMBED: 1e4 };
      MAX_EMBEDS_TO_TRY = 4;
      MAX_STREAMS = 4;
      FLUXORA_ORIGIN = "https://fluxora.sbs";
      webflix_default = {
        id: "webflix",
        label: "Webflix",
        needsMeta: false,
        // tout est résolu par tmdbId
        run(ctx) {
          return __async(this, null, function* () {
            try {
              yield run2(ctx);
            } catch (err) {
              console.warn("[webflix] \xE9chou\xE9 : " + (err && err.message ? err.message : err));
            }
          });
        }
      };
    }
  });

  // src/core/registry.js
  function resolveSources(cfg) {
    const wanted = String(cfg.sources || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!wanted.length) return ALL_SOURCES.slice();
    return ALL_SOURCES.filter((s) => wanted.indexOf(s.id) !== -1);
  }
  var ALL_SOURCES, KNOWN_IDS;
  var init_registry = __esm({
    "src/core/registry.js"() {
      init_fstream();
      init_french_manga();
      init_bflix();
      init_papadustream();
      init_webflix();
      ALL_SOURCES = [fstream_default, french_manga_default, bflix_default, papadustream_default, webflix_default];
      KNOWN_IDS = ALL_SOURCES.map((s) => s.id);
    }
  });

  // src/core/plan.js
  function kindOf(mediaType, isAnimeHint) {
    if (isAnimeHint && mediaType === "tv") return "anime";
    return mediaType === "tv" ? "tv" : "movie";
  }
  function affinityOf(sourceId, kind) {
    const a = AFFINITY[sourceId];
    if (!a) return 2;
    return a[kind] !== void 0 ? a[kind] : 2;
  }
  function buildPlan(sourceIds, kind) {
    const ids = Array.isArray(sourceIds) ? sourceIds.slice() : [];
    if (!ids.length) return { wave1: [], wave2: [] };
    const scored = ids.map((id) => ({ id, a: affinityOf(id, kind) }));
    scored.sort((x, y) => y.a - x.a);
    const wave1 = scored.filter((x) => x.a >= 2).map((x) => x.id);
    const wave2 = scored.filter((x) => x.a === 1).map((x) => x.id);
    return { wave1, wave2 };
  }
  var AFFINITY;
  var init_plan = __esm({
    "src/core/plan.js"() {
      AFFINITY = {
        "french-manga": { anime: 3, movie: 1, tv: 1, generic: 2 },
        fstream: { anime: 1, movie: 3, tv: 3, generic: 2 },
        bflix: { anime: 2, movie: 2, tv: 2, generic: 2 },
        papadustream: { anime: 1, movie: 2, tv: 2, generic: 2 },
        webflix: { anime: 2, movie: 2, tv: 2, generic: 2 }
      };
    }
  });

  // src/core/stopper.js
  function createStopper({ startedAt, hardMs, softMs }) {
    const hard = hardMs > 0 ? hardMs : 25e3;
    const soft = softMs > 0 ? softMs : SOFT_MS;
    const softAt = startedAt + soft;
    const hardAt = startedAt + hard;
    function elapsedMs() {
      return Date.now() - startedAt;
    }
    function shouldStop() {
      return Date.now() >= hardAt;
    }
    function softElapsed() {
      return Date.now() >= softAt;
    }
    function goodEnough(streams, cfg) {
      if (!softElapsed()) return false;
      const relevantLangs = cfg.allowOtherLang ? cfg.fallbackLangs : cfg.fallbackLangs.slice(0, 1);
      for (const s of streams || []) {
        if (s && s.url && relevantLangs.indexOf(s._langKey) !== -1) return true;
      }
      return false;
    }
    return {
      elapsedMs,
      shouldStop,
      softElapsed,
      goodEnough,
      softMs: soft,
      hardMs: hard
    };
  }
  function raceEarlyExit({ stopper, collected, cfg, allDone, onEnough }) {
    if (typeof setTimeout !== "function") {
      return allDone.then(() => "done");
    }
    return new Promise((resolve2) => {
      let settled = false;
      let timer = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        try {
          clearTimeout(timer);
        } catch (e) {
        }
        resolve2(value);
      };
      const poll = () => {
        if (stopper.shouldStop()) return settle("budget");
        if (stopper.goodEnough(collected, cfg)) {
          if (typeof onEnough === "function") {
            try {
              onEnough();
            } catch (e) {
            }
          }
          return settle("enough");
        }
        try {
          timer = setTimeout(poll, 250);
        } catch (e) {
          settle("done");
        }
      };
      poll();
      allDone.then(() => settle("done")).catch(() => settle("done"));
    });
  }
  function makeSourceShouldStop(stopper, collected, cfg) {
    return function sourceShouldStop() {
      if (stopper.shouldStop()) return true;
      try {
        return stopper.softElapsed() && stopper.goodEnough(collected, cfg);
      } catch (e) {
        return false;
      }
    };
  }
  var SOFT_MS;
  var init_stopper = __esm({
    "src/core/stopper.js"() {
      SOFT_MS = 5e3;
    }
  });

  // src/bridge/sestudio.js
  function joinUrl(base, path) {
    return base.replace(/\/+$/, "") + path;
  }
  function checkHealth(base, timeoutMs, signal) {
    return __async(this, null, function* () {
      const hit = healthCache.get(base);
      const now = Date.now();
      if (hit && hit.expires > now) return hit.ok;
      try {
        yield fetchJson(joinUrl(base, "/api/sites"), { timeout: Math.min(timeoutMs, 8e3), signal });
        healthCache.set(base, { ok: true, expires: now + HEALTH_TTL_MS });
        return true;
      } catch (err) {
        healthCache.set(base, { ok: false, expires: now + 30 * 1e3 });
        return false;
      }
    });
  }
  function search(base, query, sites, timeoutMs, signal) {
    return __async(this, null, function* () {
      const key = [base, query.toLowerCase(), sites || ""].join("|");
      const cached = searchCache2.get(key);
      if (cached) return cached;
      const params = ["q=" + encodeURIComponent(query)];
      if (sites) params.push("sites=" + encodeURIComponent(sites));
      const url = joinUrl(base, "/api/search?" + params.join("&"));
      const data = yield fetchJson(url, { timeout: timeoutMs, signal });
      const result = {
        cards: (data && Array.isArray(data.cards) ? data.cards : []).filter((c) => c && c.page_url),
        sources: data && data.sources || []
      };
      if (result.cards.length) searchCache2.set(key, result, SEARCH_TTL_MS2);
      return result;
    });
  }
  function season(base, pageUrl, lang, source, timeoutMs, signal) {
    return __async(this, null, function* () {
      const key = [base, pageUrl, lang, source || ""].join("|");
      const cached = seasonCache.get(key);
      if (cached) return cached;
      const params = [
        "url=" + encodeURIComponent(pageUrl),
        "lang=" + encodeURIComponent(lang || "vf")
      ];
      if (source) params.push("source=" + encodeURIComponent(source));
      const url = joinUrl(base, "/api/season?" + params.join("&"));
      const data = yield fetchJson(url, { timeout: timeoutMs, signal });
      const page = {
        season: parseInt(data && data.season, 10) || 0,
        is_film: !!(data && data.is_film),
        available_langs: data && data.available_langs || [],
        source: data && data.source || source || "",
        episodes: data && data.episodes || []
      };
      if (page.episodes.length) seasonCache.set(key, page, SEASON_TTL_MS);
      return page;
    });
  }
  function resolve(base, embedUrls, source, timeoutMs, signal, preferKind) {
    return __async(this, null, function* () {
      if (!embedUrls || !Object.keys(embedUrls).length) return null;
      const body = {
        embed_urls: embedUrls,
        source: source || "fstream"
      };
      if (preferKind) body.prefer_kind = preferKind;
      try {
        const data = yield fetchJson(joinUrl(base, "/api/stream/resolve"), {
          method: "POST",
          body,
          timeout: Math.max(timeoutMs, 3e4),
          signal,
          headers: { "Content-Type": "application/json" }
        });
        return data || null;
      } catch (err) {
        if (err instanceof HttpError && err.status === 502) return null;
        throw err;
      }
    });
  }
  function toNuvioStream(resolved, card, ep, base, ctx) {
    if (!resolved || !resolved.proxy_url) return null;
    const relUrl = ctx.useTranscode && resolved.transcode_url ? resolved.transcode_url : resolved.proxy_url;
    const url = joinUrl(base, relUrl);
    const kind = resolved.kind === "hls" ? "HLS" : "MP4";
    const quality = ctx.useTranscode ? "Auto (transcod\xE9)" : kind === "HLS" ? "Auto (HLS)" : "Direct";
    const langTag = String(ctx.lang || "").toUpperCase();
    const epLabel = !ctx.isFilm && ep && Number.isFinite(ep.number) && ep.number > 0 ? ` \xB7 E${String(ep.number).padStart(2, "0")}` : "";
    const siteLabel = (ctx.sourceName || card.source || "sestudio").replace(/-/g, " ");
    const stream = {
      name: "sestudio",
      title: `${siteLabel}${epLabel} \xB7 ${resolved.provider || "host"} \xB7 ${quality} \xB7 ${langTag}`,
      url,
      quality,
      language: langTag,
      headers: {}
    };
    if (Array.isArray(resolved.subtitles) && resolved.subtitles.length) {
      stream.subtitles = resolved.subtitles.filter((s) => s && s.proxy_url).map((s) => ({
        url: joinUrl(base, s.proxy_url),
        title: s.label || String(s.lang || "").toUpperCase(),
        lang: String(s.lang || "fre")
      }));
    }
    return stream;
  }
  var HEALTH_TTL_MS, SEARCH_TTL_MS2, SEASON_TTL_MS, healthCache, searchCache2, seasonCache;
  var init_sestudio = __esm({
    "src/bridge/sestudio.js"() {
      init_http();
      HEALTH_TTL_MS = 5 * 60 * 1e3;
      SEARCH_TTL_MS2 = 10 * 60 * 1e3;
      SEASON_TTL_MS = 10 * 60 * 1e3;
      healthCache = /* @__PURE__ */ new Map();
      searchCache2 = createTtlCache(24);
      seasonCache = createTtlCache(40);
    }
  });

  // src/core/orchestrator.js
  function extractStreams(_0, _1, _2, _3) {
    return __async(this, arguments, function* (tmdbId, mediaType, season2, episode, options = {}) {
      const cfg = readConfig();
      const signal = options && options.signal ? options.signal : null;
      const started = Date.now();
      const budgetMs = Number(options.budgetMs) > 0 ? Math.min(Number(options.budgetMs), cfg.budgetMs) : cfg.budgetMs;
      setHttpDeadline(started + budgetMs);
      const stopper = createStopper({
        startedAt: started,
        hardMs: budgetMs,
        softMs: Number(cfg.softMs) > 0 ? Number(cfg.softMs) : SOFT_MS2
      });
      const collected = options && Array.isArray(options.partial) ? options.partial : [];
      const push = (st) => {
        if (st && st.url) collected.push(st);
      };
      const sources = resolveSources(cfg);
      if (!sources.length) return [];
      const directSources = sources.filter((s) => !s.needsMeta).sort((a, b) => (DIRECT_ORDER[a.id] || 9) - (DIRECT_ORDER[b.id] || 9));
      const searchSources = sources.filter((s) => s.needsMeta);
      const metaPromise = getTmdbMeta(tmdbId, mediaType, {
        timeout: cfg.timeoutMs,
        signal
      }).catch(() => null);
      const ctx = {
        tmdbId,
        mediaType: mediaType === "tv" ? "tv" : "movie",
        season: season2,
        episode,
        cfg,
        signal,
        push,
        // shouldStop vu des sources : budget dur, OU échéance douce atteinte
        // avec des résultats déjà suffisants (anti-blocage identique TV/Mobile).
        shouldStop: makeSourceShouldStop(stopper, collected, cfg),
        stopper,
        meta: metaPromise,
        started
      };
      const directTask = launchAll(directSources, ctx, "direct");
      let kind = cfg.detectAnime ? null : "generic";
      let plan = null;
      const searchTask = (() => __async(this, null, function* () {
        if (!searchSources.length) return;
        if (kind === null) {
          const meta = yield metaPromise;
          kind = kindOf(ctx.mediaType, !!(meta && meta.isAnimeHint));
        }
        plan = buildPlan(searchSources.map((s) => s.id), kind);
        if (plan.wave1.length) {
          const label = kind === "anime" ? "Anim\xE9" : kind === "generic" ? "Type inconnu (d\xE9tection d\xE9sactiv\xE9e)" : "Film/s\xE9rie";
          console.log(
            "[core] " + label + " \u2192 recherche : " + plan.wave1.join(", ") + (plan.wave2.length ? " (secours : " + plan.wave2.join(", ") + ")" : "")
          );
        }
        yield launchAll(idsToSources(searchSources, plan.wave1), ctx, "recherche");
      }))();
      const allDone = Promise.all([directTask, searchTask]).catch(() => null);
      let outcome = "done";
      if (cfg.earlyExit) {
        outcome = yield raceEarlyExit({
          stopper,
          collected,
          cfg,
          allDone,
          onEnough: () => console.log(
            "[core] \xE9ch\xE9ance douce atteinte \u2192 rendu \xE0 " + stopper.elapsedMs() + "ms (les sources bloquantes ne retardent plus)"
          )
        });
        if (outcome === "budget") {
          console.warn("[core] budget atteint, rendu des r\xE9sultats disponibles");
        }
      } else {
        yield allDone;
      }
      if (!collected.length && !stopper.shouldStop() && searchSources.length) {
        const meta = yield metaPromise;
        if (meta) {
          if (!plan) {
            kind = cfg.detectAnime ? kindOf(ctx.mediaType, !!meta.isAnimeHint) : "generic";
            plan = buildPlan(searchSources.map((s) => s.id), kind);
          }
          if (plan.wave2.length) {
            console.log("[core] premi\xE8re vague sans r\xE9sultat \u2192 secours : " + plan.wave2.join(", "));
            yield launchAll(idsToSources(searchSources, plan.wave2), ctx, "secours");
          }
        }
      }
      if (!collected.length && cfg.serverUrl && !stopper.shouldStop()) {
        console.log("[core] rien en direct \u2192 repli sur le serveur sestudio configur\xE9");
        try {
          const got = yield bridgeStreams(ctx);
          for (const st of got) push(st);
        } catch (err) {
          console.warn("[core] pont sestudio \xE9chou\xE9 : " + (err && err.message ? err.message : err));
        }
      }
      let streams = finalizeStreams(collected, cfg);
      if (cfg.verifyLinks && streams.length) {
        try {
          streams = yield verifyStreams(streams, { remainingMs: budgetMs - (Date.now() - started) });
        } catch (err) {
          console.warn("[verify] ignor\xE9 : " + (err && err.message ? err.message : err));
        }
      }
      if (cfg.selfTest) {
        streams = TEST_STREAMS.map((t) => Object.assign({}, t)).concat(
          streams.map((st) => {
            const m = /^https?:\/\/([^\/?#]+)/i.exec(String(st.url || ""));
            return Object.assign({}, st, { name: st.name + (m ? " @" + m[1] : "") });
          })
        );
      }
      for (const st of streams) {
        console.log(
          "[stream] " + st.name + " | " + st.quality + " | " + st.language + " | " + st.url + " | headers=" + JSON.stringify(st.headers || {})
        );
      }
      console.log(
        "[core] Termin\xE9 : " + streams.length + " stream(s) en " + (Date.now() - started) + "ms" + (outcome === "enough" ? " (anti-blocage : \xE9ch\xE9ance douce)" : "")
      );
      return streams;
    });
  }
  function launchAll(providers, ctx, label) {
    return __async(this, null, function* () {
      const tasks = providers.map(
        (p) => Promise.resolve().then(() => p.run(ctx)).catch((err) => {
          console.warn(
            "[core] source " + p.label + " (" + label + ") \xE9chou\xE9e : " + (err && err.message ? err.message : err)
          );
        })
      );
      yield Promise.all(tasks);
    });
  }
  function idsToSources(sources, ids) {
    const byId = {};
    for (const s of sources) byId[s.id] = s;
    return ids.map((id) => byId[id]).filter(Boolean);
  }
  function bridgeStreams(ctx) {
    return __async(this, null, function* () {
      const { cfg, signal } = ctx;
      const alive = yield checkHealth(cfg.serverUrl, cfg.timeoutMs, signal);
      if (!alive) {
        console.error("[core] serveur sestudio injoignable sur " + cfg.serverUrl);
        return [];
      }
      let meta;
      try {
        meta = yield ctx.meta;
      } catch (e) {
        meta = null;
      }
      if (!meta || !meta.titles.length) return [];
      const isMovie = ctx.mediaType !== "tv";
      const allCards = [];
      let confident = null;
      for (const query of meta.titles.slice(0, 3)) {
        let res;
        try {
          res = yield search(cfg.serverUrl, query, cfg.sources, cfg.timeoutMs, signal);
        } catch (err) {
          continue;
        }
        for (const c of res.cards) allCards.push(c);
        const ranked2 = bridgeRank(allCards, meta, ctx.mediaType, ctx.season);
        if (ranked2.length) {
          confident = ranked2;
          if (ranked2[0].score >= 95) break;
        }
      }
      if (!confident) return [];
      const threshold = Math.max(40, confident[0].score - 30);
      const ranked = confident.filter((r) => r.score >= threshold);
      const streams = [];
      for (const cand of ranked.slice(0, 4)) {
        if (streams.length >= 2) break;
        try {
          const st = yield resolveBridgeCard(ctx, cand.card, meta, isMovie);
          if (st) streams.push(st);
        } catch (err) {
        }
      }
      return streams;
    });
  }
  function bridgeRank(cards, meta, mediaType, season2) {
    return rankCards(cards, meta, mediaType, season2);
  }
  function resolveBridgeCard(ctx, card, meta, isMovie) {
    return __async(this, null, function* () {
      const { cfg, signal } = ctx;
      const triedLangs = [];
      const langsToTry = cfg.fallbackLangs.slice(0, cfg.allowOtherLang ? 3 : 1);
      for (const lang of langsToTry) {
        if (triedLangs.indexOf(lang) !== -1) continue;
        triedLangs.push(lang);
        let page;
        try {
          page = yield season(cfg.serverUrl, card.page_url, lang, card.source, cfg.timeoutMs, signal);
        } catch (err) {
          continue;
        }
        const ep = bridgePickEpisode(page, isMovie, ctx.episode);
        if (!ep) {
          if (!isMovie) break;
          continue;
        }
        try {
          const resolved = yield resolve(
            cfg.serverUrl,
            ep.embed_urls,
            card.source,
            cfg.timeoutMs,
            signal
          );
          if (!resolved) continue;
          const stream = toNuvioStream(resolved, card, ep, cfg.serverUrl, {
            useTranscode: cfg.useTranscode,
            lang,
            sourceName: card.source,
            isFilm: isMovie || page.is_film
          });
          if (!stream) continue;
          return {
            name: stream.name,
            title: stream.title,
            url: stream.url,
            quality: stream.quality,
            language: stream.language,
            headers: stream.headers,
            subtitles: stream.subtitles,
            _langKey: LANG_KEY_BY_LABEL[String(stream.language || "").toUpperCase()] || "vo",
            _site: card.source
          };
        } catch (err) {
          return null;
        }
      }
      return null;
    });
  }
  function bridgePickEpisode(page, isMovie, episode) {
    const eps = (page.episodes || []).filter(
      (e) => e && e.embed_urls && Object.keys(e.embed_urls).length
    );
    if (!eps.length) return null;
    if (isMovie || page.is_film) return eps[0];
    const wanted = parseInt(episode, 10) || 0;
    if (wanted > 0) {
      const exact = eps.find((e) => parseInt(e.number, 10) === wanted);
      if (exact) return exact;
    }
    return null;
  }
  var SOFT_MS2, DIRECT_ORDER, LANG_KEY_BY_LABEL;
  var init_orchestrator = __esm({
    "src/core/orchestrator.js"() {
      init_settings();
      init_http();
      init_verify();
      init_tmdb();
      init_match();
      init_registry();
      init_plan();
      init_stopper();
      init_stream();
      init_sestudio();
      SOFT_MS2 = 5e3;
      DIRECT_ORDER = { webflix: 1, bflix: 2, papadustream: 3 };
      LANG_KEY_BY_LABEL = { VF: "vf", VOSTFR: "vostfr", VO: "vo" };
    }
  });

  // src/utils/provider.js
  function safeConfig(key, defaultVal) {
    try {
      if (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) {
        const v = globalThis.SCRAPER_SETTINGS[key];
        if (v !== void 0 && v !== null && v !== "") return v;
      }
    } catch (e) {
    }
    return defaultVal;
  }
  function createProvider(name, extractFn, opts = {}) {
    const budgetMs = parseInt(safeConfig("NUVIO_TIMEOUT_" + name.toUpperCase(), opts.timeout || PROVIDER_BUDGET_MS), 10) || PROVIDER_BUDGET_MS;
    return function getStreams(_0, _1, _2, _3) {
      return __async(this, arguments, function* (tmdbId, mediaType, season2, episode, options = {}) {
        const label = `${name} ${mediaType} ${tmdbId}${mediaType === "tv" ? ` S${season2}E${episode}` : ""}`;
        const started = Date.now();
        const partial = [];
        try {
          const result = yield raceTimeout(
            extractFn(tmdbId, mediaType, season2, episode, {
              signal: options && options.signal ? options.signal : null,
              budgetMs: Math.max(2e3, budgetMs - 1500),
              partial
            }),
            budgetMs
          );
          const list = Array.isArray(result) ? result : [];
          console.log(`[${name}] ${label}: ${list.length} stream(s) en ${Date.now() - started}ms`);
          return list;
        } catch (err) {
          const salvaged = sanitizePartial(partial);
          if (salvaged.length) {
            console.warn(
              `[${name}] ${label} budget d\xE9pass\xE9 \u2014 ${salvaged.length} flux partiel(s) conserv\xE9s`
            );
            return salvaged;
          }
          console.error(
            `[${name}] ${label} erreur: ` + (err && err.message ? err.message : String(err))
          );
          return [];
        }
      });
    };
  }
  function sanitizePartial(list) {
    const seen = {};
    const out = [];
    for (const s of list || []) {
      if (!s || !s.url || seen[s.url]) continue;
      seen[s.url] = true;
      const clean = {};
      for (const k of Object.keys(s)) {
        if (k.charAt(0) !== "_") clean[k] = s[k];
      }
      out.push(clean);
    }
    return out;
  }
  function raceTimeout(promise, budgetMs) {
    const deadline = Date.now() + budgetMs;
    const check = promise.then((value) => {
      if (Date.now() > deadline) {
        throw new Error(`[Timeout] budget ${budgetMs}ms d\xE9pass\xE9`);
      }
      return value;
    });
    const timerAvailable = typeof setTimeout === "function";
    if (!timerAvailable) return check;
    return new Promise((resolve2, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error(`[Timeout] budget ${budgetMs}ms d\xE9pass\xE9`));
        }
      }, budgetMs);
      check.then(
        (v) => {
          if (!done) {
            done = true;
            clearTimeout(t);
            resolve2(v);
          }
        },
        (e) => {
          if (!done) {
            done = true;
            clearTimeout(t);
            reject(e);
          }
        }
      );
    });
  }
  function createSettingsLayout(items) {
    const layout = Array.isArray(items) ? items : [];
    return function onSettings() {
      return __async(this, null, function* () {
        return layout;
      });
    };
  }
  var PROVIDER_BUDGET_MS;
  var init_provider = __esm({
    "src/utils/provider.js"() {
      PROVIDER_BUDGET_MS = 3e4;
    }
  });

  // src/plugin/index.js
  var require_index = __commonJS({
    "src/plugin/index.js"(exports, module) {
      init_orchestrator();
      init_provider();
      module.exports = {
        getStreams: createProvider("v3", extractStreams, { timeout: 27e3 }),
        onSettings: createSettingsLayout([
          { type: "header", label: "Lecture directe multi-sources (aucun serveur requis)" },
          {
            type: "info",
            label: "5 sources orchestr\xE9es : FStream, French-Manga, BFlix, Papadustream, Webflix. Toutes les qualit\xE9s des sources r\xE9actives sont affich\xE9es \u2014 installe-le, c est tout."
          },
          { type: "header", label: "Langue et sources" },
          {
            type: "select",
            key: "language",
            label: "Langue pr\xE9f\xE9r\xE9e",
            description: "Langue demand\xE9e en priorit\xE9 ; le plugin bascule automatiquement si absente",
            defaultValue: "vf",
            options: [
              { label: "VF d\u2019abord", value: "vf" },
              { label: "VOSTFR d\u2019abord", value: "vostfr" },
              { label: "VO d\u2019abord", value: "vo" },
              { label: "Auto (VF puis VOSTFR puis VO)", value: "all" }
            ]
          },
          {
            type: "toggle",
            key: "allowOtherLang",
            label: "Autoriser une autre langue / un autre site si absent",
            defaultValue: true
          },
          {
            type: "text",
            key: "sources",
            label: "Sources activ\xE9es (optionnel)",
            description: "Ids s\xE9par\xE9s par des virgules : fstream, french-manga, bflix, papadustream, webflix. Vide = toutes.",
            placeholder: "fstream, webflix, bflix"
          },
          {
            type: "toggle",
            key: "detectAnime",
            label: "D\xE9tecter les anim\xE9s via TMDB",
            description: "Anime \u2192 French-Manga d\u2019abord (FStream en secours). Films/s\xE9ries \u2192 FStream + Webflix + Bflix. D\xE9sactiv\xE9 : toutes les sources pour tout.",
            defaultValue: true
          },
          {
            type: "toggle",
            key: "earlyExit",
            label: "Couper les sources bloquantes (rapide)",
            description: "Affiche TOUS les flux des sources qui r\xE9pondent \u2014 qualit\xE9s et hosts multiples inclus. Apr\xE8s 5 s, si au moins un flux est trouv\xE9, les sites bloqu\xE9s ne sont plus attendus. D\xE9sactiv\xE9 : attendre toutes les sources jusqu au budget.",
            defaultValue: true
          },
          {
            type: "toggle",
            key: "verifyLinks",
            label: "Tester les liens avant affichage",
            description: "Teste chaque lien (8 s max) : playlist HLS, puis variante et premier segment sur les 3 premiers liens \u2014 les liens morts ou refus\xE9s aux segments (403) passent en fin de liste avec \u26A0 au lieu de bloquer en \xAB buffering \xBB.",
            defaultValue: true
          },
          {
            type: "toggle",
            key: "selfTest",
            label: "Mode diagnostic (flux de test + domaine des liens)",
            description: "Ajoute 2 flux publics de test en t\xEAte de liste et le domaine de chaque lien dans son nom. Si les flux de test ne se lisent pas non plus, le probl\xE8me vient du lecteur de l\u2019app, pas du plugin. Activ\xE9 par d\xE9faut : Nuvio n\u2019expose pas d\u2019UI de r\xE9glages, il reste actif tant que le d\xE9bogage n\u2019est pas termin\xE9.",
            defaultValue: true
          },
          {
            type: "text",
            key: "tmdbKey",
            label: "Cl\xE9 API TMDB personnelle (optionnel)",
            description: "La cl\xE9 publique int\xE9gr\xE9e est tr\xE8s r\xE9pandue et peut \xEAtre r\xE9voqu\xE9e. Ta propre cl\xE9 (gratuite sur themoviedb.org) est plus fiable.",
            placeholder: "ex. 1a2b3c\u2026"
          },
          { type: "header", label: "Avanc\xE9 \u2014 serveur sestudio (optionnel)" },
          {
            type: "text",
            key: "serverUrl",
            label: "URL d\u2019un serveur sestudio (repli)",
            description: "Facultatif : ajoute kisskh et uniquestream via ton serveur (uvx sestudio). Vide = mode direct uniquement.",
            placeholder: "http://192.168.1.50:8080"
          },
          {
            type: "select",
            key: "timeoutSec",
            label: "Timeout r\xE9seau",
            defaultValue: "10",
            options: [
              { label: "10 s (recommand\xE9)", value: "10" },
              { label: "15 s", value: "15" },
              { label: "30 s", value: "30" },
              { label: "45 s", value: "45" }
            ]
          },
          {
            type: "info",
            label: "Astuce : certains hosts (uqload, vidzy\u2026) sont plus lents le soir ; avec \xAB rendre d\xE8s que c\u2019est bon \xBB, les sources lentes ne te bloquent plus \u2014 essaie un autre flux."
          },
          {
            type: "info",
            label: "Si TOUTES les sources \xE9chouent chez toi : ton fournisseur d\u2019acc\xE8s bloque peut-\xEAtre les domaines (DNS). Un VPN ou le DNS 1.1.1.1 r\xE8gle le probl\xE8me \u2014 le plugin r\xE9pond toujours avant le timeout de Nuvio, liste vide ou pas."
          }
        ])
      };
    }
  });
  return require_index();
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = __provider;
}
if (__provider && __provider.getStreams) {
    if (typeof globalThis !== 'undefined') {
        globalThis.getStreams = __provider.getStreams;
    }
    if (typeof global !== 'undefined') {
        global.getStreams = __provider.getStreams;
    }
    if (typeof self !== 'undefined') {
        self.getStreams = __provider.getStreams;
    }
}
