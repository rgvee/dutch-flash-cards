/* Dutch flashcard trainer — DOM, persistence, and render loop. Scheduling logic lives in scheduler.js. */
(function () {
  "use strict";

  const PROFILES = ["Ram", "Rudrakshi"];
  const MASTER_BOX = Scheduler.MASTER_BOX;

  const CARDS = Scheduler.buildCards(RAW_CARDS);

  // ---------- Per-profile persistence ----------
  function progressKey(profile) {
    return `dutch-fc-progress-v2:${profile}`;
  }
  function settingsKey(profile) {
    return `dutch-fc-settings-v1:${profile}`;
  }

  function loadProgress(profile) {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(progressKey(profile)) || "{}");
    } catch (e) {
      stored = {};
    }
    const progress = {};
    CARDS.forEach((c) => {
      progress[c.id] = stored[c.id] ? Object.assign(Scheduler.freshProgress(c.id), stored[c.id]) : Scheduler.freshProgress(c.id);
    });
    return progress;
  }

  function saveProgress() {
    localStorage.setItem(progressKey(state.profile), JSON.stringify(state.progress));
  }

  function loadSettings(profile) {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem(settingsKey(profile)) || "{}");
    } catch (e) {
      s = {};
    }
    return Object.assign({ newPerSession: 20 }, s);
  }

  function saveSettings() {
    localStorage.setItem(settingsKey(state.profile), JSON.stringify(state.settings));
  }

  const state = {
    profile: null,
    progress: null,
    settings: null,
    queue: [],
    current: null,
    revealed: false,
    optionsChoices: null,
    answeredOption: null,
    screen: "picker",
    newIntroducedThisSession: 0,
    sessionStats: { correct: 0, wrong: 0, graduated: 0 },
  };

  function selectProfile(name) {
    state.profile = name;
    state.progress = loadProgress(name);
    state.settings = loadSettings(name);
    state.screen = "home";
    render();
  }

  // Preferred minimum number of other cards shown before a just-answered
  // card, still on the pre-review ladder, is allowed to reappear. This is a
  // soft preference only — nextCard()'s pickNextDistinctFront is the hard
  // guarantee against an immediate repeat.
  const REQUEUE_GAP = 5;

  function requeueCard(card) {
    const pos = Math.min(REQUEUE_GAP, state.queue.length);
    state.queue.splice(pos, 0, card);
  }

  function introduceCard(cardId) {
    state.progress[cardId] = Scheduler.introduceCard(state.progress[cardId]);
    state.newIntroducedThisSession += 1;
    saveProgress();
    requeueCard(CARDS[cardId]);
  }

  function gradeCard(cardId, grade) {
    const before = state.progress[cardId];
    const wasLearning = before.state === "learning";
    const after = Scheduler.gradeCard(before, grade, Date.now());
    state.progress[cardId] = after;
    if (grade === "right") state.sessionStats.correct += 1;
    else state.sessionStats.wrong += 1;
    if (wasLearning && after.state === "review") state.sessionStats.graduated += 1;
    saveProgress();
    if (after.state === "learning") {
      requeueCard(CARDS[cardId]);
    }
  }

  function buildQueue() {
    return Scheduler.buildQueue(CARDS, state.progress, {
      newPerSession: state.settings.newPerSession,
      newIntroducedThisSession: state.newIntroducedThisSession,
      now: Date.now(),
    });
  }

  function stats() {
    const now = Date.now();
    let n = 0, learning = 0, review = 0, mastered = 0, due = 0;
    CARDS.forEach((c) => {
      const p = state.progress[c.id];
      if (p.state === "new") n++;
      else if (p.state === "learning") {
        learning++;
        due++; // always immediately available within a session
      } else {
        review++;
        if (p.box >= MASTER_BOX) mastered++;
        if (p.dueAt <= now) due++;
      }
    });
    return { total: CARDS.length, n, learning, review, mastered, due };
  }

  // ---------- Rendering ----------
  const app = document.getElementById("app");

  function render() {
    if (state.screen === "picker") renderPicker();
    else if (state.screen === "home") renderHome();
    else if (state.screen === "study") renderStudy();
    else if (state.screen === "browse") renderBrowse();
  }

  function renderPicker() {
    app.innerHTML = `
      <div class="screen picker">
        <h1>Dutch Flashcards</h1>
        <p class="subtitle">Who's studying?</p>
        <div class="profile-list">
          ${PROFILES.map((p) => `<button class="primary big profile-btn" data-profile="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join("")}
        </div>
      </div>
    `;
    app.querySelectorAll(".profile-btn").forEach((btn) => {
      btn.addEventListener("click", () => selectProfile(btn.dataset.profile));
    });
  }

  function renderHome() {
    const s = stats();
    app.innerHTML = `
      <div class="screen home">
        <div class="topbar">
          <h1>Dutch Flashcards</h1>
          <button class="link" id="switch-profile-btn">${escapeHtml(state.profile)} · switch</button>
        </div>
        <p class="subtitle">${s.total} words loaded</p>

        <div class="stat-grid">
          <div class="stat"><span class="num">${s.n}</span><span class="lbl">New</span></div>
          <div class="stat"><span class="num">${s.learning}</span><span class="lbl">Learning</span></div>
          <div class="stat"><span class="num">${s.review}</span><span class="lbl">Review</span></div>
          <div class="stat"><span class="num">${s.mastered}</span><span class="lbl">Mastered</span></div>
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

    document.getElementById("switch-profile-btn").addEventListener("click", () => {
      state.screen = "picker";
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
      if (confirm(`Reset ALL learning progress for ${state.profile}? This cannot be undone.`)) {
        state.progress = {};
        CARDS.forEach((c) => (state.progress[c.id] = Scheduler.freshProgress(c.id)));
        saveProgress();
        render();
      }
    });
  }

  function startStudy() {
    state.newIntroducedThisSession = 0;
    state.sessionStats = { correct: 0, wrong: 0, graduated: 0 };
    state.queue = buildQueue();
    state.screen = "study";
    nextCard();
  }

  // Hard guarantee: never show the same word twice in a row. REQUEUE_GAP
  // spacing is a preference the queue can still violate near-empty; this is
  // the backstop — it looks ahead (and rebuilds once) for any other
  // candidate before allowing a repeat, only giving in when the scheduler
  // confirms there's truly nothing else due.
  function pickNextDistinctFront(prevId) {
    if (state.queue.length === 0) {
      state.queue = buildQueue();
    }
    if (prevId === null) return;
    let idx = state.queue.findIndex((c) => c.id !== prevId);
    if (idx === -1) {
      const rebuilt = buildQueue();
      const altIdx = rebuilt.findIndex((c) => c.id !== prevId);
      if (altIdx !== -1) {
        state.queue = rebuilt;
        idx = altIdx;
      }
    }
    if (idx > 0) {
      const [card] = state.queue.splice(idx, 1);
      state.queue.unshift(card);
    }
  }

  function nextCard() {
    const prevId = state.current ? state.current.id : null;
    pickNextDistinctFront(prevId);
    state.current = state.queue.shift() || null;
    state.revealed = false;
    state.optionsChoices = null;
    state.answeredOption = null;
    if (state.current !== null) {
      const p = state.progress[state.current.id];
      if (Scheduler.roundMode(p) === "options") {
        state.optionsChoices = Scheduler.buildOptionsChoices(CARDS, state.current, 4);
      }
    }
    render();
  }

  function endSession() {
    state.screen = "study";
    state.current = null;
    render();
  }

  function renderSummary() {
    const s = state.sessionStats;
    const answered = s.correct + s.wrong;
    const genuinelyDone = buildQueue().length === 0;
    app.innerHTML = `
      <div class="screen study">
        <div class="topbar">
          <button class="link" id="home-btn">← Home</button>
        </div>
        <div class="card summary-card">
          <div class="badge">Session summary</div>
          <div class="nl">Nice work! 🎉</div>
          <div class="sentence"><div class="s-en">${
            genuinelyDone
              ? "Everything you've introduced has graduated to Review. More will unlock as reviews come due, or start again to introduce new words."
              : "Come back anytime to keep going — there's more due whenever you are."
          }</div></div>
        </div>
        <div class="stat-grid">
          <div class="stat"><span class="num">${state.newIntroducedThisSession}</span><span class="lbl">New words</span></div>
          <div class="stat"><span class="num">${answered}</span><span class="lbl">Answered</span></div>
          <div class="stat"><span class="num">${s.correct}</span><span class="lbl">Right</span></div>
          <div class="stat"><span class="num">${s.graduated}</span><span class="lbl">Graduated</span></div>
        </div>
        <button class="primary big" id="home-again-btn">Back home</button>
      </div>
    `;
    document.getElementById("home-btn").addEventListener("click", goHome);
    document.getElementById("home-again-btn").addEventListener("click", goHome);
  }

  function renderStudy() {
    if (state.current === null) {
      renderSummary();
      return;
    }
    const card = state.current;
    const p = state.progress[card.id];
    const mode = Scheduler.roundMode(p);
    const remaining = state.queue.length + 1;

    if (mode === "new") {
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
          <button class="primary big" id="next-btn">Next</button>
        </div>
      `;
      document.getElementById("home-btn").addEventListener("click", endSession);
      document.getElementById("next-btn").addEventListener("click", () => {
        introduceCard(card.id);
        nextCard();
      });
      return;
    }

    if (mode === "options") {
      renderOptionsRound(card, p, remaining);
      return;
    }

    // mode is 'learning' or 'review' — blind recall
    const badgeLabel = mode === "learning" ? "Learning" : "Review · box " + p.box;
    if (!state.revealed) {
      app.innerHTML = `
        <div class="screen study">
          <div class="topbar">
            <button class="link" id="home-btn">← Home</button>
            <span class="remaining">${remaining} left</span>
          </div>
          <div class="card quiz-card">
            <div class="badge ${mode}">${badgeLabel}</div>
            <div class="nl">${escapeHtml(card.nl)}</div>
            <div class="sentence"><div class="s-nl">${escapeHtml(card.sNl)}</div></div>
          </div>
          <button class="primary big" id="show-btn">Show answer</button>
        </div>
      `;
      document.getElementById("home-btn").addEventListener("click", endSession);
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
            <div class="badge ${mode}">${badgeLabel}</div>
            <div class="nl">${escapeHtml(card.nl)}</div>
            <div class="en">${escapeHtml(card.en)}</div>
            <div class="sentence">
              <div class="s-nl">${escapeHtml(card.sNl)}</div>
              <div class="s-en">${escapeHtml(card.sEn)}</div>
            </div>
          </div>
          <div class="grade-row">
            <button class="grade wrong" id="wrong-btn">Wrong</button>
            <button class="grade right" id="right-btn">Right</button>
          </div>
        </div>
      `;
      document.getElementById("home-btn").addEventListener("click", endSession);
      document.getElementById("wrong-btn").addEventListener("click", () => {
        gradeCard(card.id, "wrong");
        nextCard();
      });
      document.getElementById("right-btn").addEventListener("click", () => {
        gradeCard(card.id, "right");
        nextCard();
      });
    }
  }

  function renderOptionsRound(card, p, remaining) {
    const answered = state.answeredOption !== null;
    app.innerHTML = `
      <div class="screen study">
        <div class="topbar">
          <button class="link" id="home-btn">← Home</button>
          <span class="remaining">${remaining} left</span>
        </div>
        <div class="card quiz-card">
          <div class="badge options">Pick the meaning</div>
          <div class="nl">${escapeHtml(card.nl)}</div>
          <div class="sentence"><div class="s-nl">${escapeHtml(card.sNl)}</div></div>
        </div>
        <div class="options-list">
          ${state.optionsChoices
            .map((choice, i) => {
              let cls = "option-btn";
              if (answered) {
                if (choice === card.en) cls += " correct";
                else if (i === state.answeredOption) cls += " incorrect";
              }
              return `<button class="${cls}" data-index="${i}" ${answered ? "disabled" : ""}>${escapeHtml(choice)}</button>`;
            })
            .join("")}
        </div>
        ${answered ? '<button class="primary big" id="next-btn">Next</button>' : ""}
      </div>
    `;
    document.getElementById("home-btn").addEventListener("click", endSession);

    if (!answered) {
      app.querySelectorAll(".option-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const i = Number(btn.dataset.index);
          const isCorrect = state.optionsChoices[i] === card.en;
          state.answeredOption = i;
          gradeCard(card.id, isCorrect ? "right" : "wrong");
          render();
        });
      });
    } else {
      document.getElementById("next-btn").addEventListener("click", nextCard);
    }
  }

  function goHome() {
    state.screen = "home";
    render();
  }

  function renderBrowse() {
    const pool = CARDS.slice().sort((a, b) => a.nl.localeCompare(b.nl));
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

  document.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "ArrowRight") return;
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const nextBtn = document.getElementById("next-btn");
    if (nextBtn) {
      e.preventDefault();
      nextBtn.click();
    }
  });

  render();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
