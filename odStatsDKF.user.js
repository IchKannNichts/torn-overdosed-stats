// ==UserScript==
// @name         OD‑Statistik DKF Privat Script
// @namespace    https://github.com/yourname/torn-overdosed
// @version      3.0.0
// @description  Fügt einen Button in die Torn-Menüleiste ein, holt die Overdosed-Statistik per Torn-API, sortiert sie und sendet sie per Telegram-Bot.
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
       1) Konfiguration
       ------------------------------------------------------------------ */
    const API_KEY = "";

    // Pro Spieler eine Zeile. name ist optional (leer = Name aus der API / user_<id>)
    const PLAYERS = [
        // { id: 1234567, name: "Beispiel" },
    ];

    const TG_BOT_TOKEN = "";
    const TG_CHAT_ID   = "";

    const REQUEST_TIMEOUT_MS = 15000;
    const RESET_STATE_AFTER_MS = 3000;

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
        idle: "Overdosed‑Statistik per Telegram senden",
        busy: "Sende …",
        ok:   "Statistik gesendet",
        err:  "Fehler – Details in der Browser-Konsole"
    };

    let btnEl = null;

    const setState = state => {
        if (!btnEl) return;
        btnEl.dataset.state = state;
        btnEl.title = TITLES[state] || TITLES.idle;
    };

    const createButton = () => {
        const b = document.createElement("button");
        b.id = BTN_ID;
        b.type = "button";
        b.className = "top_header_button button";   // Torn-eigene Header-Button-Klassen
        b.setAttribute("aria-label", "Overdosed-Statistik senden");
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

        // Vor "Activity log" einsortieren, sonst ans Ende der Toolbar
        const ref = toolbar.querySelector("#recent-history-wrapper");
        toolbar.insertBefore(li, ref && ref.parentNode === toolbar ? ref : null);
    };

    // Torn ist teilweise eine SPA: Button bei Bedarf neu einfügen (gedrosselt per rAF)
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
       3) HTTP-Helfer (Promise + Timeout)
       ------------------------------------------------------------------ */
    const gmRequest = opts => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            timeout: REQUEST_TIMEOUT_MS,
            ...opts,
            onload:    resolve,
            onerror:   () => reject(new Error("Netzwerkfehler")),
            ontimeout: () => reject(new Error("Timeout"))
        });
    });

    /* ------------------------------------------------------------------
       4) Torn-API
       ------------------------------------------------------------------ */
    const fetchStats = async ({ id, name }) => {
        const custom = (name || "").trim();
        const fallback = custom || `user_${id}`;
        try {
            const url = `https://api.torn.com/user/${encodeURIComponent(id)}` +
                        `?selections=personalstats&key=${encodeURIComponent(API_KEY)}`;
            const r = await gmRequest({ method: "GET", url });
            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);

            const d = JSON.parse(r.responseText);
            if (d.error) throw new Error(`API ${d.error.code}: ${d.error.error}`);

            const od = d.personalstats?.overdosed;
            if (typeof od !== "number") throw new Error("kein overdosed-Wert");

            return { ok: true, username: custom || d.name || fallback, overdosed: od };
        } catch (e) {
            return { ok: false, username: fallback, reason: e.message };
        }
    };

    /* ------------------------------------------------------------------
       5) Nachricht + Telegram (MarkdownV2-Escaping)
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

    const buildMessage = (rows, failed) => {
        const lines = [
            `🧪 OD‑Statistik vom ${formatNow()}`,
            ...rows.map(r => `${r.username}: ${r.overdosed}`)
        ];
        if (failed.length) {
            lines.push("", `⚠️ Keine Daten: ${failed.map(f => f.username).join(", ")}`);
        }
        return lines.join("\n");
    };

    const sendViaTelegram = async txt => {
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

    /* ------------------------------------------------------------------
       6) Gesamtablauf
       ------------------------------------------------------------------ */
    let busy = false;

    async function runTask() {
        if (busy) return;
        busy = true;
        setState("busy");

        let finalState = "ok";
        try {
            if (!API_KEY || !TG_BOT_TOKEN || !TG_CHAT_ID) throw new Error("API_KEY, TG_BOT_TOKEN oder TG_CHAT_ID fehlt.");
            if (!PLAYERS.length) throw new Error("PLAYERS ist leer.");

            console.log("[ODs] Starte Torn‑Abfrage …");

            // Alle Abfragen parallel statt nacheinander
            const results = await Promise.all(PLAYERS.map(fetchStats));
            const good   = results.filter(r => r.ok).sort((a, b) => b.overdosed - a.overdosed);
            const failed = results.filter(r => !r.ok);

            failed.forEach(f => console.warn(`[ODs] ${f.username}: ${f.reason}`));
            if (!good.length) throw new Error("Keine Daten gefunden.");

            await sendViaTelegram(buildMessage(good, failed));
            console.log("[ODs] Nachricht gesendet.");
            if (failed.length) finalState = "err";   // gesendet, aber nicht alle Spieler lieferten Daten
        } catch (e) {
            console.error("[ODs]", e.message || e);
            finalState = "err";
        } finally {
            setState(finalState);
            setTimeout(() => { busy = false; setState("idle"); }, RESET_STATE_AFTER_MS);
        }
    }
})();
