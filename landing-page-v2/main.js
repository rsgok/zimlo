/* Zimlo Landing v2 — interactions */
(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ?snap=1 — deterministic rendering for screenshots/tests
  if (/[?&]snap=1/.test(location.search)) {
    document.documentElement.classList.add("snap");
    document.documentElement.style.scrollBehavior = "auto";
  }

  /* ------------------------------------------------ feed data
     Four scenarios, four templates: summary poster / option pick /
     diff result / approval action — xiaohongshu-style cards. */
  const CARDS = [
    {
      template: "summary",
      kind: "SUMMARY",
      project: "ZIMLO",
      title: "While you slept: 3 tasks shipped",
      takeaway:
        "Relay retries, the schema cleanup, and the offline outbox all landed. Two approvals wait for your coffee.",
      stats: [
        ["3", "shipped"],
        ["128", "tests green"],
        ["0", "failures"],
      ],
      agent: "Codex",
      likes: 128,
    },
    {
      template: "options",
      kind: "QUESTION",
      project: "MACOS",
      title: "Which pairing flow ships first?",
      takeaway: "Pick one — the agent keeps going the moment you decide.",
      options: [
        { key: "A", title: "QR rooms", desc: "Ready now · 2-min pairing expiry" },
        { key: "B", title: "NFC tap", desc: "~1 week · needs PassKit work" },
      ],
      agent: "Codex",
      likes: 46,
    },
    {
      template: "diff",
      kind: "RESULT",
      project: "RELAY",
      title: "Push relay now retries with backoff",
      takeaway: "Duplicate APNs sends dropped 98% in soak tests.",
      diff: [
        ["-", "setTimeout(send, 1000)"],
        ["+", "retry(send, { max: 8 })"],
        ["+", "dedupe(device + hash(payload))"],
      ],
      chips: ["312 tests passed", "98% fewer dupes"],
      agent: "Claude",
      likes: 89,
    },
    {
      template: "approval",
      kind: "APPROVAL",
      project: "CLOUD",
      title: "Drop sessions.legacy_id?",
      takeaway: "Runs on your Mac. Rollback plan included.",
      mediaTitle: "Migration on D1 · production",
      mediaSub: "drizzle/0009_drop_legacy_id.sql",
      points: ["Nothing referenced the column since v0.4", "Zero writes in the last 30 days"],
      agent: "Claude",
      likes: 12,
    },
  ];

  const AUTOPLAY_MS = 4800;

  /* ------------------------------------------------ feed carousel */
  const viewport = document.getElementById("feedViewport");
  const dotsWrap = document.getElementById("feedDots");
  const stage = document.getElementById("phone");

  if (viewport && dotsWrap) {
    let index = 0;
    let timer = null;
    let currentEl = null;
    let sd = false; // scroll-driven mode active
    let suppressClick = false; // swallow the click that ends a drag

    const esc = (s) =>
      s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    const pad = (n) => String(n).padStart(2, "0");

    function mediaHTML(c) {
      if (c.template === "summary") {
        return `<div class="fcard-media media-summary">${c.stats
          .map(([b, s]) => `<div class="ms-stat"><b>${esc(b)}</b><small>${esc(s)}</small></div>`)
          .join("")}</div>`;
      }
      if (c.template === "diff") {
        return `<div class="fcard-media media-diff">${c.diff
          .map(([sign, line]) => `<div class="dl ${sign === "+" ? "plus" : "minus"}">${sign} ${esc(line)}</div>`)
          .join("")}</div>`;
      }
      if (c.template === "approval") {
        return `<div class="fcard-media media-approval">
          <span class="ma-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3 4.5 6v5c0 4.6 3.2 8.4 7.5 10 4.3-1.6 7.5-5.4 7.5-10V6L12 3z"/><path d="M12 9.5v3.5M12 16h.01"/></svg></span>
          <div><b>${esc(c.mediaTitle)}</b><small>${esc(c.mediaSub)}</small></div>
        </div>`;
      }
      return "";
    }

    function bodyHTML(c) {
      let extra = "";
      if (c.template === "options") {
        extra = `<div class="fcard-opts">${c.options
          .map(
            (o) => `<button class="opt" type="button" data-opt="${esc(o.key)}">
              <span class="opt-key">${esc(o.key)}</span>
              <span class="opt-body"><b>${esc(o.title)}</b><small>${esc(o.desc)}</small></span>
              <i class="opt-dot"></i>
            </button>`
          )
          .join("")}</div>`;
      }
      if (c.template === "diff" && c.chips) {
        extra = `<div class="fcard-chips">${c.chips.map((ch) => `<span>${esc(ch)}</span>`).join("")}</div>`;
      }
      if (c.template === "approval") {
        extra =
          `<ul class="fcard-hl">${c.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` +
          `<div class="fcard-acts">
            <button class="act act-yes" type="button" data-act="approve">Approve</button>
            <button class="act act-no" type="button" data-act="decline">Decline</button>
          </div>`;
      }
      return extra;
    }

    function cardHTML(c, i) {
      const avaClass = c.agent === "Codex" ? "codex" : "claude";
      return `
        <header class="fcard-top">
          <span class="fcard-kicker">${esc(c.kind)}<i>|</i>${esc(c.project)}</span>
          <span class="fcard-idx">${pad(i + 1)} / ${pad(CARDS.length)}</span>
        </header>
        ${mediaHTML(c)}
        <h3 class="fcard-headline">${esc(c.title)}</h3>
        <p class="fcard-takeaway">${esc(c.takeaway)}</p>
        ${bodyHTML(c)}
        <footer class="fcard-foot">
          <span class="fcard-ava ${avaClass}">${esc(c.agent[0])}</span>
          <span class="fcard-author">${esc(c.agent)}</span>
          <span class="fcard-likes"><b>♥</b>${c.likes}</span>
        </footer>`;
    }

    // dots
    const dots = CARDS.map((_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", `Go to card ${i + 1}`);
      b.addEventListener("click", () => {
        if (i !== index) userGo(i, i > index ? 1 : -1);
      });
      dotsWrap.appendChild(b);
      return b;
    });

    function render(i, dir = 1) {
      const el = document.createElement("article");
      el.className = "fcard " + (dir >= 0 ? "enter-below" : "enter-above");
      el.innerHTML = cardHTML(CARDS[i], i);
      viewport.appendChild(el);

      const old = currentEl;
      if (old) {
        old.classList.add(dir >= 0 ? "leave-up" : "leave-down");
        setTimeout(() => old.remove(), 600);
      }
      // force reflow so the enter transition runs
      void el.offsetWidth;
      el.classList.remove("enter-below", "enter-above");
      currentEl = el;

      dots.forEach((d, di) => d.classList.toggle("active", di === i));
    }

    const wrap = (i) => ((i % CARDS.length) + CARDS.length) % CARDS.length;

    function setCard(i, dir) {
      index = wrap(i);
      render(index, dir);
    }

    function restart() {
      if (reducedMotion) return;
      clearInterval(timer);
      timer = setInterval(() => {
        if (!document.hidden && !sd) setCard(index + 1, 1);
      }, AUTOPLAY_MS);
    }

    /* Scroll-driven mode: on wide screens the hero is pinned (position: sticky)
       and page scroll flips through the feed cards before the page moves on. */
    const hero = document.getElementById("hero");
    const stageHint = document.getElementById("stageHint");
    const wideQuery = window.matchMedia("(min-width: 1021px)");

    function heroTop() {
      return hero.getBoundingClientRect().top + window.scrollY;
    }

    function scrollToCard(i) {
      const clamped = Math.max(0, Math.min(CARDS.length - 1, i));
      const scrollable = hero.offsetHeight - window.innerHeight;
      const y = heroTop() + ((clamped + 0.5) / CARDS.length) * scrollable;
      window.scrollTo({ top: y, behavior: "smooth" });
    }

    function userGo(i, dir) {
      if (sd) scrollToCard(i);
      else {
        setCard(i, dir);
        restart();
      }
    }

    function onScrollSD() {
      if (!sd) return;
      const scrollable = hero.offsetHeight - window.innerHeight;
      if (scrollable <= 0) return;
      const p = Math.min(Math.max((window.scrollY - heroTop()) / scrollable, 0), 0.9999);
      const i = Math.floor(p * CARDS.length);
      if (i !== index) setCard(i, i > index ? 1 : -1);
    }

    function applyMode() {
      sd =
        !!hero &&
        wideQuery.matches &&
        !reducedMotion &&
        !document.documentElement.classList.contains("snap");
      if (hero) hero.classList.toggle("sd", sd);
      if (stageHint) {
        stageHint.textContent = sd
          ? "Keep scrolling — the feed flips first"
          : "Live mock — swipe up or wait";
      }
      if (sd) {
        clearInterval(timer);
        onScrollSD();
      } else {
        restart();
      }
    }

    // in-card interactions: pick an option, approve / decline
    viewport.addEventListener("click", (e) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const opt = e.target.closest(".opt");
      if (opt && viewport.contains(opt)) {
        opt.parentElement.querySelectorAll(".opt").forEach((o) => o.classList.remove("sel"));
        opt.classList.add("sel");
        return;
      }
      const act = e.target.closest("[data-act]");
      if (act && viewport.contains(act)) {
        const acts = act.closest(".fcard-acts");
        if (!acts || acts.classList.contains("done")) return;
        const approved = act.dataset.act === "approve";
        acts.classList.add("done");
        if (!approved) acts.classList.add("declined");
        acts.innerHTML = approved ? "✓ Approved — sent to your Mac" : "Declined — agent notified";
      }
    });

    // swipe / drag — vertical, like the real feed. Pointer capture is only
    // taken once the gesture becomes a drag, so taps still reach buttons.
    let dragY = null;
    let captured = false;
    viewport.addEventListener("pointerdown", (e) => {
      dragY = e.clientY;
      captured = false;
    });
    viewport.addEventListener("pointermove", (e) => {
      if (dragY === null || !currentEl) return;
      const dy = e.clientY - dragY;
      if (!captured && Math.abs(dy) > 6) {
        captured = true;
        viewport.setPointerCapture(e.pointerId);
        viewport.classList.add("dragging");
        currentEl.classList.add("dragging");
      }
      if (captured) {
        const shrink = 1 - Math.min(Math.abs(dy) * 0.00045, 0.045);
        currentEl.style.transform = `translateY(${dy * 0.6}px) scale(${shrink})`;
      }
    });
    function endDrag(e) {
      if (dragY === null) return;
      const dy = e.clientY - dragY;
      dragY = null;
      if (captured) {
        captured = false;
        viewport.classList.remove("dragging");
        if (currentEl) {
          currentEl.classList.remove("dragging");
          currentEl.style.transform = "";
        }
      }
      // swipe up → next card, swipe down → previous (TikTok direction)
      if (Math.abs(dy) > 52) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 150);
        userGo(dy < 0 ? index + 1 : index - 1, dy < 0 ? 1 : -1);
      }
    }
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);

    // pause autoplay while the user is on the phone (non-scroll-driven mode)
    if (stage) {
      stage.addEventListener("pointerenter", () => clearInterval(timer));
      stage.addEventListener("pointerleave", () => { if (!sd) restart(); });
      stage.addEventListener("focusin", () => clearInterval(timer));
      stage.addEventListener("focusout", () => { if (!sd) restart(); });
    }

    window.addEventListener("scroll", onScrollSD, { passive: true });
    if (wideQuery.addEventListener) wideQuery.addEventListener("change", applyMode);

    render(0);
    applyMode();

    // ?card=N — test hook: pin a specific card, no autoplay / scroll override
    const cardMatch = location.search.match(/[?&]card=(\d+)/);
    if (cardMatch) {
      const n = Math.max(0, Math.min(CARDS.length - 1, Number(cardMatch[1]) - 1));
      clearInterval(timer);
      window.removeEventListener("scroll", onScrollSD);
      setCard(n, 1);
    }

    // ?scrollto=N — test hook: jump to a scroll offset after init (used to
    // screenshot scroll-driven states)
    const scrollMatch = location.search.match(/[?&]scrollto=(\d+)/);
    if (scrollMatch) {
      window.scrollTo(0, Number(scrollMatch[1]));
      onScrollSD();
    }
  }

  /* ------------------------------------------------ reveal on scroll */
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reducedMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add("in");
            io.unobserve(en.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("in"));
  }

  /* ------------------------------------------------ nav state */
  const nav = document.getElementById("nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ------------------------------------------------ beta download */
  const betaBtn = document.getElementById("betaBtn");
  const betaNote = document.getElementById("betaNote");
  const MANIFEST = "https://zimlo-cloud.zimlo.workers.dev/releases/macos/latest.json";

  if (betaBtn) {
    fetch(MANIFEST)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const url = data.url || data.download || data.downloadUrl || data.href;
        if (!url) return;
        betaBtn.href = url;
        betaBtn.textContent = "Download for Mac ↓";
        betaBtn.classList.remove("is-disabled");
        betaBtn.removeAttribute("aria-disabled");
        betaBtn.setAttribute("download", "");
        const bits = [];
        if (data.version) bits.push(`Zimlo ${data.version}`);
        bits.push("Universal app");
        const min = data.minVersion || data.minMacOS || data.minMacos;
        if (min) bits.push(`macOS ${min}+`);
        if (betaNote) betaNote.textContent = bits.join(" · ");
      })
      .catch(() => {
        /* stay in "Beta opening soon" state */
      });
  }
})();
