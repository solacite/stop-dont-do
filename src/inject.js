// stop dont do: runs inside the slack client (app.slack.com).
// adds a panel to show/hide sidebar sections and channels, plus themes.
(() => {
  if (window.__sdd) window.__sdd.destroy();

  const KEY = "sdd:settings";
  const defaults = { theme: "slack", hiddenSections: {}, hiddenChannels: {} };
  let settings;
  try {
    settings = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    settings = { ...defaults };
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {}
  };

  const cleanups = [];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const h = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  // ---------------------------------------------------------------- slack api

  function workspace() {
    const id = (location.pathname.match(/\/client\/([A-Z0-9]+)/) || [])[1];
    const lc = JSON.parse(localStorage.getItem("localConfig_v2") || "{}");
    const team = id && lc.teams?.[id];
    if (!team) throw new Error("open a workspace first");
    return { id, team };
  }

  async function api(method, params = {}) {
    const { id, team } = workspace();
    const fd = new FormData();
    fd.append("token", team.token);
    for (const [k, v] of Object.entries(params)) fd.append(k, v);
    const route = id.startsWith("E") ? `${id}:${id}` : id;
    const res = await fetch(`${team.url}api/${method}?_x_gantry=true&fp=26&slack_route=${encodeURIComponent(route)}`, {
      method: "POST",
      body: fd,
      credentials: "include",
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.error}`);
    return json;
  }

  const SECTION_LABELS = {
    stars: "Starred",
    channels: "Channels",
    direct_messages: "Direct messages",
    recent_apps: "Apps",
    slack_connect: "External connections",
    temporary_channels: "Temporary channels",
    salesforce_records: "Salesforce records",
    agents: "Agents",
  };

  const cache = {}; // workspace id -> { sections, names }

  async function loadSections(force) {
    const { id } = workspace();
    if (cache[id] && !force) return cache[id];
    const { channel_sections: raw } = await api("users.channelSections.list");

    // sections come as a linked list via next_channel_section_id
    const byId = Object.fromEntries(raw.map((s) => [s.channel_section_id, s]));
    const pointedAt = new Set(raw.map((s) => s.next_channel_section_id).filter(Boolean));
    const ordered = [];
    let cur = raw.find((s) => !pointedAt.has(s.channel_section_id));
    while (cur && !ordered.includes(cur)) {
      ordered.push(cur);
      cur = byId[cur.next_channel_section_id];
    }
    for (const s of raw) if (!ordered.includes(s)) ordered.push(s);

    const sections = ordered.map((s) => ({
      id: s.channel_section_id,
      name: s.name || SECTION_LABELS[s.type] || s.type.replace(/_/g, " "),
      type: s.type,
      channels: s.channel_ids_page?.channel_ids || [],
      total: s.channel_ids_page?.count ?? 0,
    }));

    const ids = [...new Set(sections.flatMap((s) => s.channels))];
    const names = {};
    const users = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const batch = Object.fromEntries(ids.slice(i, i + 100).map((c) => [c, 0]));
      try {
        const { channels } = await api("conversations.genericInfo", { updated_channels: JSON.stringify(batch) });
        for (const c of channels || []) {
          if (c.is_im) {
            names[c.id] = { kind: "dm", label: "…" };
            users.set(c.id, c.user);
          } else if (c.is_mpim) {
            const people = (c.name || "").replace(/^mpdm-|-\d+$/g, "").split("--");
            names[c.id] = { kind: "group", label: people.join(", ") };
          } else {
            names[c.id] = { kind: c.is_private ? "private" : "channel", label: c.name };
          }
        }
      } catch (e) {
        console.warn("[stop-dont-do]", e);
      }
    }

    // dm names need a user lookup each, a few at a time
    const queue = [...users.entries()];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (queue.length) {
          const [cid, uid] = queue.shift();
          try {
            const { user } = await api("users.info", { user: uid });
            names[cid].label = user.profile?.display_name || user.real_name || user.name;
          } catch {
            names[cid].label = uid;
          }
        }
      }),
    );

    return (cache[id] = { sections, names });
  }

  // ---------------------------------------------------------------- sidebar hiding
  // the sidebar is a virtual list where every row is absolutely positioned,
  // so hidden rows leave holes. we remember where slack put each row and
  // shift the visible ones up by the height of the hidden rows above them.

  const rows = new Map(); // item key -> { top, slot, kind, sec, ch }
  const collapseTried = new Set();
  let observedList = null;
  let applying = false;

  const isSectionHidden = (sec) => !!(sec && settings.hiddenSections[sec]);
  const isChannelHidden = (ch) => !!(ch && settings.hiddenChannels[ch]);

  function realTop(el) {
    if (el.dataset.sddTop !== undefined && el.style.top === el.dataset.sddTop) return parseFloat(el.dataset.sddOrig);
    return parseFloat(el.style.top) || 0;
  }

  function realHeight(el) {
    if (el.dataset.sddH !== undefined && el.style.height === el.dataset.sddH) return parseFloat(el.dataset.sddOrigH);
    return parseFloat(el.style.height) || 0;
  }

  function setTop(el, orig, next) {
    const v = `${next}px`;
    if (el.style.top !== v) el.style.top = v;
    el.dataset.sddTop = v;
    el.dataset.sddOrig = orig;
  }

  function describe(el) {
    const key = el.getAttribute("data-item-key") || "";
    const heading = key.startsWith("sectionHeading-");
    const chan = el.querySelector("[data-qa-channel-sidebar-channel-id]");
    return {
      key,
      kind: heading ? "heading" : "item",
      sec: heading ? key.slice("sectionHeading-".length) : chan?.getAttribute("data-qa-channel-sidebar-channel-section-id") || null,
      ch: chan?.getAttribute("data-qa-channel-sidebar-channel-id") || null,
    };
  }

  function layoutSidebar() {
    const list = document.querySelector(".p-channel_sidebar__list .c-virtual_list__scroll_container");
    if (!list) return;
    if (list !== observedList) {
      rows.clear();
      observedList = list;
      sidebarObserver.disconnect();
      sidebarObserver.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "aria-expanded"] });
    }
    applying = true;
    try {
      const rendered = [...list.children]
        .filter((el) => el.classList.contains("c-virtual_list__item"))
        .map((el) => ({ el, ...describe(el), top: realTop(el) }))
        .sort((a, b) => a.top - b.top);
      if (!rendered.length) return;

      rendered.forEach((r, i) => {
        const next = rendered[i + 1];
        r.slot = next ? next.top - r.top : rows.get(r.key)?.slot ?? (r.el.offsetHeight || 28);
      });

      // forget anything that used to sit where the rendered rows are now
      const lo = rendered[0].top;
      const hi = rendered.at(-1).top;
      for (const [k, v] of rows) if (v.top >= lo && v.top <= hi) rows.delete(k);
      for (const r of rendered) rows.set(r.key, { top: r.top, slot: r.slot, kind: r.kind, sec: r.sec, ch: r.ch });

      const shiftAt = new Map();
      const hidden = new Set();
      let section = null;
      let shift = 0;
      for (const [key, r] of [...rows].sort((a, b) => a[1].top - b[1].top)) {
        if (r.kind === "heading") section = r.sec;
        const sec = r.kind === "heading" ? r.sec : r.sec || section;
        shiftAt.set(key, shift);
        if (isSectionHidden(sec) || isChannelHidden(r.ch)) {
          hidden.add(key);
          shift += r.slot;
        }
      }

      for (const r of rendered) {
        if (hidden.has(r.key)) {
          r.el.setAttribute("data-sdd-hide", "");
          // keep big hidden sections collapsed so the virtual list stays small
          if (r.kind === "heading" && r.el.getAttribute("aria-expanded") === "true" && !collapseTried.has(r.sec)) {
            collapseTried.add(r.sec);
            r.el.querySelector('[data-qa^="section_heading_toggle_and_label"]')?.click();
          }
        } else {
          r.el.removeAttribute("data-sdd-hide");
          const s = shiftAt.get(r.key) || 0;
          if (s || r.el.dataset.sddTop !== undefined) setTop(r.el, r.top, r.top - s);
        }
      }

      const fullHeight = realHeight(list);
      if (fullHeight) {
        const v = `${Math.max(0, fullHeight - shift)}px`;
        if (list.style.height !== v) list.style.height = v;
        list.dataset.sddH = v;
        list.dataset.sddOrigH = fullHeight;
      }
    } finally {
      sidebarObserver.takeRecords();
      applying = false;
    }
  }

  let frame = 0;
  const scheduleLayout = () => {
    if (applying || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layoutSidebar();
    });
  };
  const sidebarObserver = new MutationObserver(scheduleLayout);
  cleanups.push(() => sidebarObserver.disconnect());

  // ---------------------------------------------------------------- themes

  const THEMES = {
    slack: { label: "Slack", swatch: ["#4a154b", "#1a1d21", "#ffffff"] },
    docs: {
      label: "Google Docs",
      light: true,
      swatch: ["#ffffff", "#0b57d0", "#1f1f1f"],
      p: {
        bg: "#ffffff", bg2: "#f9fbfd", bg3: "#f0f4f9", fg: "#1f1f1f", fg2: "#444746", fg3: "#5f6368",
        border: "#dadce0", hover: "#f1f3f4", side: "#f9fbfd", sideFg: "#1f1f1f", sideFg2: "#444746",
        select: "#d3e3fd", selectFg: "#041e49", accent: "#0b57d0",
      },
    },
    paper: {
      label: "Paper",
      light: true,
      swatch: ["#f6f1e7", "#a0522d", "#2b2622"],
      p: {
        bg: "#fbf8f1", bg2: "#f3ecdf", bg3: "#ebe2d1", fg: "#2b2622", fg2: "#5b5249", fg3: "#857a6e",
        border: "#ded4c2", hover: "#efe7d8", side: "#f3ecdf", sideFg: "#2b2622", sideFg2: "#5b5249",
        select: "#e5d5bd", selectFg: "#2b2622", accent: "#a0522d",
      },
    },
    midnight: {
      label: "Midnight",
      swatch: ["#0f1226", "#8b7cf6", "#e6e6f5"],
      p: {
        bg: "#13162b", bg2: "#0f1226", bg3: "#1b1f3a", fg: "#e6e6f5", fg2: "#a9abc9", fg3: "#7f82a6",
        border: "#2a2e52", hover: "#1e2242", side: "#0c0f20", sideFg: "#d9d9f0", sideFg2: "#8f92b8",
        select: "#3b3577", selectFg: "#ffffff", accent: "#8b7cf6",
      },
    },
    terminal: {
      label: "Terminal",
      swatch: ["#000000", "#33ff66", "#33ff66"],
      p: {
        bg: "#050805", bg2: "#000000", bg3: "#0b120b", fg: "#33ff66", fg2: "#22c74e", fg3: "#1a9a3c",
        border: "#124d22", hover: "#0c1a0f", side: "#000000", sideFg: "#33ff66", sideFg2: "#22c74e",
        select: "#0f3d1c", selectFg: "#7dffa0", accent: "#33ff66",
      },
    },
  };

  const triplet = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  };

  // slack defines its colours as css variables on a handful of selectors.
  // we find those selectors and redeclare the variables on them.
  function slackColorVars() {
    const names = new Set();
    const selectors = new Set([":root", "body"]);
    const walk = (rules) => {
      for (const r of rules) {
        if (r.cssRules?.length) walk(r.cssRules);
        if (!r.style || !r.selectorText) continue;
        let found = false;
        for (let i = 0; i < r.style.length; i++) {
          const p = r.style.item(i);
          if (/^--dt_color-(?!plt|brand|constants)/.test(p) || /^--sk_(primary|inverted|foreground|highlight)/.test(p)) {
            names.add(p);
            found = true;
          }
        }
        if (found) r.selectorText.split(",").forEach((s) => selectors.add(s.trim()));
      }
    };
    for (const ss of document.styleSheets) {
      try {
        walk(ss.cssRules);
      } catch {}
    }
    return { names: [...names], selectors: [...selectors] };
  }

  function pickColor(name, p) {
    if (name.startsWith("--sk_")) {
      if (/primary_foreground|inverted_background/.test(name)) return triplet(p.fg);
      if (/primary_background|inverted_foreground/.test(name)) return triplet(p.bg);
      if (/highlight/.test(name)) return triplet(p.accent);
      if (/foreground_min/.test(name)) return triplet(p.hover);
      if (/foreground_low/.test(name)) return triplet(p.border);
      if (/foreground_high/.test(name)) return triplet(p.fg3);
      if (/foreground_max/.test(name)) return triplet(p.fg2);
      return null;
    }
    const v = name.slice("--dt_color-".length);
    const sidebar = v.startsWith("theme-");
    const k = sidebar ? v.slice(6) : v;
    if (/-imp|hgl/.test(k)) return sidebar && /hgl/.test(k) ? p.select : null;
    if (/(hover|pressed)$/.test(k)) return sidebar ? p.select : p.hover;
    if (/^content-(inv-)?pry/.test(k)) return sidebar ? p.sideFg : p.fg;
    if (/^content-(inv-)?sec/.test(k)) return sidebar ? p.sideFg2 : p.fg2;
    if (/^content/.test(k)) return sidebar ? p.sideFg2 : p.fg3;
    if (/^base-modal/.test(k)) return null;
    if (/^base-(inv-)?ter/.test(k)) return sidebar ? p.side : p.bg3;
    if (/^(base|ctr)/.test(k)) return sidebar ? p.side : p.bg;
    if (sidebar && /^surf-inv-sec/.test(k)) return p.side;
    if (/^surf-(inv-)?pry/.test(k)) return sidebar ? p.select : p.hover;
    if (/^surf/.test(k)) return sidebar ? p.select : p.border;
    if (/^otl/.test(k)) return p.border;
    return null;
  }

  const DOCS_CSS = `
    body.sdd-docs, body.sdd-docs *:not(.c-icon):not([class*="c-icon"]):not(i):not(.c-emoji):not(code):not(pre) {
      font-family: Arial, Helvetica, sans-serif !important; letter-spacing: normal !important;
    }
    body.sdd-docs .p-rich_text_section, body.sdd-docs .c-message_kit__blocks { font-size: 15px !important; line-height: 1.5 !important; }
    body.sdd-docs .p-rich_text_section a.c-link { color: #1155cc !important; text-decoration: underline !important; }
    body.sdd-docs .p-theme_background { background: #f9fbfd !important; }
    body.sdd-docs .p-client_workspace__layout { border-radius: 0 !important; }
    body.sdd-docs .c-message_kit__background:hover { background: #f8f9fa !important; }
    body.sdd-docs .c-texty_input, body.sdd-docs .c-wysiwyg_container { border-radius: 8px !important; }
    body.sdd-docs .c-wysiwyg_container__button--send:not(.c-wysiwyg_container__button--disabled) { background: #0b57d0 !important; }
    body.sdd-docs .p-ia4_client > .p-client_workspace_wrapper { margin-top: 98px !important; height: calc(100% - 138px) !important; }
    #sdd-docs-bar {
      position: absolute; left: 0; right: 0; top: 40px; height: 98px; z-index: 5; background: #f9fbfd; color: #1f1f1f;
      font: 14px Arial, Helvetica, sans-serif; display: flex; flex-direction: column; padding: 4px 16px 0; box-sizing: border-box;
    }
    #sdd-docs-bar .row1 { display: flex; align-items: center; gap: 10px; height: 52px; }
    #sdd-docs-bar .title { font-size: 18px; color: #1f1f1f; }
    #sdd-docs-bar .menus { display: flex; gap: 2px; margin-top: -2px; }
    #sdd-docs-bar .menus span { padding: 2px 7px; border-radius: 4px; font-size: 14px; color: #1f1f1f; }
    #sdd-docs-bar .menus span:hover { background: #e9eef6; }
    #sdd-docs-bar .icons { display: flex; gap: 8px; color: #444746; margin-left: 4px; }
    #sdd-docs-bar .share { margin-left: auto; background: #c2e7ff; color: #001d35; border-radius: 999px; padding: 9px 20px; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    #sdd-docs-bar .avatar { width: 32px; height: 32px; border-radius: 50%; background: #0b57d0; }
    #sdd-docs-bar .toolbar { margin-top: 6px; height: 40px; background: #edf2fa; border-radius: 24px; display: flex; align-items: center; gap: 14px; padding: 0 16px; color: #444746; font-size: 14px; }
    #sdd-docs-bar .toolbar .sep { width: 1px; height: 20px; background: #c7c7c7; }
    #sdd-docs-bar .toolbar b { font-weight: 700; color: #444746; }
  `;

  const DOC_ICON = `<svg width="22" height="30" viewBox="0 0 22 30"><path d="M0 2.5A2.5 2.5 0 0 1 2.5 0H14l8 8v19.5a2.5 2.5 0 0 1-2.5 2.5h-17A2.5 2.5 0 0 1 0 27.5z" fill="#4285f4"/><path d="M14 0l8 8h-5.5A2.5 2.5 0 0 1 14 5.5z" fill="#a1c2fa"/><path d="M5 14h12v1.8H5zm0 4h12v1.8H5zm0 4h8.5v1.8H5z" fill="#fff"/></svg>`;

  function docsBar() {
    return h(`<div id="sdd-docs-bar">
      <div class="row1">
        ${DOC_ICON}
        <div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="title">Untitled document</span>
            <span class="icons">☆ <span style="font-size:13px">⧉</span> <span style="font-size:13px">☁</span></span>
          </div>
          <div class="menus">${["File", "Edit", "View", "Insert", "Format", "Tools", "Extensions", "Help"].map((m) => `<span>${m}</span>`).join("")}</div>
        </div>
        <div class="share">🔒 Share</div>
        <div class="avatar"></div>
      </div>
      <div class="toolbar">
        <span>🔍</span><span>↶</span><span>↷</span><span>🖨</span><span>A̲</span><span class="sep"></span>
        <span>100% ▾</span><span class="sep"></span><span>Normal text ▾</span><span class="sep"></span>
        <span>Arial ▾</span><span class="sep"></span><span>− &nbsp;11&nbsp; +</span><span class="sep"></span>
        <b>B</b><i>I</i><u>U</u><span>A</span><span class="sep"></span><span>🔗</span><span>💬</span><span>🖼</span>
      </div>
    </div>`);
  }

  let themeStyle = null;
  let originalTitle = null;
  let titleTimer = 0;

  function applyTheme() {
    const name = settings.theme;
    const theme = THEMES[name] || THEMES.slack;
    document.body.classList.remove(...Object.keys(THEMES).map((t) => `sdd-${t}`));
    document.getElementById("sdd-docs-bar")?.remove();
    themeStyle?.remove();
    themeStyle = null;
    clearInterval(titleTimer);
    if (originalTitle !== null) document.title = originalTitle;
    originalTitle = null;
    panelEl?.classList.toggle("sdd-light", panelLight());
    if (!theme.p) return;

    const { names, selectors } = slackColorVars();
    const decls = names
      .map((n) => [n, pickColor(n, theme.p)])
      .filter(([, v]) => v)
      .map(([n, v]) => `${n}: ${v} !important;`)
      .join("\n");
    const sel = [...selectors, '[style*="--dt_color"]', '[style*="--sk_"]'].join(",\n");
    const p = theme.p;
    themeStyle = document.createElement("style");
    themeStyle.id = "sdd-theme";
    themeStyle.textContent = `
      ${sel} { ${decls} }
      body.sdd-${name} { background: ${p.bg} !important; color: ${p.fg} !important; }
      html:has(body.sdd-${name}), body.sdd-${name}, body.sdd-${name} * { color-scheme: ${theme.light ? "light" : "dark"} !important; }
      body.sdd-${name} .p-theme_background { background: ${p.bg2} !important; }
      body.sdd-${name} .c-wysiwyg_container { --TextyTheme-wysiwyg-bg: ${p.bg}; background: ${p.bg} !important; border-color: ${p.border} !important; }
      body.sdd-${name} .p-channel_sidebar__channel--selected,
      body.sdd-${name} [data-qa-channel-sidebar-channel-is-selected="true"] { background: ${p.select} !important; color: ${p.selectFg} !important; }
      body.sdd-${name} [data-qa-channel-sidebar-channel-is-selected="true"] * { color: ${p.selectFg} !important; }
      ${name === "terminal" ? `body.sdd-terminal, body.sdd-terminal *:not(.c-icon):not([class*="c-icon"]) { font-family: "Cascadia Mono", Consolas, monospace !important; }` : ""}
      ${name === "paper" ? `body.sdd-paper .p-rich_text_section, body.sdd-paper .c-message_kit__blocks { font-family: Georgia, "Times New Roman", serif !important; font-size: 15.5px !important; }` : ""}
      ${name === "docs" ? DOCS_CSS : ""}
    `;
    document.head.appendChild(themeStyle);
    document.body.classList.add(`sdd-${name}`);

    if (name === "docs") {
      const client = document.querySelector(".p-ia4_client");
      if (client) client.prepend(docsBar());
      originalTitle = document.title;
      const fake = "Untitled document - Google Docs";
      document.title = fake;
      titleTimer = setInterval(() => {
        if (document.title !== fake) {
          originalTitle = document.title;
          document.title = fake;
        }
        if (!document.getElementById("sdd-docs-bar")) document.querySelector(".p-ia4_client")?.prepend(docsBar());
      }, 1000);
    }
  }
  cleanups.push(() => {
    settings = { ...settings, theme: "slack" };
    applyTheme();
  });

  // ---------------------------------------------------------------- panel

  const PANEL_CSS = `
    [data-sdd-hide] { display: none !important; }
    #sdd-fab {
      position: fixed; left: 10px; bottom: 90px; z-index: 9999; width: 34px; height: 34px; border-radius: 10px; border: 0;
      background: rgba(127,127,127,.25); color: inherit; cursor: pointer; font-size: 16px; display: grid; place-items: center;
      backdrop-filter: blur(6px); opacity: .7; transition: opacity .15s, transform .15s;
    }
    #sdd-fab:hover { opacity: 1; transform: scale(1.06); }
    #sdd-panel {
      --bg: #1c1e22; --bg2: #25282d; --fg: #eceef1; --fg2: #a3a7ae; --line: #33373d; --acc: #7aa7ff; --hov: #2c3036;
      position: fixed; top: 0; right: 0; bottom: 0; width: 380px; max-width: 100vw; z-index: 10000; background: var(--bg); color: var(--fg);
      box-shadow: -12px 0 40px rgba(0,0,0,.35); display: flex; flex-direction: column;
      font: 14px/1.4 system-ui, "Segoe UI", sans-serif; transform: translateX(105%); transition: transform .2s ease;
    }
    #sdd-panel.sdd-light { --bg: #ffffff; --bg2: #f4f6f8; --fg: #1f2328; --fg2: #626a73; --line: #e3e6ea; --acc: #0b57d0; --hov: #eef1f4; }
    #sdd-panel.open { transform: none; }
    #sdd-panel * { box-sizing: border-box; font-family: inherit; }
    #sdd-panel header { padding: 16px 18px 10px; display: flex; align-items: center; gap: 8px; }
    #sdd-panel header h2 { margin: 0; font-size: 17px; font-weight: 700; flex: 1; }
    #sdd-panel button { font: inherit; color: inherit; cursor: pointer; }
    #sdd-panel .x { background: none; border: 0; font-size: 20px; color: var(--fg2); padding: 2px 6px; border-radius: 6px; }
    #sdd-panel .x:hover { background: var(--hov); }
    #sdd-panel .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--fg2); padding: 6px 18px; }
    #sdd-panel .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(98px, 1fr)); gap: 8px; padding: 2px 18px 12px; }
    #sdd-panel .theme { border: 2px solid var(--line); background: var(--bg2); border-radius: 10px; padding: 8px; text-align: left; font-size: 12px; }
    #sdd-panel .theme.on { border-color: var(--acc); }
    #sdd-panel .theme .sw { display: flex; gap: 3px; margin-bottom: 6px; }
    #sdd-panel .theme .sw i { flex: 1; height: 16px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(127,127,127,.3); }
    #sdd-panel .tools { display: flex; gap: 6px; padding: 4px 18px 10px; }
    #sdd-panel input[type=search] { flex: 1; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); outline: none; }
    #sdd-panel input[type=search]:focus { border-color: var(--acc); }
    #sdd-panel .btn { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg2); font-size: 12px; white-space: nowrap; }
    #sdd-panel .btn:hover { background: var(--hov); }
    #sdd-panel .list { flex: 1; overflow-y: auto; padding: 0 10px 20px; border-top: 1px solid var(--line); }
    #sdd-panel .status { padding: 18px 8px; color: var(--fg2); }
    #sdd-panel .sec { border-bottom: 1px solid var(--line); }
    #sdd-panel .row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; cursor: pointer; user-select: none; }
    #sdd-panel .row:hover { background: var(--hov); }
    #sdd-panel .row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #sdd-panel .sec > .row .name { font-weight: 600; }
    #sdd-panel .row .count { color: var(--fg2); font-size: 12px; }
    #sdd-panel .row .caret { width: 20px; text-align: center; color: var(--fg2); transition: transform .15s; border: 0; background: none; padding: 0; }
    #sdd-panel .sec.expanded .caret { transform: rotate(90deg); }
    #sdd-panel .chans { display: none; padding: 0 0 6px 26px; }
    #sdd-panel .sec.expanded .chans { display: block; }
    #sdd-panel .chans .row { padding: 4px 8px; font-size: 13px; }
    #sdd-panel .chans .icon { width: 14px; color: var(--fg2); text-align: center; }
    #sdd-panel .off .name { color: var(--fg2); text-decoration: line-through; }
    #sdd-panel input[type=checkbox] { width: 16px; height: 16px; margin: 0; accent-color: var(--acc); cursor: pointer; flex: none; }
    #sdd-panel footer { padding: 10px 18px; border-top: 1px solid var(--line); color: var(--fg2); font-size: 12px; }
  `;

  let panelEl = null;
  let fabEl = null;
  let baseStyle = null;
  let query = "";
  const expanded = new Set();

  const panelLight = () => {
    const t = THEMES[settings.theme];
    if (t?.p) return !!t.light;
    return !document.body.classList.contains("sk-client-theme--dark");
  };

  function buildPanel() {
    baseStyle = document.createElement("style");
    baseStyle.id = "sdd-base";
    baseStyle.textContent = PANEL_CSS;
    document.head.appendChild(baseStyle);

    mountRailButton();

    panelEl = h(`<aside id="sdd-panel" aria-label="stop dont do">
      <header><h2>Sidebar & themes</h2><button class="x" title="Close (Esc)">×</button></header>
      <div class="label">Theme</div>
      <div class="themes"></div>
      <div class="label">Sections</div>
      <div class="tools">
        <input type="search" placeholder="Filter sections and channels">
        <button class="btn" data-act="all">Show all</button>
        <button class="btn" data-act="refresh" title="Reload from Slack">↻</button>
      </div>
      <div class="list"><div class="status">Loading…</div></div>
      <footer>Ticked = shown in your sidebar. Ctrl+Alt+H opens this.</footer>
    </aside>`);
    document.body.appendChild(panelEl);
    panelEl.classList.toggle("sdd-light", panelLight());

    panelEl.querySelector(".x").addEventListener("click", () => togglePanel(false));
    panelEl.querySelector("input[type=search]").addEventListener("input", (e) => {
      query = e.target.value.trim().toLowerCase();
      renderList();
    });
    panelEl.querySelector('[data-act="all"]').addEventListener("click", () => {
      const data = currentData();
      if (!data) return;
      for (const s of data.sections) {
        delete settings.hiddenSections[s.id];
        s.channels.forEach((c) => delete settings.hiddenChannels[c]);
      }
      changed();
    });
    panelEl.querySelector('[data-act="refresh"]').addEventListener("click", () => refreshList(true));

    panelEl.querySelector(".list").addEventListener("click", (e) => {
      const caret = e.target.closest(".caret");
      const row = e.target.closest(".row");
      if (!row) return;
      if (caret) {
        const sec = row.closest(".sec");
        sec.classList.toggle("expanded");
        sec.classList.contains("expanded") ? expanded.add(sec.dataset.id) : expanded.delete(sec.dataset.id);
        return;
      }
      const box = row.querySelector("input[type=checkbox]");
      if (e.target !== box) box.checked = !box.checked;
      if (row.dataset.sec) {
        box.checked ? delete settings.hiddenSections[row.dataset.sec] : (settings.hiddenSections[row.dataset.sec] = true);
        collapseTried.delete(row.dataset.sec);
      } else if (row.dataset.ch) {
        box.checked ? delete settings.hiddenChannels[row.dataset.ch] : (settings.hiddenChannels[row.dataset.ch] = true);
      }
      changed();
    });

    renderThemes();
  }

  function renderThemes() {
    const wrap = panelEl.querySelector(".themes");
    wrap.innerHTML = Object.entries(THEMES)
      .map(
        ([k, t]) => `<button class="theme ${settings.theme === k ? "on" : ""}" data-theme="${k}">
          <div class="sw">${t.swatch.map((c) => `<i style="background:${c}"></i>`).join("")}</div>${esc(t.label)}</button>`,
      )
      .join("");
    wrap.querySelectorAll(".theme").forEach((b) =>
      b.addEventListener("click", () => {
        settings.theme = b.dataset.theme;
        save();
        applyTheme();
        renderThemes();
      }),
    );
  }

  const EYE_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.3"/><path d="M3.5 16.5l13-13"/></svg>`;

  // a copy of slack's own "More" rail button, so it matches whatever theme is on.
  // falls back to a small corner button if the rail isn't there.
  function mountRailButton() {
    if (fabEl?.isConnected && (fabEl.id === "sdd-rail-holder" || !document.querySelector('[data-qa="tab_rail_browse_button"]'))) return;
    fabEl?.remove();
    const more = document.querySelector('[data-qa="tab_rail_browse_button"]');
    const anchor = more?.closest(".c-coachmark-anchor");
    if (more && anchor) {
      const btn = more.cloneNode(true);
      btn.id = "sdd-rail";
      btn.removeAttribute("data-qa");
      btn.removeAttribute("aria-describedby");
      btn.setAttribute("aria-label", "Sidebar & themes");
      btn.title = "Sidebar & themes (Ctrl+Alt+H)";
      const svg = btn.querySelector("svg");
      if (svg) svg.outerHTML = EYE_ICON;
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode()); ) if (n.nodeValue.trim()) n.nodeValue = "Sidebar";
      const holder = document.createElement("div");
      holder.appendChild(btn);
      holder.id = "sdd-rail-holder";
      anchor.after(holder);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePanel();
      });
      fabEl = holder;
    } else {
      fabEl = h(`<button id="sdd-fab" title="Sidebar & themes (Ctrl+Alt+H)">${EYE_ICON}</button>`);
      fabEl.addEventListener("click", () => togglePanel());
      document.body.appendChild(fabEl);
    }
  }

  const currentData = () => {
    try {
      return cache[workspace().id];
    } catch {
      return null;
    }
  };

  function changed() {
    save();
    renderList();
    layoutSidebar();
  }

  async function refreshList(force) {
    const list = panelEl.querySelector(".list");
    if (force || !currentData()) list.innerHTML = `<div class="status">Loading your sections…</div>`;
    try {
      await loadSections(force);
      renderList();
    } catch (e) {
      list.innerHTML = `<div class="status">Couldn't load sections: ${esc(e.message)}</div>`;
    }
  }

  const ICONS = { channel: "#", private: "🔒", dm: "@", group: "👥" };

  function renderList() {
    const data = currentData();
    if (!data || !panelEl) return;
    const list = panelEl.querySelector(".list");
    const top = list.scrollTop;
    const q = query;
    const html = data.sections
      .map((s) => {
        const chans = s.channels.map((c) => ({ id: c, ...(data.names[c] || { kind: "channel", label: c }) }));
        const secMatch = !q || s.name.toLowerCase().includes(q);
        const shown = secMatch ? chans : chans.filter((c) => c.label.toLowerCase().includes(q));
        if (!secMatch && !shown.length) return "";
        const secOn = !settings.hiddenSections[s.id];
        const hiddenCount = chans.filter((c) => settings.hiddenChannels[c.id]).length;
        const open = expanded.has(s.id) || (q && !secMatch);
        const more = s.total > chans.length ? `<div class="row"><span class="name" style="opacity:.6">+${s.total - chans.length} more</span></div>` : "";
        return `<div class="sec ${open ? "expanded" : ""}" data-id="${esc(s.id)}">
          <div class="row ${secOn ? "" : "off"}" data-sec="${esc(s.id)}">
            <input type="checkbox" ${secOn ? "checked" : ""} data-partial="${secOn && hiddenCount ? 1 : ""}">
            <span class="name">${esc(s.name)}</span>
            <span class="count">${hiddenCount ? `${chans.length - hiddenCount}/` : ""}${s.total}</span>
            ${chans.length ? `<button class="caret" title="Show channels">›</button>` : `<span class="caret"></span>`}
          </div>
          <div class="chans">${shown
            .map((c) => {
              const on = !settings.hiddenChannels[c.id];
              return `<div class="row ${on ? "" : "off"}" data-ch="${esc(c.id)}">
                <input type="checkbox" ${on ? "checked" : ""} ${secOn ? "" : "disabled"}>
                <span class="icon">${ICONS[c.kind] || "#"}</span><span class="name">${esc(c.label)}</span></div>`;
            })
            .join("")}${more}</div>
        </div>`;
      })
      .join("");
    list.innerHTML = html || `<div class="status">Nothing matches.</div>`;
    list.querySelectorAll('[data-partial="1"]').forEach((b) => (b.indeterminate = true));
    list.scrollTop = top;
  }

  function togglePanel(force) {
    const open = force ?? !panelEl.classList.contains("open");
    panelEl.classList.toggle("open", open);
    if (open) refreshList(false);
  }

  function onKey(e) {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      togglePanel();
    } else if (e.key === "Escape" && panelEl?.classList.contains("open")) {
      togglePanel(false);
    }
  }

  // ---------------------------------------------------------------- boot

  function init() {
    buildPanel();
    applyTheme();
    layoutSidebar();
    document.addEventListener("keydown", onKey, true);
    // slack swaps the sidebar out when switching workspaces; re-check now and then
    let lastPath = location.pathname;
    const timer = setInterval(() => {
      const list = document.querySelector(".p-channel_sidebar__list .c-virtual_list__scroll_container");
      if (list !== observedList) layoutSidebar();
      mountRailButton();
      if (!document.getElementById("sdd-theme") && THEMES[settings.theme]?.p) applyTheme();
      const ws = location.pathname.split("/")[2];
      if (ws !== lastPath.split("/")[2] && panelEl.classList.contains("open")) refreshList(false);
      lastPath = location.pathname;
    }, 800);
    cleanups.push(() => {
      clearInterval(timer);
      document.removeEventListener("keydown", onKey, true);
      document.querySelectorAll("[data-sdd-hide]").forEach((el) => el.removeAttribute("data-sdd-hide"));
      for (const el of document.querySelectorAll("[data-sdd-top]")) {
        if (el.style.top === el.dataset.sddTop) el.style.top = `${el.dataset.sddOrig}px`;
        delete el.dataset.sddTop;
        delete el.dataset.sddOrig;
      }
      if (observedList && observedList.dataset.sddH === observedList.style.height) observedList.style.height = `${observedList.dataset.sddOrigH}px`;
      panelEl?.remove();
      fabEl?.remove();
      baseStyle?.remove();
    });
  }

  window.__sdd = {
    destroy() {
      cleanups.reverse().forEach((f) => {
        try {
          f();
        } catch {}
      });
      delete window.__sdd;
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
