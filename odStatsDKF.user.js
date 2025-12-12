// ==UserScript==
// @name         OD‑Statistik DKF Privat Script
// @namespace    https://github.com/yourname/torn-overdosed
// @version      2.8.4
// @description  Fügt einen Button „Overdosed‑Statistik“ ein, holt die Daten von Torn, sortiert sie und sendet sie per Telegram‑Bot (Token & Chat‑ID fest kodiert). Markdown‑V2‑Escaping ist integriert.
// @author       Kochaff3
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @connect      api.telegram.org
// @run-at       document-idle
// ==/UserScript==

(() => {
    /* --------------------------------------------------------------
       1️⃣  Konstanten für die Torn‑API
       -------------------------------------------------------------- */
    const API_KEY      = "";
    const USER_IDS     = [3090251,3133682,3084346,3111576,3109098,3092609,3091077];
    const PLAYER_NAMES = ["K1rbs","ReflectionL0rd","InfernoFox ","Jendrox ","DoSammy ","Huchmampf ","Kochaff3"];

    /* --------------------------------------------------------------
       2️⃣  Fest kodierte Telegram‑Konfiguration
       -------------------------------------------------------------- */
    const TG_BOT_TOKEN = "";
    const TG_CHAT_ID   = "";
    const TG_ENDPOINT  = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

    /* --------------------------------------------------------------
       3️⃣  Button‑Styling (wie von dir gewünscht)
       -------------------------------------------------------------- */
    GM_addStyle(`
        #torn-ods-btn {
            position: fixed !important;
            top: 4px !important;
            right: 100px !important;
            background: transparent !important;
            color: #a7b9ca !important;
            font-size: 13px !important;
            font-weight: normal !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            padding: 6px 12px !important;
            cursor: pointer !important;
            z-index: 2147483647 !important;
        }
    `);

    const BTN_ID = "torn-ods-btn";

    const createButton = () => {
        const b = document.createElement("button");
        b.id = BTN_ID;
        b.textContent = "Overdosed‑Statistik";
        b.title = "Statistik per Telegram senden";
        b.onclick = runTask;   // Klick → Hauptfunktion
        return b;
    };

    const injectButton = () => {
        if (document.getElementById(BTN_ID)) return;
        const btn = createButton();
        const container = document.getElementById("tt-page-status") || document.body;
        container.appendChild(btn);
    };

    // Button einfügen (auch bei SPA‑Navigation)
    new MutationObserver(() => { if (!document.getElementById(BTN_ID)) injectButton(); })
        .observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", injectButton);
    else
        injectButton();

    /* --------------------------------------------------------------
       4️⃣  Helfer für die Torn‑API
       -------------------------------------------------------------- */
    const buildUrl = uid => `https://api.torn.com/user/${uid}?selections=personalstats&key=${API_KEY}`;

    const fetchStats = async (uid, idx) => new Promise(res => {
        GM_xmlhttpRequest({
            method: "GET",
            url:    buildUrl(uid),
            onload: r => {
                if (r.status !== 200) { res(null); return; }
                try {
                    const d = JSON.parse(r.responseText);
                    const name = (PLAYER_NAMES[idx] && PLAYER_NAMES[idx].trim())
                                 ? PLAYER_NAMES[idx].trim()
                                 : d.name || `user_${uid}`;
                    if (!d.personalstats?.overdosed) { res(null); return; }
                    res({ username: name, overdosed: d.personalstats.overdosed });
                } catch { res(null); }
            },
            onerror: () => res(null)
        });
    });

    /* --------------------------------------------------------------
       5️⃣  Markdown‑V2‑Escaping‑Hilfsfunktion
       -------------------------------------------------------------- */
    const MD_ESCAPE_RE = /[_*[\]()~`>#+\-=|{}.!]/g;
    const escapeMarkdownV2 = str => str.replace(MD_ESCAPE_RE, '\\$&');

   /* --------------------------------------------------------------
       6️⃣  Nachricht zusammenbauen (deutsches Datumsformat)
       -------------------------------------------------------------- */
    const buildMessage = rows => {
        // Aktuelles Datum + Uhrzeit im Format dd.MM.yyyy HH:mm:ss
        const now = new Date();
        const pad = n => n.toString().padStart(2, "0");
        const day   = pad(now.getDate());
        const month = pad(now.getMonth() + 1);
        const year  = now.getFullYear();
        const hour  = pad(now.getHours());
        const min   = pad(now.getMinutes());
        const datetime = `${day}.${month}.${year} ${hour}:${min}`;

        const head = `🧪 OD‑Statistik vom ${datetime}`;
        const body = rows.map(r => `${r.username}: ${r.overdosed}`).join("\n");
        return `${head}\n${body}`;
    };

    /* --------------------------------------------------------------
       7️⃣  Telegram‑Versand (mit Escaping)
       -------------------------------------------------------------- */
    const sendViaTelegram = async txt => {
        const safeTxt = escapeMarkdownV2(txt);   // <‑‑ wichtig!
        const payload = new URLSearchParams({
            chat_id: TG_CHAT_ID,
            text:    safeTxt,
            parse_mode: "MarkdownV2",
            disable_web_page_preview: "true"
        }).toString();

        GM_xmlhttpRequest({
            method: "POST",
            url:    TG_ENDPOINT,
            data:   payload,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            onload: r => {
                if (r.status === 200) {
                    const resp = JSON.parse(r.responseText);
                    if (resp.ok) console.log("[Telegram] Nachricht gesendet.");
                    else console.warn("[Telegram] API‑Fehler:", resp.description);
                } else {
                    console.warn(`[Telegram] HTTP‑Fehler ${r.status}: ${r.responseText}`);
                }
            },
            onerror: e => console.error("[Telegram] Netzwerk‑Fehler:", e)
        });
    };

    /* --------------------------------------------------------------
       8️⃣  Gesamtablauf – Daten holen, sortieren, senden
       -------------------------------------------------------------- */
    async function runTask() {
        console.log("[ODs] Starte Torn‑Abfrage …");
        const results = [];

        for (let i = 0; i < USER_IDS.length; i++) {
            const r = await fetchStats(USER_IDS[i], i);
            if (r) results.push(r);
        }

        if (!results.length) {
            console.warn("[ODs] Keine Daten gefunden.");
            return;
        }

        // Sortieren: höchste „overdosed“-Zahl zuerst
        results.sort((a, b) => b.overdosed - a.overdosed);

        const message = buildMessage(results);
        await sendViaTelegram(message);
    }
})();
