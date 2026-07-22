/* Dutch flashcard trainer — dedupe, Leitner-style scheduling, learn-then-quiz flow */
(function () {
  "use strict";

  const STORAGE_KEY = "dutch-fc-progress-v2";
  const SETTINGS_KEY = "dutch-fc-settings-v1";

  const LEARNING_STEPS_MIN = [5, 15]; // minutes; graduate to review after passing all steps
  const REVIEW_INTERVALS_HOURS = [4, 12, 24, 48, 96, 168]; // box 0..5
  const MASTER_BOX = 4; // box index at which a card counts as "mastered"

  // ---------- Build deduped card list ----------
  function normalizeKey(nl) {
    return nl.trim().toLowerCase();
  }

  function buildCards(raw) {
    const seen = new Map();
    raw.forEach(([nl, en, sNl, sEn, deck]) => {
      const key = normalizeKey(nl);
      if (seen.has(key)) {
        seen.get(key).decks.add(deck);
      } else {
        seen.set(key, { nl, en, sNl, sEn, decks: new Set([deck]) });
      }
    });
    let id = 0;
    return Array.from(seen.values()).map((c) => ({
      id: id++,
      nl: c.nl,
      en: c.en,
      sNl: c.sNl,
      sEn: c.sEn,
      decks: Array.from(c.decks).sort(),
    }));
  }

  const CARDS = buildCards(RAW_CARDS);
  const CARDS_BY_ID = new Map(CARDS.map((c) => [c.id, c]));

  // ---------- Progress persistence ----------
  function freshProgress(id) {
    return {
      id,
      state: "new", // new | learning | review
      box: 0,
      step: 0,
      dueAt: 0,
      seen: 0,
      correct: 0,
      wrong: 0,
    };
  }

  function loadProgress() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (e) {
      stored = {};
    }
    const progress = {};
    CARDS.forEach((c) => {
      progress[c.id] = stored[c.id] ? Object.assign(freshProgress(c.id), stored[c.id]) : freshProgress(c.id);
    });
    return progress;
  }

  function saveProgress() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
  }

  function loadSettings() {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    } catch (e) {
      s = {};
    }
    return Object.assign({ newPerSession: 20, deckFilter: "all" }, s);
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  const state = {
    progress: loadProgress(),
    settings: loadSettings(),
    queue: [],
    current: null,
    revealed: false,
    screen: "home",
  };

  // ---------- Scheduling ----------
  function minutesFromNow(min) {
    return Date.now() + min * 60 * 1000;
  }
  function hoursFromNow(h) {
    return Date.now() + h * 60 * 60 * 1000;
  }

  function introduceCard(cardId) {
    const p = state.progress[cardId];
    p.state = "learning";
    p.step = 0;
    p.dueAt = minutesFromNow(LEARNING_STEPS_MIN[0]);
    saveProgress();
  }

  function gradeCard(cardId, grade) {
    // grade: 'again' | 'good' | 'easy'
    const p = state.progress[cardId];
    p.seen += 1;

    if (p.state === "learning" || p.state === "new") {
      if (p.state === "new") p.state = "learning";
      if (grade === "again") {
        p.wrong += 1;
        p.step = 0;
        p.dueAt = minutesFromNow(LEARNING_STEPS_MIN[0]);
      } else {
        p.correct += 1;
        const bonus = grade === "easy" ? 1 : 0;
        p.step += 1 + bonus;
        if (p.step >= LEARNING_STEPS_MIN.length) {
          p.state = "review";
          p.box = grade === "easy" ? 1 : 0;
          p.dueAt = hoursFromNow(REVIEW_INTERVALS_HOURS[p.box]);
        } else {
          p.dueAt = minutesFromNow(LEARNING_STEPS_MIN[p.step]);
        }
      }
    } else {
      // review
      if (grade === "again") {
        p.wrong += 1;
        p.state = "learning";
        p.box = 0;
        p.step = 0;
        p.dueAt = minutesFromNow(LEARNING_STEPS_MIN[0]);
      } else {
        p.correct += 1;
        const bump = grade === "easy" ? 2 : 1;
        p.box = Math.min(p.box + bump, REVIEW_INTERVALS_HOURS.length - 1);
        p.dueAt = hoursFromNow(REVIEW_INTERVALS_HOURS[p.box]);
      }
    }
    saveProgress();
  }

  function cardsForDeckFilter() {
    if (state.settings.deckFilter === "all") return CARDS;
    const d = Number(state.settings.deckFilter);
    return CARDS.filter((c) => c.decks.includes(d));
  }

  function buildQueue() {
    const now = Date.now();
    const pool = cardsForDeckFilter();
    const due = [];
    const fresh = [];
    pool.forEach((c) => {
      const p = state.progress[c.id];
      if (p.state === "new") fresh.push(c);
      else if (p.dueAt <= now) due.push(c);
    });
    due.sort((a, b) => state.progress[a.id].dueAt - state.progress[b.id].dueAt);
    const newBatch = fresh.slice(0, state.settings.newPerSession);

    // interleave: 1 new card every 3 due cards, so learning doesn't dominate
    const merged = [];
    let di = 0, ni = 0;
    while (di < due.length || ni < newBatch.length) {
      for (let k = 0; k < 3 && di < due.length; k++) merged.push(due[di++]);
      if (ni < newBatch.length) merged.push(newBatch[ni++]);
    }
    return merged;
  }

  function stats() {
    const pool = cardsForDeckFilter();
    const now = Date.now();
    let n = 0, learning = 0, review = 0, mastered = 0, due = 0;
    pool.forEach((c) => {
      const p = state.progress[c.id];
      if (p.state === "new") n++;
      else if (p.state === "learning") learning++;
      else {
        review++;
        if (p.box >= MASTER_BOX) mastered++;
      }
      if (p.state !== "new" && p.dueAt <= now) due++;
    });
    return { total: pool.length, n, learning, review, mastered, due };
  }

  // ---------- Rendering ----------
  const app = document.getElementById("app");

  function render() {
    if (state.screen === "home") renderHome();
    else if (state.screen === "study") renderStudy();
    else if (state.screen === "browse") renderBrowse();
  }

  function deckOptionsHtml() {
    const decks = [1, 2, 3, 4];
    let html = `<option value="all"${state.settings.deckFilter === "all" ? " selected" : ""}>All decks</option>`;
    decks.forEach((d) => {
      html += `<option value="${d}"${String(state.settings.deckFilter) === String(d) ? " selected" : ""}>Mock ${d}</option>`;
    });
    return html;
  }

  function renderHome() {
    const s = stats();
    app.innerHTML = `
      <div class="screen home">
        <h1>Dutch Flashcards</h1>
        <p class="subtitle">${s.total} words loaded</p>

        <div class="stat-grid">
          <div class="stat"><span class="num">${s.n}</span><span class="lbl">New</span></div>
          <div class="stat"><span class="num">${s.learning}</span><span class="lbl">Learning</span></div>
          <div class="stat"><span class="num">${s.review}</span><span class="lbl">Review</span></div>
          <div class="stat"><span class="num">${s.mastered}</span><span class="lbl">Mastered</span></div>
        </div>

        <div class="field">
          <label for="deck-select">Deck</label>
          <select id="deck-select">${deckOptionsHtml()}</select>
        </div>

        <div class="field">
          <label for="new-per-session">New words per session: <b id="new-per-session-val">${state.settings.newPerSession}</b></label>
          <input type="range" id="new-per-session" min="5" max="60" step="5" value="${state.settings.newPerSession}">
        </div>

        <button class="primary big" id="study-btn">${s.due + Math.min(s.n, state.settings.newPerSession) > 0 ? "Study (" + (s.due + Math.min(s.n, state.settings.newPerSession)) + ")" : "Nothing due right now"}</button>
        <button class="secondary" id="browse-btn">Browse all words</button>
        <button class="link danger" id="reset-btn">Reset all progress</button>
      </div>
    `;

    document.getElementById("deck-select").addEventListener("change", (e) => {
      state.settings.deckFilter = e.target.value;
      saveSettings();
      render();
    });
    document.getElementById("new-per-session").addEventListener("input", (e) => {
      state.settings.newPerSession = Number(e.target.value);
      document.getElementById("new-per-session-val").textContent = e.target.value;
    });
    document.getElementById("new-per-session").addEventListener("change", () => {
      saveSettings();
      render();
    });
    document.getElementById("study-btn").addEventListener("click", startStudy);
    document.getElementById("browse-btn").addEventListener("click", () => {
      state.screen = "browse";
      render();
    });
    document.getElementById("reset-btn").addEventListener("click", () => {
      if (confirm("Reset ALL learning progress? This cannot be undone.")) {
        state.progress = {};
        CARDS.forEach((c) => (state.progress[c.id] = freshProgress(c.id)));
        saveProgress();
        render();
      }
    });
  }

  function startStudy() {
    state.queue = buildQueue();
    state.screen = "study";
    nextCard();
  }

  function nextCard() {
    if (state.queue.length === 0) {
      state.queue = buildQueue();
    }
    state.current = state.queue.shift() || null;
    state.revealed = false;
    render();
  }

  function renderStudy() {
    if (state.current === null) {
      app.innerHTML = `
        <div class="screen study">
          <div class="topbar">
            <button class="link" id="home-btn">← Home</button>
          </div>
          <div class="card">
            <div class="badge">Session complete</div>
            <div class="nl">Nothing left to study right now 🎉</div>
            <div class="sentence"><div class="s-en">New reviews will unlock as their timers come due. Come back later or study another deck.</div></div>
          </div>
        </div>
      `;
      document.getElementById("home-btn").addEventListener("click", goHome);
      return;
    }
    const card = state.current;
    const p = state.progress[card.id];
    const isNew = p.state === "new";
    const remaining = state.queue.length + 1;

    if (isNew) {
      // First-ever exposure: show both sides together, no quiz yet
      app.innerHTML = `
        <div class="screen study">
          <div class="topbar">
            <button class="link" id="home-btn">← Home</button>
            <span class="remaining">${remaining} left</span>
          </div>
          <div class="card new-card">
            <div class="badge">New word</div>
            <div class="nl">${escapeHtml(card.nl)}</div>
            <div class="en">${escapeHtml(card.en)}</div>
            <div class="sentence">
              <div class="s-nl">${escapeHtml(card.sNl)}</div>
              <div class="s-en">${escapeHtml(card.sEn)}</div>
            </div>
          </div>
          <button class="primary big" id="got-it-btn">Got it — quiz me on this</button>
        </div>
      `;
      document.getElementById("home-btn").addEventListener("click", goHome);
      document.getElementById("got-it-btn").addEventListener("click", () => {
        introduceCard(card.id);
        nextCard();
      });
      return;
    }

    if (!state.revealed) {
      app.innerHTML = `
        <div class="screen study">
          <div class="topbar">
            <button class="link" id="home-btn">← Home</button>
            <span class="remaining">${remaining} left</span>
          </div>
          <div class="card quiz-card">
            <div class="badge ${p.state}">${p.state === "learning" ? "Learning" : "Review · box " + p.box}</div>
            <div class="nl">${escapeHtml(card.nl)}</div>
            <div class="sentence"><div class="s-nl">${escapeHtml(card.sNl)}</div></div>
          </div>
          <button class="primary big" id="show-btn">Show answer</button>
        </div>
      `;
      document.getElementById("home-btn").addEventListener("click", goHome);
      document.getElementById("show-btn").addEventListener("click", () => {
        state.revealed = true;
        render();
      });
    } else {
      app.innerHTML = `
        <div class="screen study">
          <div class="topbar">
            <button class="link" id="home-btn">← Home</button>
            <span class="remaining">${remaining} left</span>
          </div>
          <div class="card quiz-card revealed">
            <div class="badge ${p.state}">${p.state === "learning" ? "Learning" : "Review · box " + p.box}</div>
            <div class="nl">${escapeHtml(card.nl)}</div>
            <div class="en">${escapeHtml(card.en)}</div>
            <div class="sentence">
              <div class="s-nl">${escapeHtml(card.sNl)}</div>
              <div class="s-en">${escapeHtml(card.sEn)}</div>
            </div>
          </div>
          <div class="grade-row">
            <button class="grade again" id="again-btn">Again</button>
            <button class="grade good" id="good-btn">Good</button>
            <button class="grade easy" id="easy-btn">Easy</button>
          </div>
        </div>
      `;
      document.getElementById("home-btn").addEventListener("click", goHome);
      document.getElementById("again-btn").addEventListener("click", () => {
        gradeCard(card.id, "again");
        // requeue soon within this session so it comes back around
        state.queue.splice(Math.min(4, state.queue.length), 0, card);
        nextCard();
      });
      document.getElementById("good-btn").addEventListener("click", () => {
        gradeCard(card.id, "good");
        nextCard();
      });
      document.getElementById("easy-btn").addEventListener("click", () => {
        gradeCard(card.id, "easy");
        nextCard();
      });
    }
  }

  function goHome() {
    state.screen = "home";
    render();
  }

  function renderBrowse() {
    const pool = cardsForDeckFilter().slice().sort((a, b) => a.nl.localeCompare(b.nl));
    app.innerHTML = `
      <div class="screen browse">
        <div class="topbar">
          <button class="link" id="home-btn">← Home</button>
          <span class="remaining">${pool.length} words</span>
        </div>
        <input type="search" id="search-box" placeholder="Search Dutch or English...">
        <div class="word-list" id="word-list"></div>
      </div>
    `;
    document.getElementById("home-btn").addEventListener("click", goHome);
    const listEl = document.getElementById("word-list");

    function renderList(filter) {
      const f = filter.trim().toLowerCase();
      const filtered = f
        ? pool.filter((c) => c.nl.toLowerCase().includes(f) || c.en.toLowerCase().includes(f))
        : pool;
      listEl.innerHTML = filtered
        .map((c) => {
          const p = state.progress[c.id];
          const statusClass = p.state === "new" ? "new" : p.state === "learning" ? "learning" : p.box >= MASTER_BOX ? "mastered" : "review";
          return `<div class="word-row">
            <span class="dot ${statusClass}"></span>
            <span class="w-nl">${escapeHtml(c.nl)}</span>
            <span class="w-en">${escapeHtml(c.en)}</span>
          </div>`;
        })
        .join("");
    }
    renderList("");
    document.getElementById("search-box").addEventListener("input", (e) => renderList(e.target.value));
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  render();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
