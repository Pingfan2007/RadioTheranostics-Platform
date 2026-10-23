/* =========================================================================
   Brussels RadioTheranostics Platform — knowledge graph client
   Vanilla ES2020, no build step, no runtime dependencies.
   ========================================================================= */
(() => {
  "use strict";

  /* ── design tokens & vocabulary ─────────────────────────────────────── */

  const TYPES = {
    drug:     { label: "Drug",       plural: "Drugs",       color: "#5293c9", shape: "circle" },
    nuclide:  { label: "Nuclide",    plural: "Nuclides",    color: "#163a57", shape: "hex"    },
    target:   { label: "Target",     plural: "Targets",     color: "#2b6288", shape: "diamond"},
    disease:  { label: "Indication", plural: "Indications", color: "#97ceff", shape: "rect"   },
    chelator: { label: "Chelator",   plural: "Chelators",   color: "#6da9d4", shape: "tri"    },
    linker:   { label: "Linker",     plural: "Linkers",     color: "#9cc4e0", shape: "square" },
    vector:   { label: "Vector",     plural: "Vectors",     color: "#b2d0e8", shape: "penta"  }
  };

  const RELS = {
    CONTAINS_NUCLIDE: { label: "contains nuclide", color: "#163a57" },
    TARGETS:          { label: "targets",          color: "#2b6288" },
    INDICATED_FOR:    { label: "indicated for",    color: "#5293c9" },
    USES_CHELATOR:    { label: "uses chelator",    color: "#6da9d4" },
    USES_LINKER:      { label: "uses linker",      color: "#9cc4e0" },
    USES_VECTOR:      { label: "uses vector",      color: "#b2d0e8" }
  };

  const PHASE_RANK = {
    "approval": 9, "phase 4": 8, "phase 3": 7, "phase 2/3": 6, "phase 2": 5,
    "phase 1/2": 4, "phase 1": 3, "clinical trial": 2, "preclinical": 1
  };


  const MAX_PER_GROUP = 42;

  /* ── tiny helpers ───────────────────────────────────────────────────── */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

  /* ── application state ──────────────────────────────────────────────── */

  const KG = { meta: null, nodes: [], edges: [], byId: new Map(), adj: [], searchIndex: [] };

  const view = {
    focus: -1,
    selected: -1,
    history: [],
    visible: [],
    links: [],
    scale: 1,
    tx: 0,
    ty: 0,
    filters: new Set(Object.keys(TYPES)),
    hover: -1,
    groups: [],
    truncated: 0
  };

  const canvas = $("#graph");
  const ctx = canvas.getContext("2d");
  const SNAP = new URLSearchParams(location.search).has("snap");
  if (SNAP) document.documentElement.classList.add("snap");
  let dpr = 1, vw = 0, vh = 0, needsFit = true;

  /* ── data loading & indexing ────────────────────────────────────────── */

  async function loadData() {
    const res = await fetch("data/kg.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    KG.meta = raw.meta;

    KG.nodes = raw.nodes.map((n, i) => ({
      i,
      id: n.i,
      t: n.t,
      name: n.n,
      deg: n.d,
      p: n.p || {},
      inline: !!n.x,
      r: 5.2 + Math.min(9.5, Math.log2((n.d || 1) + 1) * 1.65),
      x: 0, y: 0, sx: 0, sy: 0,
      seedX: 0, seedY: 0
    }));

    raw.nodes.forEach((n, i) => KG.byId.set(n.i, i));
    KG.adj = KG.nodes.map(() => []);
    KG.edges = raw.edges.map((e) => {
      KG.adj[e.s].push({ o: e.t, r: e.r, dir: "out", p: e.p || null });
      KG.adj[e.t].push({ o: e.s, r: e.r, dir: "in", p: e.p || null });
      return { s: e.s, t: e.t, r: e.r, p: e.p || null };
    });

    KG.searchIndex = KG.nodes.map((n) => {
      const syn = Array.isArray(n.p.synonyms) ? n.p.synonyms : [];
      return {
        i: n.i,
        name: n.name,
        type: n.t,
        key: norm(n.name + " " + syn.join(" ") + " " + n.id)
      };
    });

    buildTypeCounters();
    buildCatalog();
    renderAbout();
  }

  /* ── subgraph builders ──────────────────────────────────────────────── */

  function egoGraph(center) {
    const groups = new Map();
    let truncated = 0;
    for (const e of KG.adj[center]) {
      const other = KG.nodes[e.o];
      if (!view.filters.has(other.t)) continue;
      const key = `${e.dir}:${e.r}`;
      if (!groups.has(key)) groups.set(key, { key, dir: e.dir, rel: e.r, items: [] });
      groups.get(key).items.push({ j: e.o, p: e.p });
    }
    const ordered = [...groups.values()].sort((a, b) => {
      if (a.dir !== b.dir) return a.dir === "out" ? -1 : 1;
      return b.items.length - a.items.length;
    });
    const nodes = [center];
    const links = [];
    for (const g of ordered) {
      g.items.sort((a, b) => KG.nodes[b.j].deg - KG.nodes[a.j].deg);
      if (g.items.length > MAX_PER_GROUP) {
        truncated += g.items.length - MAX_PER_GROUP;
        g.items = g.items.slice(0, MAX_PER_GROUP);
      }
      for (const it of g.items) {
        nodes.push(it.j);
        links.push(g.dir === "out"
          ? { s: center, t: it.j, r: g.rel, p: it.p }
          : { s: it.j, t: center, r: g.rel, p: it.p });
      }
    }
    return { nodes, links, center, groups: ordered, truncated };
  }

  /* ── layout ─────────────────────────────────────────────────────────── */

  function layoutEgo(center, groups) {
    const c = KG.nodes[center];
    c.x = 0; c.y = 0;

    const totalWeight = groups.reduce((s, g) => s + Math.max(1.4, Math.sqrt(g.items.length)), 0);
    let angle = -Math.PI / 2;
    const gap = groups.length > 1 ? 0.10 : 0;

    for (const g of groups) {
      const weight = Math.max(1.4, Math.sqrt(g.items.length));
      const span = Math.max(0.22, (Math.PI * 2 - gap * groups.length) * (weight / totalWeight));
      const n = g.items.length;
      const perRing = Math.max(10, Math.floor(16 + Math.sqrt(n) * 2.2));
      const rings = Math.max(1, Math.ceil(n / perRing));

      g.items.forEach((it, k) => {
        const ring = Math.floor(k / perRing);
        const inRing = ring === rings - 1 ? n - perRing * (rings - 1) : perRing;
        const idx = k - perRing * ring;
        const a = angle + span * ((idx + 0.5) / Math.max(inRing, 1));
        const radius = 188 + ring * 74 + (n > 26 ? 12 : 0);
        const node = KG.nodes[it.j];
        node.seedX = Math.cos(a) * radius;
        node.seedY = Math.sin(a) * radius;
        node.x = node.seedX;
        node.y = node.seedY;
      });
      angle += span + gap;
    }

    relax(center, 150);
  }

  function relax(center, iterations) {
    const list = view.visible.map((i) => KG.nodes[i]).filter((n) => n.i !== center);
    for (let it = 0; it < iterations; it++) {
      for (let a = 0; a < list.length; a++) {
        const na = list[a];
        for (let b = a + 1; b < list.length; b++) {
          const nb = list[b];
          let dx = nb.x - na.x, dy = nb.y - na.y;
          let d = Math.hypot(dx, dy);
          const min = na.r + nb.r + 16;
          if (d < min && d > 0.001) {
            const push = ((min - d) / d) * 0.5;
            na.x -= dx * push; na.y -= dy * push;
            nb.x += dx * push; nb.y += dy * push;
          }
        }
      }
      for (const node of list) {
        node.x += (node.seedX - node.x) * 0.09;
        node.y += (node.seedY - node.y) * 0.09;
      }
    }
    collide(list, 8);
  }

  function collide(list, pad) {
    for (let k = 0; k < 40; k++) {
      for (let a = 0; a < list.length; a++) {
        const na = list[a];
        for (let b = a + 1; b < list.length; b++) {
          const nb = list[b];
          let dx = nb.x - na.x, dy = nb.y - na.y;
          let d = Math.hypot(dx, dy);
          const min = na.r + nb.r + pad;
          if (d < min && d > 0.001) {
            const push = ((min - d) / d) * 0.5;
            na.x -= dx * push; na.y -= dy * push;
            nb.x += dx * push; nb.y += dy * push;
          }
        }
      }
    }
  }

  /* ── viewport ───────────────────────────────────────────────────────── */

  function fitView(animate = false) {
    if (!view.visible.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const i of view.visible) {
      const n = KG.nodes[i];
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
    }
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
    const padX = vw < 700 ? 92 : 64;
    const padY = 74;
    const scale = clamp(Math.min((vw - padX * 2) / bw, (vh - padY * 2) / bh), 0.20, 2.4);
    const target = {
      scale,
      tx: vw / 2 - ((minX + maxX) / 2) * scale,
      ty: vh / 2 - ((minY + maxY) / 2) * scale
    };
    if (animate) tween(target, 240); else Object.assign(view, target);
    draw();
  }

  let tweenId = null;
  function tween(target, dur) {
    if (SNAP) { Object.assign(view, target); draw(); return; }
    const start = { scale: view.scale, tx: view.tx, ty: view.ty };
    const t0 = performance.now();
    cancelAnimationFrame(tweenId);
    const step = (t) => {
      const k = clamp((t - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      view.scale = start.scale + (target.scale - start.scale) * e;
      view.tx = start.tx + (target.tx - start.tx) * e;
      view.ty = start.ty + (target.ty - start.ty) * e;
      draw();
      if (k < 1) tweenId = requestAnimationFrame(step);
    };
    tweenId = requestAnimationFrame(step);
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale };
  }

  /* ── canvas sizing ──────────────────────────────────────────────────── */

  let lastW = 0, lastH = 0;

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = Math.max(1, Math.round(rect.width));
    vh = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = vw + "px";
    canvas.style.height = vh + "px";
    const becameVisible = (lastW < 10 || lastH < 10) && vw > 10 && vh > 10;
    lastW = vw; lastH = vh;
    if (becameVisible) { fitView(false); needsFit = false; }
    else if (needsFit) { fitView(false); needsFit = false; }
    else draw();
  }

  /* ── drawing ────────────────────────────────────────────────────────── */

  function draw() {
    if (!vw || !vh) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);

    const scale = view.scale, tx = view.tx, ty = view.ty;
    const nodes = view.visible.map((i) => KG.nodes[i]);
    for (const n of nodes) {
      n.sx = n.x * scale + tx;
      n.sy = n.y * scale + ty;
      n.sr = Math.max(3.2, n.r * clamp(scale, 0.55, 1.6));
    }

    const sel = view.selected >= 0 ? KG.nodes[view.selected] : null;
    const hov = view.hover >= 0 ? KG.nodes[view.hover] : null;
    const focus = view.focus >= 0 ? KG.nodes[view.focus] : null;

    // edges
    const edgeAlpha = (l) => {
      if (!sel && !hov) return 0.34;
      const hot = (sel && (l.s === sel.i || l.t === sel.i)) || (hov && (l.s === hov.i || l.t === hov.i));
      return hot ? 0.9 : 0.12;
    };

    ctx.lineCap = "round";
    for (const l of view.links) {
      const a = KG.nodes[l.s], b = KG.nodes[l.t];
      if (a.sx == null || b.sx == null) continue;
      const alpha = edgeAlpha(l);
      const hot = alpha > 0.5;
      ctx.strokeStyle = hexA(RELS[l.r].color, alpha);
      ctx.lineWidth = hot ? 2 : 1.1;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();

      if (hot) {
        const ang = Math.atan2(b.sy - a.sy, b.sx - a.sx);
        const rr = b.sr + 4;
        const ex = b.sx - Math.cos(ang) * rr, ey = b.sy - Math.sin(ang) * rr;
        ctx.fillStyle = hexA(RELS[l.r].color, 0.95);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang - 0.42) * 8, ey - Math.sin(ang - 0.42) * 8);
        ctx.lineTo(ex - Math.cos(ang + 0.42) * 8, ey - Math.sin(ang + 0.42) * 8);
        ctx.closePath();
        ctx.fill();
      }
    }

    // nodes
    for (const n of nodes) {
      const meta = TYPES[n.t];
      const isFocus = focus && n.i === focus.i;
      const isSel = sel && n.i === sel.i;
      const isHov = hov && n.i === hov.i;
      const dim = sel && !isSel && !neighborOf(sel.i, n.i);

      ctx.globalAlpha = dim ? 0.28 : 1;
      drawNode(n.sx, n.sy, n.sr * (isFocus ? 1.35 : 1), meta, isFocus || isSel, isHov);
      ctx.globalAlpha = 1;
    }

    // labels, placed greedily so they do not overlap
    const candidates = [];
    for (const n of nodes) {
      const isFocus = focus && n.i === focus.i;
      const isSel = sel && n.i === sel.i;
      const isHov = hov && n.i === hov.i;
      if (!labelVisible(n, isFocus || isSel || isHov)) continue;
      const priority = (isFocus ? 4 : 0) + (isSel ? 3 : 0) + (isHov ? 2 : 0) + n.deg / 1000;
      candidates.push({ n, priority, strong: isFocus || isSel });
    }
    candidates.sort((a, b) => b.priority - a.priority);

    const placed = [];
    for (const c of candidates) {
      const n = c.n;
      const size = c.strong ? 12.5 : 11.5;
      ctx.font = `${c.strong ? 600 : 500} ${size}px ${getComputedStyle(document.body).fontFamily}`;
      const label = truncate(n.name, c.strong ? 34 : 26);
      const w = ctx.measureText(label).width;
      const ly = n.sy + n.sr * (n.i === (focus && focus.i) ? 1.35 : 1) + 9;
      const rect = { x: n.sx - w / 2 - 4, y: ly - 2, w: w + 8, h: size + 4 };
      if (placed.some((p) => !(rect.x + rect.w < p.x || p.x + p.w < rect.x || rect.y + rect.h < p.y || p.y + p.h < rect.y))) continue;
      placed.push(rect);

      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = "rgba(255,255,255,.94)";
      ctx.strokeText(label, n.sx, ly);
      ctx.fillStyle = c.strong ? "#0e2638" : "#33536a";
      ctx.fillText(label, n.sx, ly);
    }
  }

  function labelVisible(node, force) {
    if (force) return true;
    const count = view.visible.length;
    if (count <= 30) return true;
    if (count <= 60) return node.deg >= 5;
    if (count <= 110) return node.deg >= 8;
    return node.deg >= 14;
  }

  function neighborOf(a, b) {
    return KG.adj[a].some((e) => e.o === b);
  }

  function drawNode(x, y, r, meta, strong, hover) {
    const ctx2 = ctx;
    ctx2.save();
    ctx2.translate(x, y);

    if (hover || strong) {
      ctx2.beginPath();
      ctx2.arc(0, 0, r + 4.5, 0, Math.PI * 2);
      ctx2.fillStyle = hexA(meta.color, 0.16);
      ctx2.fill();
    }

    ctx2.beginPath();
    shapePath(meta.shape, r);
    ctx2.fillStyle = meta.color;
    ctx2.fill();
    ctx2.lineWidth = strong ? 2 : 1.3;
    ctx2.strokeStyle = strong ? "#ffffff" : hexA("#0e2638", 0.30);
    ctx2.stroke();
    ctx2.restore();
  }

  function shapePath(shape, r) {
    switch (shape) {
      case "diamond":
        ctx.moveTo(0, -r * 1.18); ctx.lineTo(r * 1.05, 0); ctx.lineTo(0, r * 1.18); ctx.lineTo(-r * 1.05, 0); ctx.closePath();
        break;
      case "hex": {
        const k = r * 1.12;
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i - Math.PI / 6;
          const px = Math.cos(a) * k, py = Math.sin(a) * k;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath();
        break;
      }
      case "rect": {
        const s = r * 1.55;
        const rr = Math.max(1.5, r * 0.32);
        roundRect(-s / 2, -s / 2, s, s, rr);
        break;
      }
      case "tri": {
        const k = r * 1.22;
        ctx.moveTo(0, -k); ctx.lineTo(k * 0.92, k * 0.72); ctx.lineTo(-k * 0.92, k * 0.72); ctx.closePath();
        break;
      }
      case "square": {
        const s = r * 1.44;
        roundRect(-s / 2, -s / 2, s, s, Math.max(1, r * 0.18));
        break;
      }
      case "penta": {
        const k = r * 1.16;
        for (let i = 0; i < 5; i++) {
          const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
          const px = Math.cos(a) * k, py = Math.sin(a) * k;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath();
        break;
      }
      default:
        ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  /* ── graph switching ────────────────────────────────────────────────── */

  function renderGraph() {
    const g = egoGraph(view.focus);
    view.visible = g.nodes;
    view.links = g.links;
    view.groups = g.groups;
    view.truncated = g.truncated;

    layoutEgo(view.focus, g.groups);
    view.selected = view.focus;

    updateCrumbs();
    updateStageCount();
    renderInspector(view.focus);
    fitView(true);
  }

  function focusNode(i, pushHistory = true) {
    if (i == null || i < 0 || i >= KG.nodes.length) return;
    if (view.focus === i) { selectNode(i); return; }
    if (pushHistory && view.focus >= 0) view.history.push(view.focus);
    view.focus = i;
    view.hover = -1;
    renderGraph();
    $("#back").disabled = view.history.length === 0;
    setActivePresetById(KG.nodes[i].id);
  }

  function goBack() {
    if (!view.history.length) return;
    const prev = view.history.pop();
    view.focus = prev;
    view.selected = prev;
    view.hover = -1;
    renderGraph();
    $("#back").disabled = view.history.length === 0;
    setActivePresetById(KG.nodes[prev].id);
  }

  function updateCrumbs() {
    const n = KG.nodes[view.focus];
    $("#crumbs").innerHTML = `<span>${esc(TYPES[n.t].label)}</span><b>${esc(n.name)}</b>`;
  }

  function updateStageCount() {
    const el = $("#stage-count");
    let text = `${fmt(view.visible.length)} nodes · ${fmt(view.links.length)} edges`;
    if (view.truncated) text += ` · +${fmt(view.truncated)} hidden`;
    el.textContent = text;
  }

  /* ── inspector ──────────────────────────────────────────────────────── */

  function selectNode(i) {
    view.selected = i;
    renderInspector(i);
    draw();
  }

  function clearInspector() {
    $("#inspector-empty").hidden = false;
    $("#inspector-body").hidden = true;
    $("#inspector-body").innerHTML = "";
  }

  function renderInspector(i) {
    const n = KG.nodes[i];
    $("#inspector-empty").hidden = true;
    const body = $("#inspector-body");
    body.hidden = false;

    const meta = TYPES[n.t];
    const badges = [];
    if (n.p.phase) badges.push(`<span class="badge is-phase">${esc(n.p.phase)}</span>`);
    if (n.p.drugType) badges.push(`<span class="badge">${esc(n.p.drugType)}</span>`);
    if (n.inline) badges.push(`<span class="badge is-inline">inline indication</span>`);

    const groups = new Map();
    for (const e of KG.adj[i]) {
      const key = `${e.dir}:${e.r}`;
      if (!groups.has(key)) groups.set(key, { dir: e.dir, rel: e.r, items: [] });
      groups.get(key).items.push(e);
    }
    const ordered = [...groups.values()].sort((a, b) => b.items.length - a.items.length);

    const props = [];
    if (n.p.synonyms?.length) props.push(["Synonyms", n.p.synonyms.slice(0, 5).map(esc).join("; ")]);
    if (n.p.formula) props.push(["Formula", esc(n.p.formula)]);
    if (n.p.genes) props.push(["Gene", esc(n.p.genes)]);
    if (n.p.uniprot) props.push(["UniProt", esc(n.p.uniprot)]);
    if (n.p.icd11) props.push(["ICD-11", esc(n.p.icd11)]);
    if (n.p.halfLife) props.push(["Half-life", esc(n.p.halfLife)]);
    if (n.p.radiation) props.push(["Radiation", esc(n.p.radiation)]);
    if (n.p.decay) props.push(["Decay", esc(n.p.decay)]);
    if (n.p.energy) props.push(["Energy", esc(n.p.energy)]);
    if (n.p.range) props.push(["Range", esc(n.p.range)]);
    if (n.p.daughter) props.push(["Daughter", esc(n.p.daughter)]);
    if (n.p.cid) props.push(["PubChem", esc(n.p.cid)]);
    if (n.p.function) props.push(["Function", esc(truncate(n.p.function, 220))]);

    body.innerHTML = `
      <div class="ins-head">
        <div class="ins-type"><span class="swatch" style="background:${meta.color}"></span>${meta.label}</div>
        <h2 class="ins-name">${esc(n.name)}</h2>
        <div class="ins-id">${esc(n.id)}</div>
        ${badges.length ? `<div class="ins-badges">${badges.join("")}</div>` : ""}
      </div>
      ${props.length ? `
        <div class="ins-section">
          <h4>Properties</h4>
          <dl class="props">${props.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
        </div>` : ""}
      <div class="ins-section">
        <h4>Connections</h4>
        <div id="rel-groups"></div>
      </div>
      <div class="ins-actions">
        <button class="btn-primary" id="ins-focus" type="button">Focus in graph</button>
        <button class="btn-ghost" id="ins-copy" type="button">Copy ID</button>
      </div>`;

    const relWrap = $("#rel-groups", body);
    for (const g of ordered) {
      const label = RELS[g.rel]?.label || g.rel;
      const el = document.createElement("div");
      el.className = "rel-group";
      const shown = g.items.slice(0, 8);
      el.innerHTML = `
        <div class="rel-title">
          <span class="line" style="background:${RELS[g.rel]?.color || "#5293c9"}"></span>
          ${g.dir === "in" ? "← " : ""}${label}
          <span class="n">${fmt(g.items.length)}</span>
        </div>
        <div class="rel-items"></div>`;
      const list = $(".rel-items", el);
      for (const e of shown) list.appendChild(relRow(e));
      if (g.items.length > 8) {
        const more = document.createElement("button");
        more.className = "more-btn";
        more.type = "button";
        more.textContent = `Show all ${fmt(g.items.length)} →`;
        more.addEventListener("click", () => {
          list.innerHTML = "";
          for (const e of g.items) list.appendChild(relRow(e));
          more.remove();
        });
        el.appendChild(more);
      }
      relWrap.appendChild(el);
    }

    $("#ins-focus", body).addEventListener("click", () => focusNode(i));
    $("#ins-copy", body).addEventListener("click", async (ev) => {
      try {
        await navigator.clipboard.writeText(n.id);
        ev.currentTarget.textContent = "Copied";
        setTimeout(() => (ev.currentTarget.textContent = "Copy ID"), 1200);
      } catch { /* clipboard unavailable */ }
    });
  }

  function relRow(e) {
    const other = KG.nodes[e.o];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rel-item";
    const extra = e.p?.phase ? e.p.phase : e.p?.app ? e.p.app : "";
    btn.innerHTML = `<span class="dot" style="background:${TYPES[other.t].color}"></span>
      <span class="t">${esc(other.name)}</span>
      ${extra ? `<span class="m">${esc(extra)}</span>` : ""}`;
    btn.addEventListener("click", () => focusNode(e.o));
    return btn;
  }

  /* ── search ─────────────────────────────────────────────────────────── */

  const searchInput = $("#search");
  const suggestionBox = $("#suggestions");
  let sugItems = [], sugIndex = -1;

  function searchNodes(q, limit = 9) {
    const key = norm(q);
    if (key.length < 2) return [];
    const starts = [], contains = [];
    for (const item of KG.searchIndex) {
      const idx = item.key.indexOf(key);
      if (idx < 0) continue;
      const nameKey = norm(item.name);
      const hit = { ...item, pos: idx, nameHit: nameKey.startsWith(key) };
      if (hit.nameHit) starts.push(hit);
      else contains.push(hit);
      if (starts.length + contains.length > 400) break;
    }
    const score = (h) => (h.nameHit ? 0 : 1) * 1000 + (h.type === "drug" ? 0 : 100) + h.pos;
    return [...starts, ...contains].sort((a, b) => score(a) - score(b)).slice(0, limit);
  }

  function renderSuggestions(items, q) {
    sugItems = items;
    sugIndex = -1;
    if (!items.length) { suggestionBox.hidden = true; return; }
    const key = norm(q);
    suggestionBox.innerHTML = items.map((it, k) => {
      const n = KG.nodes[it.i];
      const nm = n.name;
      const pos = norm(nm).indexOf(key);
      let html = esc(nm);
      if (pos >= 0) {
        html = esc(nm.slice(0, pos)) + "<mark>" + esc(nm.slice(pos, pos + key.length)) + "</mark>" + esc(nm.slice(pos + key.length));
      }
      return `<button class="suggestion" role="option" data-i="${k}">
        <span class="swatch" style="width:8px;height:8px;border-radius:2px;background:${TYPES[n.t].color}"></span>
        <span class="s-name">${html}</span>
        <span class="s-meta">${TYPES[n.t].label}</span>
      </button>`;
    }).join("");
    suggestionBox.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
    $$(".suggestion", suggestionBox).forEach((el) => {
      el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        const it = sugItems[+el.dataset.i];
        if (it) { focusNode(it.i); searchInput.value = it.name; closeSuggestions(); }
      });
    });
  }

  function closeSuggestions() {
    suggestionBox.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    sugItems = [];
    sugIndex = -1;
  }

  function highlightSuggestion(dir) {
    if (!sugItems.length) return;
    sugIndex = (sugIndex + dir + sugItems.length) % sugItems.length;
    $$(".suggestion", suggestionBox).forEach((el, k) => el.classList.toggle("is-active", k === sugIndex));
    const el = $$(".suggestion", suggestionBox)[sugIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    if (q.length < 2) { closeSuggestions(); return; }
    renderSuggestions(searchNodes(q), q);
  });

  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); highlightSuggestion(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); highlightSuggestion(-1); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      const pick = sugItems[sugIndex >= 0 ? sugIndex : 0];
      if (pick) { focusNode(pick.i); searchInput.value = pick.name; closeSuggestions(); searchInput.blur(); }
    } else if (ev.key === "Escape") { closeSuggestions(); searchInput.blur(); }
  });

  searchInput.addEventListener("blur", () => setTimeout(closeSuggestions, 120));

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== searchInput) {
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    if (ev.key === "Escape") { closeSuggestions(); }
  });

  /* ── filters, legend, presets ───────────────────────────────────────── */

  function buildTypeCounters() {
    const counts = KG.meta.counts.byType;
    const wrap = $("#filters");
    wrap.innerHTML = "";
    for (const [key, meta] of Object.entries(TYPES)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter is-on";
      btn.dataset.type = key;
      btn.innerHTML = `<span class="swatch" style="background:${meta.color}"></span>
        <span class="f-name">${meta.plural}</span>
        <span class="f-count">${fmt(counts[key] || 0)}</span>
        <span class="f-check"></span>`;
      btn.addEventListener("click", () => toggleFilter(key, btn));
      wrap.appendChild(btn);
    }

    const legend = $("#legend");
    legend.innerHTML = Object.entries(TYPES).map(([k, m]) => {
      const shape = { circle: "l-circle", diamond: "l-diamond", hex: "l-hex", rect: "l-rect", tri: "l-tri", square: "l-sq", penta: "l-penta" }[m.shape];
      return `<li><i class="${shape}" style="background:${m.color}"></i>${m.label}</li>`;
    }).join("");
  }

  function toggleFilter(key, btn) {
    if (view.filters.has(key)) {
      if (view.filters.size === 1) return;
      view.filters.delete(key);
      btn.classList.remove("is-on"); btn.classList.add("is-off");
    } else {
      view.filters.add(key);
      btn.classList.add("is-on"); btn.classList.remove("is-off");
    }
    renderGraph();
  }

  $("#toggle-all").addEventListener("click", () => {
    view.filters = new Set(Object.keys(TYPES));
    $$(".filter").forEach((b) => { b.classList.add("is-on"); b.classList.remove("is-off"); });
    renderGraph();
  });

  const PRESETS = [
    { id: "drug:RP28Y4D6J0", label: "Lutathera" },
    { id: "drug:RPDGUWPLGA", label: "Pluvicto" },
    { id: "target:TA16RTHSLS", label: "PSMA / FOLH1" },
    { id: "target:TA2CR28LYA", label: "SSTR2" },
    { id: "nuclide:NUWYSIP964", label: "177Lu" },
    { id: "nuclide:NUXQ3027P7", label: "68Ga" }
  ];

  function buildPresets() {
    const wrap = $("#presets");
    wrap.innerHTML = "";
    PRESETS.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "preset";
      b.dataset.id = p.id;
      b.textContent = p.label;
      b.addEventListener("click", () => focusNode(KG.byId.get(p.id)));
      wrap.appendChild(b);
    });
  }

  function setActivePresetById(id) {
    $$(".preset").forEach((b) => b.classList.toggle("is-active", b.dataset.id === id));
  }

  /* ── interactions ───────────────────────────────────────────────────── */

  let pointer = { down: false, moved: false, x: 0, y: 0, tx: 0, ty: 0 };

  function hitTest(sx, sy) {
    let best = -1, bestD = 16;
    for (let k = view.visible.length - 1; k >= 0; k--) {
      const n = KG.nodes[view.visible[k]];
      const d = Math.hypot(n.sx - sx, n.sy - sy);
      if (d < Math.max(bestD, n.sr + 4)) { best = n.i; bestD = d; }
    }
    return best;
  }

  function localPoint(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  canvas.addEventListener("pointerdown", (ev) => {
    const p = localPoint(ev);
    pointer = { down: true, moved: false, x: p.x, y: p.y, tx: view.tx, ty: view.ty };
    canvas.setPointerCapture(ev.pointerId);
  });

  canvas.addEventListener("pointermove", (ev) => {
    const p = localPoint(ev);

    if (pointer.down) {
      const dx = p.x - pointer.x, dy = p.y - pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        pointer.moved = true;
        canvas.classList.add("is-dragging");
        view.tx = pointer.tx + dx;
        view.ty = pointer.ty + dy;
        draw();
      }
      return;
    }

    const hit = hitTest(p.x, p.y);
    if (hit !== view.hover) {
      view.hover = hit;
      canvas.style.cursor = hit >= 0 ? "pointer" : "grab";
      draw();
    }
    const tip = $("#tooltip");
    if (hit >= 0) {
      const n = KG.nodes[hit];
      tip.hidden = false;
      tip.innerHTML = `<b>${esc(truncate(n.name, 52))}</b><br><em>${TYPES[n.t].label}</em> · ${fmt(n.deg)} connections`;
      tip.style.left = p.x + "px";
      tip.style.top = p.y - 6 + "px";
    } else {
      tip.hidden = true;
    }
  });

  canvas.addEventListener("pointerup", (ev) => {
    const p = localPoint(ev);
    const wasDrag = pointer.moved;
    pointer.down = false;
    canvas.classList.remove("is-dragging");
    if (wasDrag) return;
    const hit = hitTest(p.x, p.y);
    if (hit >= 0) selectNode(hit);
    else { view.selected = -1; clearInspector(); draw(); }
  });

  canvas.addEventListener("pointerleave", () => {
    pointer.down = false;
    view.hover = -1;
    $("#tooltip").hidden = true;
    draw();
  });

  canvas.addEventListener("dblclick", (ev) => {
    const p = localPoint(ev);
    const hit = hitTest(p.x, p.y);
    if (hit >= 0) focusNode(hit);
  });

  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const p = localPoint(ev);
    const before = screenToWorld(p.x, p.y);
    const factor = Math.exp(-ev.deltaY * 0.0014);
    view.scale = clamp(view.scale * factor, 0.25, 3.2);
    view.tx = p.x - before.x * view.scale;
    view.ty = p.y - before.y * view.scale;
    draw();
  }, { passive: false });

  $("#zoom-in").addEventListener("click", () => zoomBy(1.2));
  $("#zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));
  $("#fit").addEventListener("click", () => fitView(true));
  $("#back").addEventListener("click", goBack);

  function zoomBy(k) {
    const cx = vw / 2, cy = vh / 2;
    const before = screenToWorld(cx, cy);
    view.scale = clamp(view.scale * k, 0.25, 3.2);
    view.tx = cx - before.x * view.scale;
    view.ty = cy - before.y * view.scale;
    draw();
  }

  /* ── catalog ────────────────────────────────────────────────────────── */

  const CATALOG = { rows: [], filtered: [], page: 0, pageSize: 25 };

  function buildCatalog() {
    const drugs = KG.nodes.filter((n) => n.t === "drug");
    CATALOG.rows = drugs.map((n) => {
      let nuclide = "", targets = 0, indications = 0;
      for (const e of KG.adj[n.i]) {
        if (e.dir !== "out") continue;
        if (e.r === "CONTAINS_NUCLIDE") nuclide = KG.nodes[e.o].name;
        else if (e.r === "TARGETS") targets++;
        else if (e.r === "INDICATED_FOR") indications++;
      }
      return {
        i: n.i, name: n.name, id: n.id, deg: n.deg, phase: n.p.phase || "",
        phaseRank: PHASE_RANK[norm(n.p.phase || "")] || 0, nuclide, targets, indications,
        key: norm(n.name + " " + (n.p.synonyms || []).join(" "))
      };
    });

    const nuclides = [...new Set(CATALOG.rows.map((r) => r.nuclide).filter(Boolean))].sort();
    $("#catalog-nuclide").innerHTML = `<option value="">All nuclides</option>` + nuclides.map((x) => `<option>${esc(x)}</option>`).join("");
    const phases = [...new Set(CATALOG.rows.map((r) => r.phase).filter(Boolean))]
      .sort((a, b) => (PHASE_RANK[norm(b)] || 0) - (PHASE_RANK[norm(a)] || 0));
    $("#catalog-phase").innerHTML = `<option value="">Any phase</option>` + phases.map((x) => `<option>${esc(x)}</option>`).join("");
    applyCatalog();
  }

  function applyCatalog() {
    const q = norm($("#catalog-search").value);
    const nuc = $("#catalog-nuclide").value;
    const phase = $("#catalog-phase").value;
    const sort = $("#catalog-sort").value;

    CATALOG.filtered = CATALOG.rows.filter((r) => {
      if (q && !r.key.includes(q)) return false;
      if (nuc && r.nuclide !== nuc) return false;
      if (phase && r.phase !== phase) return false;
      return true;
    });

    if (sort === "name") CATALOG.filtered.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "phase") CATALOG.filtered.sort((a, b) => b.phaseRank - a.phaseRank || b.deg - a.deg);
    else CATALOG.filtered.sort((a, b) => b.deg - a.deg || a.name.localeCompare(b.name));

    CATALOG.page = 0;
    renderCatalog();
  }

  function renderCatalog() {
    const total = CATALOG.filtered.length;
    const pages = Math.max(1, Math.ceil(total / CATALOG.pageSize));
    CATALOG.page = clamp(CATALOG.page, 0, pages - 1);
    const start = CATALOG.page * CATALOG.pageSize;
    const rows = CATALOG.filtered.slice(start, start + CATALOG.pageSize);

    $("#catalog-body").innerHTML = rows.map((r) => `
      <tr data-i="${r.i}">
        <td><div class="c-name">${esc(r.name)}</div><small>${esc(r.id)}</small></td>
        <td>${r.nuclide ? `<span class="badge">${esc(r.nuclide)}</span>` : "—"}</td>
        <td>${r.phase ? `<span class="phase-pill" data-rank="${r.phaseRank}">${esc(r.phase)}</span>` : "—"}</td>
        <td class="num">${r.targets}</td>
        <td class="num">${r.indications}</td>
        <td class="num">${r.deg}</td>
      </tr>`).join("");

    $$("#catalog-body tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        const i = +tr.dataset.i;
        showView("explorer");
        focusNode(i);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    $("#catalog-count").textContent = `${fmt(total)} drugs · showing ${total ? start + 1 : 0}–${Math.min(start + CATALOG.pageSize, total)}`;
    $("#page-label").textContent = `${CATALOG.page + 1} / ${pages}`;
    $("#page-prev").disabled = CATALOG.page === 0;
    $("#page-next").disabled = CATALOG.page >= pages - 1;
  }

  $("#catalog-search").addEventListener("input", () => applyCatalog());
  $("#catalog-nuclide").addEventListener("change", () => applyCatalog());
  $("#catalog-phase").addEventListener("change", () => applyCatalog());
  $("#catalog-sort").addEventListener("change", () => { applyCatalog(); });
  $("#page-prev").addEventListener("click", () => { CATALOG.page--; renderCatalog(); });
  $("#page-next").addEventListener("click", () => { CATALOG.page++; renderCatalog(); });

  /* ── about ──────────────────────────────────────────────────────────── */

  function renderAbout() {
    const m = KG.meta, q = m.quality;
    const entries = Object.values(m.counts.byType).reduce((a, b) => a + b, 0);
    $("#about-facts").innerHTML = `
      <dt>Graph</dt><dd>${fmt(m.counts.nodes)} nodes / ${fmt(m.counts.edges)} edges</dd>
      <dt>Snapshot</dt><dd>${esc(m.built)}</dd>
      <dt>Source</dt><dd>RadioPharm / IDRlab</dd>
      <dt>Source entries</dt><dd>4,344 pages across 7 folders</dd>`;

    const fromTo = {
      CONTAINS_NUCLIDE: ["Drug", "Nuclide"],
      TARGETS: ["Drug", "Target"],
      INDICATED_FOR: ["Drug", "Indication"],
      USES_CHELATOR: ["Drug", "Chelator"],
      USES_LINKER: ["Drug", "Linker"],
      USES_VECTOR: ["Drug", "Vector"]
    };
    const relCounts = m.counts.byRelation;
    $("#schema-body").innerHTML = Object.entries(RELS).map(([k, v]) => `
      <tr><td>${k}</td><td>${fromTo[k][0]}</td><td>${fromTo[k][1]}</td>
      <td>${v.label} · ${fmt(relCounts[k] || 0)} edges</td></tr>`).join("");

    const notes = [];
    const catalogued = KG.nodes.filter((n) => n.t === "disease" && !n.inline).length;
    notes.push(`<strong>${fmt(q.inlineIndications)}</strong> indication nodes exist only as inline values on drug pages — the snapshot has no dedicated page for them (${fmt(catalogued)} indications do have one). They keep their ICD-11 code and phase on the edge.`);
    if (q.enrichedPages) notes.push(`<strong>${fmt(q.enrichedPages)}</strong> chelator pages truncate their drug list at 50 entries; <strong>${fmt(q.enrichedEdges)}</strong> missing links were back-filled from the public RadioPharm endpoint and cached.`);
    notes.push(`<strong>${q.recoveredIds}</strong> drug IDs were recovered from the catalog CSV because their page header lost the ID line.`);
    const unresolved = Object.entries(q.unresolved || {}).reduce((a, [, v]) => a + v, 0);
    if (unresolved) notes.push(`<strong>${fmt(unresolved)}</strong> references could not be resolved to a catalogued entity and were left out rather than invented.`);
    notes.push(`Two drugs with no resolvable relation were pruned from the rendered graph, so the drug count is slightly below the raw snapshot.`);
    $("#about-notes").innerHTML = notes.map((n) => `<li>${n}</li>`).join("");
  }

  /* ── routing ────────────────────────────────────────────────────────── */

  const VIEWS = ["explorer", "catalog", "about"];

  function showView(name, push = true) {
    if (!VIEWS.includes(name)) name = "explorer";
    VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
    $$(".nav-link").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
    if (push) history.replaceState(null, "", `#${name}`);
    if (name === "explorer") {
      resize();
      requestAnimationFrame(() => { resize(); });
    }
  }

  $$(".nav-link").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  window.addEventListener("hashchange", () => {
    const name = location.hash.replace("#", "") || "explorer";
    showView(name, false);
  });

  /* ── boot ───────────────────────────────────────────────────────────── */

  async function boot() {
    buildPresets();
    try {
      await loadData();
    } catch (err) {
      $("#loader").innerHTML = `<strong>Could not load data/kg.json</strong><br><span style="font-size:12px">${esc(err.message)} — serve the folder over HTTP (e.g. <code>python -m http.server</code>).</span>`;
      console.error(err);
      return;
    }

    $("#kpis").querySelector('[data-kpi="nodes"]').textContent = fmt(KG.meta.counts.nodes);
    $("#kpis").querySelector('[data-kpi="edges"]').textContent = fmt(KG.meta.counts.edges);
    $("#kpis").querySelector('[data-kpi="drug"]').textContent = fmt(KG.meta.counts.byType.drug);
    $("#kpis").querySelector('[data-kpi="target"]').textContent = fmt(KG.meta.counts.byType.target);

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe($("#stage"));

    const params = new URLSearchParams(location.search);
    const startId = params.get("focus");
    view.focus = startId && KG.byId.has(startId) ? KG.byId.get(startId) : KG.byId.get("drug:RP28Y4D6J0");
    view.history = [];
    renderGraph();
    $("#back").disabled = true;
    setActivePresetById(KG.nodes[view.focus].id);

    if (SNAP) {
      $("#loader").hidden = true;
    } else {
      $("#loader").classList.add("is-done");
      setTimeout(() => { $("#loader").hidden = true; }, 450);
    }

    showView((location.hash || "#explorer").replace("#", "") || "explorer", false);
  }

  window.addEventListener("resize", () => resize());
  document.addEventListener("DOMContentLoaded", boot);
})();
