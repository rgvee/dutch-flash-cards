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
    return Object.assign({ newPerSession: 20, soundOn: true }, s);
  }

  // ---------- Sound ----------
  // Synthesized tones (no audio assets to fetch/cache) — kept quiet and
  // short so they add feedback without becoming annoying over a long
  // session. Muteable per-profile via the Home screen toggle.
  let audioCtx = null;
  function playTone(freq, duration, volume) {
    if (!state.settings || !state.settings.soundOn) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {}
  }
  function playTap() {
    playTone(600, 0.06, 0.05);
  }
  function playCorrect() {
    playTone(660, 0.09, 0.06);
    setTimeout(() => playTone(880, 0.12, 0.06), 80);
  }
  function playWrong() {
    playTone(220, 0.18, 0.05);
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
    currentMode: null,
    newIntroducedThisSession: 0,
    reviewOnly: false,
    sessionStats: { correct: 0, wrong: 0, graduated: 0 },
  };

  function selectProfile(name) {
    state.profile = name;
    state.progress = loadProgress(name);
    state.settings = loadSettings(name);
    state.screen = "home";
    render();
  }

  // Preferred number of other cards shown before a just-answered card, still
  // on the pre-review ladder, is allowed to reappear. Randomized within a
  // range (rather than a fixed gap) so repeats land at unpredictable spots
  // instead of every Nth card, cutting the recency effect of seeing the same
  // word again right after a short, fixed interval. This is a soft
  // preference only — nextCard()'s pickNextDistinctFront is the hard
  // guarantee against an immediate repeat.
  const REQUEUE_GAP_MIN = 8;
  const REQUEUE_GAP_MAX = 14;

  function requeueCard(card) {
    const gap = REQUEUE_GAP_MIN + Math.floor(Math.random() * (REQUEUE_GAP_MAX - REQUEUE_GAP_MIN + 1));
    const pos = Math.min(gap, state.queue.length);
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
    if (grade === "right") playCorrect();
    else playWrong();
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
      newPerSession: state.reviewOnly ? 0 : state.settings.newPerSession,
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
          <div>
            <button class="link" id="sound-toggle-btn">${state.settings.soundOn ? "🔊" : "🔇"}</button>
            <button class="link" id="switch-profile-btn">${escapeHtml(state.profile)} · switch</button>
          </div>
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
        <button class="secondary" id="review-btn" ${s.due > 0 ? "" : "disabled"}>${s.due > 0 ? "Review only (" + s.due + ")" : "Nothing due for review"}</button>
        <button class="secondary" id="browse-btn">Browse all words</button>
        <button class="link danger" id="reset-btn">Reset all progress</button>
      </div>
    `;

    document.getElementById("switch-profile-btn").addEventListener("click", () => {
      state.screen = "picker";
      render();
    });
    document.getElementById("sound-toggle-btn").addEventListener("click", () => {
      state.settings.soundOn = !state.settings.soundOn;
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
    document.getElementById("study-btn").addEventListener("click", () => startStudy(false));
    document.getElementById("review-btn").addEventListener("click", () => startStudy(true));
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

  function startStudy(reviewOnly) {
    state.reviewOnly = !!reviewOnly;
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
      state.currentMode = Scheduler.roundMode(p);
      if (state.currentMode === "options") {
        state.optionsChoices = Scheduler.buildOptionsChoices(CARDS, state.current, 4);
      }
    } else {
      state.currentMode = null;
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
    // Frozen at pick-time (nextCard), not recomputed here — grading a round
    // mutates progress synchronously, and a bare render() (e.g. after an
    // Options click) must keep showing the round just answered, not
    // teleport to whatever mode the card's progress just advanced into.
    const mode = state.currentMode;
    const remaining = state.queue.length + 1;

    if (mode === "new") {
      app.innerHTML = `
        <div class="screen study">
          <div class="topbar">
            <button class="link" id="home-btn">← Home</button>
            <span class="remaining">${remaining} left${state.reviewOnly ? " · Review" : ""}</span>
          </div>
          <div class="card new-card">
            <div class="badge">New word</div>
            <div class="nl">${escapeHtml(card.nl)}</div>
            <div class="en">${escapeHtml(card.en)}</div>
            <div class="sentence">
              <div class="s-nl">${escapeHtml(card.sNl)}</div>
              <div class="s-en">${escapeHtml(card.sEn)}</div>
            </div>
            ${renderBreakdown(card)}
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
            <span class="remaining">${remaining} left${state.reviewOnly ? " · Review" : ""}</span>
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
            <span class="remaining">${remaining} left${state.reviewOnly ? " · Review" : ""}</span>
          </div>
          <div class="card quiz-card revealed">
            <div class="badge ${mode}">${badgeLabel}</div>
            <div class="nl">${escapeHtml(card.nl)}</div>
            <div class="en">${escapeHtml(card.en)}</div>
            <div class="sentence">
              <div class="s-nl">${escapeHtml(card.sNl)}</div>
              <div class="s-en">${escapeHtml(card.sEn)}</div>
            </div>
            ${renderBreakdown(card)}
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
          <span class="remaining">${remaining} left${state.reviewOnly ? " · Review" : ""}</span>
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

  const TOPIC_GROUPS = [
    { key: "pronouns", label: "Pronouns & Basics" },
    { key: "time", label: "Time & Frequency" },
    { key: "numbers", label: "Numbers & Quantity" },
    { key: "bureaucracy", label: "Housing, Municipal & Bureaucracy" },
    { key: "work", label: "Work, Career & Education" },
    { key: "medical", label: "Medical, Health & Safety" },
    { key: "shopping", label: "Shopping, Money & Transport" },
    { key: "opposites", label: "Opposites & Descriptive" },
    { key: "social", label: "People & Social Life" },
    { key: "household", label: "Household, Objects & Food" },
    { key: "places", label: "Places & Facilities" },
    { key: "connectors", label: "Connectors & Communication" },
    { key: "misc", label: "General Verbs & Misc" },
  ];
  const TOPIC_ORDER = TOPIC_GROUPS.reduce((m, g, i) => ((m[g.key] = i), m), {});

  const TOPIC_MAP = {
    // Time & Frequency
    "planning": "time", "opnieuw": "time", "wanneer": "time", "jaarlijkse": "time",
    "regelmatig": "time", "zo snel mogelijk": "time", "uiterlijk": "time", "tijdens": "time",
    "openingstijden": "time", "altijd": "time", "op elk moment": "time", "werkdagen": "time",
    "weekend": "time", "nooit": "time", "te lang": "time", "telefonisch spreekuur": "time",
    "vakantie": "time", "hoe lang": "time", "straks": "time", "vaker": "time", "hoe vaak": "time",
    "overdag": "time", "'s avonds": "time", "afspreken": "time", "toen": "time", "vorig jaar": "time",
    "doordeweeks": "time", "beschikbaar": "time", "eerder": "time", "gisteren": "time",
    "werkrooster": "time", "op tijd": "time", "verplaatst": "time", "vakantierooster": "time",
    "achter elkaar": "time", "volgende week": "time", "maand": "time", "tot": "time", "rooster": "time",
    "volgende maand": "time", "langer": "time", "van tevoren": "time", "vanaf": "time", "weer": "time",
    "doorgaan": "time", "feestdagen": "time", "een afspraak maken": "time", "vóór": "time",
    "gedurende": "time", "tijdelijk": "time", "aansluitend/direct na": "time", "vroeg": "time",
    "laat": "time", "beginnen": "time",
    // Numbers & Quantity
    "verschillende": "numbers", "het eerste": "numbers", "een beetje": "numbers", "extra/meer": "numbers",
    "meest": "numbers", "meest geschikt": "numbers", "hoeveel": "numbers", "bestaat uit": "numbers",
    "zoveel mogelijk": "numbers", "niets": "numbers", "overig": "numbers", "te weinig": "numbers",
    "weinig": "numbers", "volgorde": "numbers", "sommige": "numbers", "eerste": "numbers",
    "1 keer": "numbers", "derde": "numbers", "laatste": "numbers", "genoeg": "numbers",
    "minder": "numbers", "iedereen": "numbers", "uitrekenen": "numbers", "soorten": "numbers",
    "het enige": "numbers", "hetzelfde": "numbers", "voldoende": "numbers", "allemaal": "numbers",
    "iedere": "numbers", "andere": "numbers", "alleen": "numbers", "te veel": "numbers",
    "de rest": "numbers", "ten minste/minimaal": "numbers", "maximaal/ten hoogste": "numbers",
    "stijgen/toenemen": "numbers", "dalen/afnemen": "numbers", "alles": "numbers", "optioneel": "numbers",
    "verschillende/diverse": "numbers",
    // Housing, Municipal & Bureaucracy
    "dorpsbewoner": "bureaucracy", "verdieping/etage": "bureaucracy", "aanmelden": "bureaucracy",
    "eigenaar": "bureaucracy", "buurthuis": "bureaucracy", "persoonlijke gegevens": "bureaucracy",
    "rijbewijs": "bureaucracy", "schriftelijk": "bureaucracy", "ziek melden": "bureaucracy",
    "buurtbijeenkomst": "bureaucracy", "buurt": "bureaucracy", "buurbewoners": "bureaucracy",
    "afmelden": "bureaucracy", "verhuizen": "bureaucracy", "aanvragen": "bureaucracy",
    "gemeente": "bureaucracy", "gebouw": "bureaucracy", "verbouwing": "bureaucracy",
    "de regels": "bureaucracy", "nieuwsbrief": "bureaucracy", "opzegtermijn": "bureaucracy",
    "vervallen": "bureaucracy", "vergunning": "bureaucracy", "voorwaarden": "bureaucracy",
    "toestemming": "bureaucracy", "onderhoudswerkzaamheden": "bureaucracy", "afvalinzameling": "bureaucracy",
    "grofvuil": "bureaucracy", "parkeerbeleid": "bureaucracy", "berichtenbox": "bureaucracy",
    "ziekmelden": "bureaucracy", "afzeggen/annuleren": "bureaucracy", "toegestaan": "bureaucracy",
    "verboden": "bureaucracy",
    // Work, Career & Education
    "bladzijde/pagina": "work", "onthouden": "work", "pauze": "work", "uitleggen": "work",
    "tekst": "work", "basisschool/lagere school": "work", "medewerkers": "work", "verdienen": "work",
    "afspraak": "work", "cv": "work", "vacature": "work", "een baan": "work", "werkervaring": "work",
    "leidinggevende": "work", "open dag": "work", "fouten": "work", "taal": "work", "afgemaakt": "work",
    "geslaagd": "work", "vergadering": "work", "ervaring": "work", "geschiedenis": "work",
    "oefenen": "work", "theorieboek": "work", "inschrijven": "work", "aan het werk": "work",
    "kennis": "work", "studeren": "work", "werken": "work", "taken": "work", "cursus": "work",
    "baan": "work", "opleiding": "work", "folder": "work", "studiecentrum": "work", "lokaal": "work",
    "opletten": "work", "inhalen": "work", "toets": "work", "woordenboek": "work", "opdrachten": "work",
    "afdeling": "work", "vereiste/verplicht": "work", "ervaring is een pré": "work",
    "aanwezigheid": "work", "behalen/slagen": "work", "zakken": "work", "vast/permanent": "work",
    "taak": "work",
    // Medical, Health & Safety
    "ehbo": "medical", "verzorgers": "medical", "reanimeren": "medical", "kiespijn": "medical",
    "nood nummer": "medical", "kindertandarts": "medical", "spoed": "medical", "bedrijfsarts": "medical",
    "tandarts": "medical", "voorschrift/recept": "medical", "lege maag": "medical",
    "bijwerkingen": "medical", "spoedgeval": "medical", "nabloeding": "medical", "betreden": "medical",
    "veiligheidsvoorschrift": "medical", "slecht ter been": "medical", "gevaarlijk": "medical",
    "veilig": "medical",
    // Shopping, Money & Transport
    "wegslepen": "shopping", "gekocht/kopen": "shopping", "betalen": "shopping", "bezorging": "shopping",
    "levertijd": "shopping", "klantenservice": "shopping", "trein": "shopping", "ophalen": "shopping",
    "cadeaubon": "shopping", "geld": "shopping", "gebruikte spullen": "shopping", "verkopen": "shopping",
    "gratis": "shopping", "scooter": "shopping", "abonnement": "shopping", "ruilen": "shopping",
    "klantenkaart": "shopping", "verkopers": "shopping", "vertrekken": "shopping", "kosten": "shopping",
    "duurder": "shopping", "hoe duur": "shopping", "winkels": "shopping", "bestellen": "shopping",
    "winkel": "shopping", "bushalte": "shopping", "opstappen": "shopping", "klanten": "shopping",
    "vergoeding": "shopping", "afgeprijsd": "shopping", "wisselbon/tegoedbon": "shopping",
    "kassabon": "shopping", "vervangend vervoer": "shopping", "reistijd": "shopping",
    "vertraging": "shopping", "in rekening brengen": "shopping", "goedkoop": "shopping",
    "duur": "shopping", "betaald": "shopping", "vertrek": "shopping", "aankomst": "shopping",
    "blauwe zone": "shopping", "vertraagd": "shopping",
    // Opposites & Descriptive
    "rustig": "opposites", "belangrijk": "opposites", "kapot/stuk": "opposites", "geopend": "opposites",
    "gesloten": "opposites", "beter": "opposites", "moeilijk": "opposites", "makkelijk": "opposites",
    "boven": "opposites", "beneden": "opposites", "door elkaar": "opposites", "nieuw": "opposites",
    "vies": "opposites", "bijzonder": "opposites", "gezellig": "opposites", "druk": "opposites",
    "schoon": "opposites", "bekend": "opposites", "vriendelijk": "opposites", "tevreden": "opposites",
    "gebroken": "opposites", "dicht": "opposites", "normaal": "opposites", "dicht/gesloten": "opposites",
    "stil zitten": "opposites", "netjes": "opposites", "fijn": "opposites", "vervelend": "opposites",
    "slim": "opposites", "simpel": "opposites", "rondom": "opposites", "vol": "opposites",
    "leeg": "opposites", "juist/goed": "opposites", "onjuist/fout": "opposites",
    "voorkant/voorzijde": "opposites", "achterkant/achterzijde": "opposites", "naar boven": "opposites",
    "naar beneden": "opposites", "links": "opposites", "rechts": "opposites", "dichtbij": "opposites",
    "ver weg": "opposites", "open": "opposites", "vrij": "opposites", "bezet": "opposites",
    "muzikaal": "opposites",
    // People & Social Life
    "leeftijd": "social", "feest": "social", "afscheid nemen": "social", "activiteit": "social",
    "spelletjes": "social", "bezoek": "social", "samen": "social", "mensen": "social",
    "kermis": "social", "elkaar": "social", "missen": "social", "foto's": "social",
    "dochtertje": "social", "vieren": "social", "getrouwd": "social", "lied": "social",
    "geholpen/helpen": "social", "kinderen": "social", "meedoen": "social", "bruiloft": "social",
    "cadeau": "social", "verrassing": "social", "feestcommissie": "social", "ouders": "social",
    "bijeenkomsten": "social", "goede doelen": "social", "vrijwilligers": "social",
    "vrijwillig": "social", "helpen": "social", "uitnodiging": "social", "optreden": "social",
    "thema": "social", "muziek": "social", "activiteiten": "social", "anderen": "social",
    "meemogen": "social",
    // Household, Objects & Food
    "zwemkleding": "household", "handdoek": "household", "bureau": "household", "rits": "household",
    "rugtas": "household", "bril": "household", "portemonnee": "household", "lunch": "household",
    "sportkleding": "household", "brood": "household", "dweilen": "household", "hapjes": "household",
    "drankjes": "household", "pannenkoeken": "household", "gereedschap": "household", "hout": "household",
    "meubel": "household", "stofzuigen": "household", "speelgoed": "household", "schoonmaken": "household",
    "knipbeurt": "household", "wassen": "household", "knippen": "household", "boek": "household",
    // Places & Facilities
    "plek/plaats": "places", "omgeving": "places", "portier": "places", "naartoe": "places",
    "kinderboerderij": "places", "receptie": "places", "praktijk": "places", "buitenland": "places",
    "buiten": "places", "secretariaat": "places", "ontvangst": "places", "plekken": "places",
    "balie": "places", "de weg": "places", "begane grond": "places", "kantine": "places",
    "zwembad": "places", "ingang": "places", "uitgang": "places",
    // Connectors & Communication
    "of": "connectors", "daarom": "connectors", "oproepen": "connectors", "vooral": "connectors",
    "vragen": "connectors", "bereiken": "connectors", "bereikbaar": "connectors",
    "bespreken": "connectors", "bedanken": "connectors", "zonder": "connectors", "echt": "connectors",
    "het is jammer": "connectors", "niet alleen": "connectors", "waarom": "connectors",
    "sturen": "connectors", "vinden": "connectors", "opsturen": "connectors", "daarover": "connectors",
    "laten weten": "connectors", "daarmee": "connectors", "helaas": "connectors",
    "namelijk": "connectors", "telefoon opnemen": "connectors", "reden": "connectors",
    "praten": "connectors", "natuurlijk": "connectors", "misschien": "connectors",
    "omdat": "connectors", "waar": "connectors", "bellen": "connectors", "maar": "connectors",
    "trouwens": "connectors", "ik heb geen idee": "connectors", "dat weet ze niet": "connectors",
    "de reden": "connectors", "behalve/uitgezonderd": "connectors", "tenzij": "connectors",
    "rekening houden met": "connectors",
    // General Verbs & Misc
    "nadenken": "misc", "inhoud": "misc", "manier": "misc", "bepalen/besluiten": "misc",
    "neem": "misc", "weghalen": "misc", "meenemen": "misc", "aanraden/adviseren": "misc",
    "vergeten": "misc", "merken": "misc", "zelf": "misc", "kiezen": "misc", "gekozen/kiezen": "misc",
    "geregeld": "misc", "weggooien": "misc", "repareren": "misc", "maken": "misc",
    "terugbrengen": "misc", "spullen/dingen": "misc", "controleren": "misc", "proberen": "misc",
    "kunnen": "misc", "zetten": "misc", "veranderingen": "misc", "gebruiken": "misc",
    "durven": "misc", "moeite": "misc", "schuiven": "misc", "deden": "misc", "stoppen": "misc",
    "blijven": "misc", "groeien": "misc", "voordeel": "misc", "nadeel": "misc", "omgaan met": "misc",
    "probleem": "misc", "zoeken": "misc", "ontwerpen": "misc", "nodig": "misc", "weten": "misc",
    "veranderen": "misc", "horen": "misc", "willen": "misc", "repareren/maken": "misc",
    "overzicht/schema": "misc", "mogen": "misc", "overslaan": "misc",
    "uitzoeken": "misc", "opgeven": "misc", "moeten": "misc", "vertellen": "connectors",
    "informatie": "connectors", "basis": "work", "werktijden": "time",
    // Pronouns & Basics
    "ik": "pronouns", "jij / je": "pronouns", "hij": "pronouns", "zij / ze": "pronouns",
    "wij / we": "pronouns", "jullie": "pronouns", "u": "pronouns", "mijn": "pronouns",
    "jouw": "pronouns", "zijn": "pronouns",
    "hebben": "misc", "doen": "misc", "gaan": "misc", "komen": "misc",
    "en": "connectors", "dus": "connectors", "ook": "connectors", "dan": "connectors",
    "als": "connectors", "met": "connectors", "wat": "connectors",
  };

  function getTopic(card) {
    return TOPIC_MAP[card.nl.trim().toLowerCase()] || "misc";
  }

  const BROWSE_COLUMNS = [
    { key: "en", label: "English", cls: "w-en", get: (c) => c.en },
    { key: "breakdown", label: "Breakdown", cls: "w-breakdown", get: (c) => c.breakdown || "—" },
    { key: "sentence", label: "Sentence", cls: "w-sentence", get: (c) => c.sNl || "—" },
    { key: "meaning", label: "Meaning", cls: "w-meaning", get: (c) => c.sEn || "—" },
  ];

  function renderBrowse() {
    if (state.browseSort === undefined) state.browseSort = "alpha";
    if (state.browseCols === undefined) {
      state.browseCols = { en: true, breakdown: false, sentence: false, meaning: false };
    }

    app.innerHTML = `
      <div class="screen browse">
        <div class="browse-sticky">
          <div class="topbar">
            <button class="link" id="home-btn">← Home</button>
            <span class="remaining" id="word-count"></span>
          </div>
          <input type="search" id="search-box" placeholder="Search Dutch or English...">
          <div class="browse-controls">
            <select id="sort-select">
              <option value="alpha">Sort: A–Z</option>
              <option value="default">Sort: Default order</option>
              <option value="topic">Sort: By topic</option>
            </select>
            <div class="col-toggles">
              ${BROWSE_COLUMNS.map(
                (col) => `<label class="hide-toggle">
                  <input type="checkbox" class="col-cb" data-col="${col.key}">
                  ${col.label}
                </label>`
              ).join("")}
            </div>
            <span class="kbd-hint">Press <kbd>A</kbd> English · <kbd>B</kbd> breakdown · <kbd>S</kbd> sentence · <kbd>M</kbd> meaning</span>
          </div>
          <div class="word-table-header" id="word-table-header"></div>
        </div>
        <div class="word-table">
          <div id="word-list"></div>
        </div>
      </div>
    `;
    document.getElementById("home-btn").addEventListener("click", goHome);
    const listEl = document.getElementById("word-list");
    const headerEl = document.getElementById("word-table-header");
    const countEl = document.getElementById("word-count");
    const sortSelect = document.getElementById("sort-select");
    sortSelect.value = state.browseSort;
    document.querySelectorAll(".col-cb").forEach((cb) => {
      cb.checked = state.browseCols[cb.dataset.col];
    });

    function visibleColumns() {
      return BROWSE_COLUMNS.filter((col) => state.browseCols[col.key]);
    }

    function getPool() {
      const pool = CARDS.slice();
      if (state.browseSort === "alpha") pool.sort((a, b) => a.nl.localeCompare(b.nl));
      if (state.browseSort === "topic") {
        pool.sort((a, b) => {
          const ta = TOPIC_ORDER[getTopic(a)];
          const tb = TOPIC_ORDER[getTopic(b)];
          if (ta !== tb) return ta - tb;
          return a.nl.localeCompare(b.nl);
        });
      }
      return pool;
    }

    function renderHeader() {
      const cols = visibleColumns();
      headerEl.innerHTML =
        `<span class="row-index"></span><span class="dot-spacer"></span><span class="w-nl">Dutch</span>` +
        cols.map((col) => `<span class="${col.cls}">${col.label}</span>`).join("");
    }

    function renderList(filter) {
      const f = filter.trim().toLowerCase();
      const pool = getPool();
      const filtered = f
        ? pool.filter((c) => c.nl.toLowerCase().includes(f) || c.en.toLowerCase().includes(f))
        : pool;
      countEl.textContent = `${filtered.length} words`;
      const cols = visibleColumns();
      const showGroups = state.browseSort === "topic";
      let lastTopic = null;
      listEl.innerHTML = filtered
        .map((c, i) => {
          const p = state.progress[c.id];
          const statusClass = p.state === "new" ? "new" : p.state === "learning" ? "learning" : p.box >= MASTER_BOX ? "mastered" : "review";
          const cells = cols.map((col) => `<span class="${col.cls}">${escapeHtml(col.get(c))}</span>`).join("");
          let groupHeader = "";
          if (showGroups) {
            const topic = getTopic(c);
            if (topic !== lastTopic) {
              lastTopic = topic;
              const group = TOPIC_GROUPS[TOPIC_ORDER[topic]];
              groupHeader = `<div class="group-header">${escapeHtml(group.label)}</div>`;
            }
          }
          return `${groupHeader}<div class="word-row">
            <span class="row-index">${i + 1}</span>
            <span class="dot ${statusClass}"></span>
            <span class="w-nl">${escapeHtml(c.nl)}</span>
            ${cells}
          </div>`;
        })
        .join("");
    }

    function refresh() {
      renderHeader();
      renderList(document.getElementById("search-box").value || "");
    }

    refresh();
    document.getElementById("search-box").addEventListener("input", (e) => renderList(e.target.value));
    sortSelect.addEventListener("change", (e) => {
      state.browseSort = e.target.value;
      renderList(document.getElementById("search-box").value);
    });
    document.querySelectorAll(".col-cb").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        state.browseCols[e.target.dataset.col] = e.target.checked;
        refresh();
      });
    });
  }

  function renderBreakdown(card) {
    if (!card.breakdown) return "";
    return `<div class="breakdown">${escapeHtml(card.breakdown)}</div>`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Generic tap feedback on any button press. Grade/option buttons are
  // skipped since gradeCard() already plays a more meaningful contextual
  // correct/wrong sound for those.
  app.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.classList.contains("grade") || btn.classList.contains("option-btn")) return;
    playTap();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;

    if (e.key === " " || e.key === "ArrowRight") {
      const nextBtn = document.getElementById("next-btn");
      if (nextBtn) {
        e.preventDefault();
        nextBtn.click();
      }
      return;
    }

    const colKey = { a: "en", b: "breakdown", s: "sentence", m: "meaning" }[e.key.toLowerCase()];
    if (colKey) {
      const cb = document.querySelector(`.col-cb[data-col="${colKey}"]`);
      if (cb) {
        e.preventDefault();
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      }
    }
  });

  render();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
