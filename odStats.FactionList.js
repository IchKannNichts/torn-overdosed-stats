// ==UserScript==
// @name         OD‑Statistik DKF Privat Script
// @namespace    https://github.com/yourname/torn-overdosed
// @version      4.0.0
// @description  Button in der Torn-Menüleiste: holt die Mitglieder einer Fraktion, fragt deren Overdosed-Statistik ab, sortiert sie und sendet sie per Telegram-Bot.
// @author       Kochaff3
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @connect      api.telegram.org
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    /* ------------------------------------------------------------------
       1) Konfiguration  –  HIER AUSFÜLLEN
       ------------------------------------------------------------------ */
    const API_KEY    = "";     // Torn-API-Key
    const FACTION_ID = "";     // ID der Fraktion, z. B. "12345"

    const TG_BOT_TOKEN = "";
    const TG_CHAT_ID   = "";

    // Optional: Spieler-IDs, die NICHT in der Statistik erscheinen sollen
    const EXCLUDE_IDS = [
        // 1234567,
    ];

    // Mindestabstand zwischen zwei Torn-Anfragen (ms).
    // 700 ms ≈ 85 Anfragen/Minute und bleibt damit unter dem Limit von ca. 100/Minute pro Key.
    const REQUEST_GAP_MS = 700;

    const REQUEST_TIMEOUT_MS   = 15000;
    const RETRY_WAIT_MS        = 10000;   // Wartezeit nach "Too many requests"
    const MAX_RETRIES          = 2;
    const RESET_STATE_AFTER_MS = 3000;
    const TG_CHUNK_LIMIT       = 3800;    // Telegram erlaubt max. 4096 Zeichen pro Nachricht

    /* ------------------------------------------------------------------
       2) Styling – Button als Teil der Torn-Toolbar
       ------------------------------------------------------------------ */
    const BTN_ID = "torn-ods-btn";
    const LI_ID  = "torn-ods-item";

    GM_addStyle(`
        #${BTN_ID} { cursor: pointer; }
        #${BTN_ID} svg path { fill: #a7b9ca; transition: fill .2s, opacity .2s; }
        #${BTN_ID}:hover svg path { fill: #fff; }
        #${BTN_ID}[data-state="busy"] { pointer-events: none; }
        #${BTN_ID}[data-state="busy"] svg { opacity: .4; }
        #${BTN_ID}[data-state="ok"]  svg path { fill: #8fc866 !important; }
        #${BTN_ID}[data-state="err"] svg path { fill: #e0645c !important; }
    `);

    const PILL_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
            <g transform="rotate(-45 13 13)">
                <path fill-rule="evenodd" d="M9 8h8a5 5 0 0 1 0 10H9A5 5 0 0 1 9 8zM13 9.5H9a3.5 3.5 0 0 0 0 7h4z"></path>
            </g>
        </svg>`;

    const TITLES = {
        idle: "Fraktions-OD‑Statistik per Telegram senden",
        busy: "Sende …",
        ok:   "Statistik gesendet",
        err:  "Fehler – Details in der Browser-Konsole"
    };

    let btnEl = null;

    const setState = (state, titleOverride) => {
        if (!btnEl) return;
        btnEl.dataset.state = state;
        btnEl.title = titleOverride || TITLES[state] || TITLES.idle;
    };

    const createButton = () => {
        const b = document.createElement("button");
        b.id = BTN_ID;
        b.type = "button";
        b.className = "top_header_button button";
        b.setAttribute("aria-label", "Fraktions-Overdosed-Statistik senden");
        b.innerHTML = PILL_SVG;
        b.dataset.state = "idle";
        b.title = TITLES.idle;
        b.addEventListener("click", runTask);
        btnEl = b;
        return b;
    };

    const injectButton = () => {
        if (document.getElementById(LI_ID)) return;

        const toolbar = document.querySelector(".header-navigation ul.toolbar");
        if (!toolbar) return;

        const li = document.createElement("li");
        li.id = LI_ID;
        li.appendChild(createButton());

        const ref = toolbar.querySelector("#recent-history-wrapper");
        toolbar.insertBefore(li, ref && ref.parentNode === toolbar ? ref : null);
    };

    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            injectButton();
        });
    }).observe(document.body, { childList: true, subtree: true });

    injectButton();

    /* ------------------------------------------------------------------
       3) HTTP-Helfer + Rate-Limiter
       ------------------------------------------------------------------ */
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const gmRequest = opts => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            timeout: REQUEST_TIMEOUT_MS,
            ...opts,
            onload:    resolve,
            onerror:   () => reject(new Error("Netzwerkfehler")),
            ontimeout: () => reject(new Error("Timeout"))
        });
    });

    // Reserviert für jede Torn-Anfrage einen Zeitslot, damit das Limit nicht überschritten wird.
    let nextSlot = 0;
    const waitForSlot = async () => {
        const now = Date.now();
        const start = Math.max(now, nextSlot);
        nextSlot = start + REQUEST_GAP_MS;
        if (start > now) await sleep(start - now);
    };

    /* ------------------------------------------------------------------
       4) Torn-API
       ------------------------------------------------------------------ */
    const tornGet = async (path, selections, attempt = 0) => {
        await waitForSlot();

        const url = `https://api.torn.com/${path}` +
                    `?selections=${selections}&key=${encodeURIComponent(API_KEY)}`;
        const r = await gmRequest({ method: "GET", url });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);

        const d = JSON.parse(r.responseText);
        if (d.error) {
            // Code 5 = "Too many requests" → kurz warten und erneut versuchen
            if (d.error.code === 5 && attempt < MAX_RETRIES) {
                console.warn(`[ODs] Rate-Limit erreicht, warte ${RETRY_WAIT_MS / 1000}s …`);
                await sleep(RETRY_WAIT_MS);
                return tornGet(path, selections, attempt + 1);
            }
            throw new Error(`API ${d.error.code}: ${d.error.error}`);
        }
        return d;
    };

    /** Mitglieder der Fraktion laden → { name, members: [{id, name}] } */
    const fetchFactionMembers = async () => {
        const d = await tornGet(`faction/${encodeURIComponent(FACTION_ID)}`, "basic");

        const raw = d.members || {};
        const members = Array.isArray(raw)
            ? raw.map(m => ({ id: String(m.id), name: m.name }))
            : Object.entries(raw).map(([id, m]) => ({ id: String(id), name: m?.name }));

        if (!members.length) throw new Error("Keine Mitglieder gefunden (Fraktions-ID prüfen).");
        return { name: d.name || `Fraktion ${FACTION_ID}`, members };
    };

    /** Overdosed-Zahl eines Mitglieds laden */
    const fetchStats = async ({ id, name }) => {
        const fallback = name || `user_${id}`;
        try {
            const d = await tornGet(`user/${encodeURIComponent(id)}`, "personalstats");
            const od = d.personalstats?.overdosed;
            if (typeof od !== "number") throw new Error("kein overdosed-Wert");
            return { ok: true, username: fallback, overdosed: od };
        } catch (e) {
            return { ok: false, username: fallback, reason: e.message };
        }
    };

    /* ------------------------------------------------------------------
       5) Nachricht + Telegram (MarkdownV2-Escaping, Aufteilung bei Überlänge)
       ------------------------------------------------------------------ */
    const MD_ESCAPE_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
    const escapeMarkdownV2 = str => str.replace(MD_ESCAPE_RE, "\\$&");

    const formatNow = () =>
        new Date()
            .toLocaleString("de-DE", {
                day: "2-digit", month: "2-digit", year: "numeric",
                hour: "2-digit", minute: "2-digit"
            })
            .replace(", ", " ");

    const buildLines = (factionName, good, failed) => {
        const total = good.reduce((sum, r) => sum + r.overdosed, 0);
        const lines = [
            `🧪 OD‑Statistik ${factionName} vom ${formatNow()}`,
            ...good.map(r => `${r.username}: ${r.overdosed}`),
            "",
            `Gesamt: ${total} (${good.length} Mitglieder)`
        ];
        if (failed.length) {
            lines.push("", `⚠️ Keine Daten: ${failed.map(f => f.username).join(", ")}`);
        }
        return lines;
    };

    const chunkLines = lines => {
        const chunks = [];
        let cur = [];
        let len = 0;
        for (const line of lines) {
            const l = escapeMarkdownV2(line).length + 1;
            if (cur.length && len + l > TG_CHUNK_LIMIT) {
                chunks.push(cur);
                cur = [];
                len = 0;
            }
            cur.push(line);
            len += l;
        }
        if (cur.length) chunks.push(cur);
        return chunks;
    };

    const sendOne = async txt => {
        const r = await gmRequest({
            method: "POST",
            url: `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            data: new URLSearchParams({
                chat_id: TG_CHAT_ID,
                text: escapeMarkdownV2(txt),
                parse_mode: "MarkdownV2",
                disable_web_page_preview: "true"
            }).toString()
        });

        let resp = null;
        try { resp = JSON.parse(r.responseText); } catch { /* ignorieren */ }
        if (r.status !== 200 || !resp?.ok) {
            throw new Error(`Telegram: ${resp?.description || "HTTP " + r.status}`);
        }
    };

    const sendViaTelegram = async lines => {
        const chunks = chunkLines(lines);
        for (let i = 0; i < chunks.length; i++) {
            const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
            await sendOne(prefix + chunks[i].join("\n"));   // der Reihe nach, damit die Reihenfolge stimmt
        }
    };

    /* ------------------------------------------------------------------
       6) Gesamtablauf
       ------------------------------------------------------------------ */
    let busy = false;

    async function runTask() {
        if (busy) return;
        busy = true;
        setState("busy", "Lade Fraktion …");

        let finalState = "ok";
        try {
            if (!API_KEY || !FACTION_ID || !TG_BOT_TOKEN || !TG_CHAT_ID) {
                throw new Error("API_KEY, FACTION_ID, TG_BOT_TOKEN oder TG_CHAT_ID fehlt.");
            }

            console.log("[ODs] Lade Fraktionsmitglieder …");
            const faction = await fetchFactionMembers();
            const exclude = new Set(EXCLUDE_IDS.map(String));
            const members = faction.members.filter(m => !exclude.has(m.id));
            console.log(`[ODs] ${members.length} Mitglieder in „${faction.name}“.`);

            let done = 0;
            const results = await Promise.all(members.map(async m => {
                const res = await fetchStats(m);
                done++;
                setState("busy", `Abfrage ${done}/${members.length} …`);
                return res;
            }));

            const good   = results.filter(r => r.ok).sort((a, b) => b.overdosed - a.overdosed);
            const failed = results.filter(r => !r.ok);

            failed.forEach(f => console.warn(`[ODs] ${f.username}: ${f.reason}`));
            if (!good.length) throw new Error("Keine Daten gefunden.");

            setState("busy", "Sende an Telegram …");
            await sendViaTelegram(buildLines(faction.name, good, failed));
            console.log("[ODs] Nachricht(en) gesendet.");

            if (failed.length) finalState = "err";   // gesendet, aber nicht alle Mitglieder lieferten Daten
        } catch (e) {
            console.error("[ODs]", e.message || e);
            finalState = "err";
        } finally {
            setState(finalState);
            setTimeout(() => { busy = false; setState("idle"); }, RESET_STATE_AFTER_MS);
        }
    }
})();
