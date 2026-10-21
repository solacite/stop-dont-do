// stop dont do: runs inside the slack client (app.slack.com).
// adds a panel to show/hide sidebar sections and channels, plus themes.
(() => {
  if (window.__sdd) window.__sdd.destroy();

  const KEY = "sdd:settings";
  const defaults = { theme: "slack", hiddenSections: {}, hiddenChannels: {}, foldedGroups: {}, colors: {} };
  let settings;
  try {
    settings = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    settings = { ...defaults };
  }
  for (const k of ["hiddenSections", "hiddenChannels", "foldedGroups", "colors"]) settings[k] ||= {};
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

  // sections whose names start with dashes ("── .✦ events") act as group headers
  const DIVIDER = /^\s*[-─—–━═_~]/;
  const groupLabel = (name) => name.replace(/^[\s\-─—–━═_~.✦·•*|>:]+/, "").trim() || name;

  const cache = {}; // workspace id -> { sections, groupOf, names }

  async function loadSections(force) {
    const { id } = workspace();
    if (cache[id]?.sections && !force) return cache[id];
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

    const sections = ordered.map((s) => {
      const name = s.name || SECTION_LABELS[s.type] || s.type.replace(/_/g, " ");
      return {
        id: s.channel_section_id,
        name,
        divider: s.type === "standard" && DIVIDER.test(name),
        channels: s.channel_ids_page?.channel_ids || [],
        total: s.channel_ids_page?.count ?? 0,
      };
    });

    const groupOf = {};
    let group = null;
    for (const s of sections) {
      if (s.divider) group = s.id;
      else if (group) groupOf[s.id] = group;
    }

    cache[id] = { names: {}, ...cache[id], sections, groupOf };
    return cache[id];
  }

  async function loadNames() {
    const data = await loadSections(false);
    const names = data.names;
    const ids = [...new Set(data.sections.flatMap((s) => s.channels))].filter((c) => !names[c]);
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
    return data;
  }

  const currentData = () => {
    try {
      return cache[workspace().id];
    } catch {
      return null;
    }
  };

  // which channels have unreads. slack bolds a collapsed section if any channel in
  // it is unread, hidden ones included, so we check before letting it stay bold.
  let unread = { at: 0, ws: null, ids: new Set(), loading: false };
  async function refreshUnreads() {
    let ws;
    try {
      ws = workspace().id;
    } catch {
      return;
    }
    if (unread.loading || (unread.ws === ws && Date.now() - unread.at < 15000)) return;
    unread.loading = true;
    try {
      const c = await api("client.counts");
      const ids = new Set(
        [...(c.channels || []), ...(c.mpims || []), ...(c.ims || [])].filter((x) => x.has_unreads || x.mention_count).map((x) => x.id),
      );
      unread = { at: Date.now(), ws, ids, loading: false };
      scheduleLayout();
    } catch {
      unread.loading = false;
    }
  }

  // ---------------------------------------------------------------- slack's own buttons
  // each one is either a css selector, a function that finds the element(s), or a
  // sidebar row key (those go through the sidebar re-packing below)

  // a rail tab is wrapped a few levels deep; hide the wrapper that sits directly in the rail
  const railTab = (qa) => () => {
    let el = document.querySelector(`[data-qa="${qa}"]`);
    while (el && el.parentElement && !el.parentElement.classList.contains("p-tab_rail__tab_menu")) el = el.parentElement;
    return [el?.parentElement ? el : null];
  };
  const UI_GROUPS = [
    {
      label: "Top bar",
      items: [
        { key: "appMenu", label: "Menu (☰)", css: '[data-qa="windows-titlebar-app-menu"]' },
        { key: "wsSwitcher", label: "Workspace switcher", css: ".p-workspace_switcher_container__button" },
        { key: "history", label: "Back, forward & history", css: '[data-qa="history_back_button"], [data-qa="history_forward_button"], [data-qa="top-nav-history-menu"]' },
        { key: "agents", label: "Agents", find: () => [document.querySelector('button[aria-label="More agents"]')?.parentElement] },
        { key: "help", label: "Help (?)", css: ".p-top_nav__help" },
      ],
    },
    {
      label: "Left rail",
      items: [
        { key: "teamIcon", label: "Workspace icon", css: '[data-qa="account_switcher_team_icon"]' },
        { key: "railHome", label: "Home", find: railTab("tab_rail_home_button") },
        { key: "railDms", label: "DMs", find: railTab("tab_rail_dms_button") },
        { key: "railActivity", label: "Activity", find: railTab("tab_rail_activity_button") },
        { key: "railFiles", label: "Files", find: railTab("tab_rail_files_button") },
        { key: "railLater", label: "To-dos", find: railTab("tab_rail_later_button") },
        { key: "railMore", label: "More", find: railTab("tab_rail_browse_button") },
        { key: "create", label: "Create new (+)", css: 'button[aria-label="Create new"]' },
        { key: "focus", label: "Focus mode (moon)", css: '[data-qa="silent-sidebar-trigger"]' },
      ],
    },
    {
      label: "Sidebar",
      items: [
        { key: "findConvo", label: "Find a conversation", css: ".p-sidebar_text_filter_input_header" },
        { key: "threads", label: "Threads", row: "Vall_threads" },
        { key: "huddles", label: "Huddles", row: "Pbrowse-huddles" },
        { key: "drafts", label: "Drafts & sent", row: "Pdrafts" },
        { key: "saved", label: "Saved", row: "Pbookmarks" },
        { key: "directories", label: "Directories", row: "unified_directory" },
      ],
    },
  ];
  const UI_ITEMS = UI_GROUPS.flatMap((g) => g.items);
  const ROW_KEYS = Object.fromEntries(UI_ITEMS.filter((i) => i.row).map((i) => [i.row, i.key]));
  settings.hiddenUi ||= {};

  // sidebar rows we hide by key; the divider under them goes once they're all gone
  function isRowHidden(key) {
    if (ROW_KEYS[key]) return !!settings.hiddenUi[ROW_KEYS[key]];
    if (key === "pagesDivider") return Object.values(ROW_KEYS).every((k) => settings.hiddenUi[k]);
    return false;
  }

  let uiStyle = null;
  function applyUi() {
    uiStyle ||= document.head.appendChild(Object.assign(document.createElement("style"), { id: "sdd-ui" }));
    const hidden = UI_ITEMS.filter((i) => settings.hiddenUi[i.key] && !i.row);
    uiStyle.textContent = hidden.map((i) => [i.css, `[data-sdd-ui="${i.key}"]`].filter(Boolean).join(", ") + " { display: none !important; }").join("\n");
    markUi();
  }

  function markUi() {
    for (const i of UI_ITEMS) {
      if (!i.find) continue;
      for (const el of i.find()) if (el && el.getAttribute("data-sdd-ui") !== i.key) el.setAttribute("data-sdd-ui", i.key);
    }
  }
  cleanups.push(() => {
    uiStyle?.remove();
    document.querySelectorAll("[data-sdd-ui]").forEach((el) => el.removeAttribute("data-sdd-ui"));
  });

  // ---------------------------------------------------------------- sidebar hiding
  // the sidebar is a virtual list where every row is absolutely positioned,
  // so hidden rows leave holes. we remember where slack put each row and
  // shift the visible ones up by the height of the hidden rows above them.

  const rows = new Map(); // item key -> { top, slot, kind, sec, ch }
  const collapseTried = new Set();
  let observedList = null;
  let applying = false;

  const isFolded = (sec) => {
    const g = currentData()?.groupOf[sec];
    return !!(g && settings.foldedGroups[g]);
  };
  const isSectionHidden = (sec) => !!(sec && (settings.hiddenSections[sec] || isFolded(sec)));
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

  // un-bold a section heading when its only unread channels are ones you hid
  function fixHeadingBold(el, sec) {
    const label = el.querySelector('[class*="sectionHeadingLabelUnreads"]');
    const data = currentData();
    const section = data?.sections.find((s) => s.id === sec);
    let quiet = false;
    if (label && section && section.channels.some((c) => settings.hiddenChannels[c])) {
      refreshUnreads();
      if (unread.at && unread.ws === location.pathname.split("/")[2]) {
        quiet = !section.channels.some((c) => unread.ids.has(c) && !settings.hiddenChannels[c]);
      }
    }
    quiet ? el.setAttribute("data-sdd-quiet", "") : el.removeAttribute("data-sdd-quiet");
    if (quiet) copyReadHeadingStyle();
  }

  // a quiet heading should look exactly like a read one, so borrow a read one's colour and weight
  function copyReadHeadingStyle() {
    const read = [...document.querySelectorAll('.p-channel_sidebar__list [data-qa^="channel_sidebar__section_heading_label"]')].find(
      (l) => !l.className.includes("Unreads") && !l.closest("[data-sdd-quiet], [data-sdd-hide]"),
    );
    if (!read) return;
    const s = getComputedStyle(read);
    document.body.style.setProperty("--sdd-read-color", s.color);
    document.body.style.setProperty("--sdd-read-weight", s.fontWeight);
  }

  function markGroupHeading(el, sec) {
    const data = currentData();
    const s = data?.sections.find((x) => x.id === sec);
    if (s?.divider) el.setAttribute("data-sdd-group", settings.foldedGroups[sec] ? "folded" : "open");
    else el.removeAttribute("data-sdd-group");
  }

  function layoutSidebar() {
    const list = document.querySelector(".p-channel_sidebar__list .c-virtual_list__scroll_container");
    if (!list) return;
    if (list !== observedList) {
      rows.clear();
      observedList = list;
      sidebarObserver.disconnect();
      sidebarObserver.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "aria-expanded", "class"] });
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
        if (isSectionHidden(sec) || isChannelHidden(r.ch) || isRowHidden(key)) {
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
          if (r.kind === "heading") {
            fixHeadingBold(r.el, r.sec);
            markGroupHeading(r.el, r.sec);
          }
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
      updateScrollbar(list);
    } finally {
      sidebarObserver.takeRecords();
      applying = false;
    }
  }

  // slack sizes its scrollbar from the full list, so it still shows one after we've
  // hidden enough rows that everything fits. drop it when there's nothing to scroll.
  function updateScrollbar(list = observedList) {
    const root = list?.closest(".c-virtual_list--scrollbar");
    const scroller = list?.closest(".c-scrollbar__hider");
    if (!root || !scroller) return;
    const fits = scroller.scrollHeight <= scroller.clientHeight + 1;
    if (fits !== root.hasAttribute("data-sdd-noscroll")) root.toggleAttribute("data-sdd-noscroll", fits);
  }
  const onResize = () => updateScrollbar();
  window.addEventListener("resize", onResize);
  cleanups.push(() => {
    window.removeEventListener("resize", onResize);
    document.querySelectorAll("[data-sdd-noscroll]").forEach((el) => el.removeAttribute("data-sdd-noscroll"));
  });

  let frame = 0;
  const scheduleLayout = () => {
    if (applying || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layoutSidebar();
    });
  };
  // mutation callbacks run before the browser paints, so laying out right here
  // means slack's unfiltered sidebar never reaches the screen
  const sidebarObserver = new MutationObserver(() => applying || layoutSidebar());
  cleanups.push(() => sidebarObserver.disconnect());

  // slack throws the whole sidebar away and builds a new one when you go to home,
  // switch workspaces, etc. catch the new one the moment it appears.
  const mountObserver = new MutationObserver(() => {
    if (applying) return;
    markPanes();
    const list = document.querySelector(".p-channel_sidebar__list .c-virtual_list__scroll_container");
    if (list && list !== observedList) layoutSidebar();
  });
  cleanups.push(() => {
    mountObserver.disconnect();
    for (const a of ["data-sdd-home", "data-sdd-secondary", "data-sdd-chanpane"]) document.querySelectorAll(`[${a}]`).forEach((el) => el.removeAttribute(a));
  });

  // mark slack's panels once (home tab, its channel-list pane, an open right-hand panel)
  // so the dash-mode css can read a plain attribute instead of :has(), which the browser
  // re-asks over the whole page on every tab switch
  const setMark = (el, name, on) => el && el.hasAttribute(name) !== on && el.toggleAttribute(name, on);
  function markPanes() {
    for (const tp of document.querySelectorAll(".p-client_workspace__tabpanel")) {
      const list = tp.querySelector(".p-channel_sidebar__list");
      setMark(tp, "data-sdd-home", !!list);
      setMark(tp, "data-sdd-secondary", !!tp.querySelector(".p-view_contents--secondary"));
      for (const side of tp.querySelectorAll(".p-view_contents--sidebar")) setMark(side, "data-sdd-chanpane", !!list && side.contains(list));
    }
  }

  // a plain css backstop for anything the layout pass hasn't reached yet
  let hideStyle = null;
  function updateHideCss() {
    hideStyle ||= document.head.appendChild(Object.assign(document.createElement("style"), { id: "sdd-hide" }));
    const data = currentData();
    const secs = new Set(Object.keys(settings.hiddenSections).filter((k) => settings.hiddenSections[k]));
    if (data) for (const [sec, g] of Object.entries(data.groupOf)) if (settings.foldedGroups[g]) secs.add(sec);
    const chans = Object.keys(settings.hiddenChannels).filter((k) => settings.hiddenChannels[k]);
    const rowKeys = Object.keys(ROW_KEYS).filter(isRowHidden);
    const item = ".p-channel_sidebar__list .c-virtual_list__item";
    const sels = [
      ...[...secs].map((s) => `${item}[data-item-key="sectionHeading-${s}"]`),
      ...chans.map((c) => `${item}[data-item-key="${c}"]`),
      ...rowKeys.map((k) => `${item}[data-item-key="${k}"]`),
    ];
    hideStyle.textContent = sels.length ? `${sels.join(",\n")} { display: none !important; }` : "";
  }
  cleanups.push(() => hideStyle?.remove());

  // clicking a "──" divider in the sidebar folds the sections under it
  function onSidebarClick(e) {
    const heading = e.target.closest?.('.p-channel_sidebar__list [data-sdd-group]');
    if (!heading || e.target.closest("button:not([data-qa^='section_heading_toggle'])")) return;
    if (!e.target.closest('[data-qa^="section_heading_toggle_and_label"], [data-qa^="channel_sidebar__section_heading_label"]')) return;
    e.preventDefault();
    e.stopPropagation();
    const id = heading.getAttribute("data-item-key").slice("sectionHeading-".length);
    settings.foldedGroups[id] ? delete settings.foldedGroups[id] : (settings.foldedGroups[id] = true);
    changed();
  }

  // ---------------------------------------------------------------- colours

  const hex = (c) => {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
  const lum = (c) => {
    const [r, g, b] = hex(c).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const onColor = (c) => (lum(c) > 0.4 ? "#111111" : "#ffffff");
  const triplet = (c) => hex(c).join(", ");

  // every theme is four colours; everything else is worked out from them
  function palette(base) {
    const { bg, side, fg, accent } = base;
    const light = lum(bg) > 0.4;
    const ink = light ? "#000000" : "#ffffff";
    const sideFg = lum(side) > 0.4 === light ? fg : onColor(side);
    return {
      light,
      bg,
      bg2: mix(bg, ink, 0.025),
      bg3: mix(bg, ink, 0.05),
      fg,
      fg2: mix(fg, bg, 0.28),
      fg3: mix(fg, bg, 0.45),
      border: mix(bg, fg, light ? 0.13 : 0.16),
      hover: mix(bg, fg, light ? 0.05 : 0.07),
      hl: mix(bg, accent, light ? 0.1 : 0.16),
      side,
      sideFg,
      sideFg2: mix(sideFg, side, 0.32),
      sideHover: mix(side, sideFg, 0.08),
      select: light ? mix(bg, accent, 0.14) : accent,
      selectFg: light ? mix(accent, "#000000", 0.35) : onColor(accent),
      accent,
      accentFg: onColor(accent),
      // accent as readable text on the background
      link: light ? mix(accent, "#000000", lum(accent) > 0.3 ? 0.35 : 0) : mix(accent, "#ffffff", lum(accent) < 0.2 ? 0.5 : 0),
    };
  }

  const THEMES = {
    slack: { label: "Slack" },
    docs: {
      label: "Google Docs",
      base: { bg: "#ffffff", side: "#ffffff", fg: "#202124", accent: "#1a73e8" },
    },
    valorant: {
      label: "Valorant",
      base: { bg: "#0f1923", side: "#0a1219", fg: "#ece8e1", accent: "#ff4655" },
      presets: {
        Valorant: { bg: "#0f1923", side: "#0a1219", fg: "#ece8e1", accent: "#ff4655" },
        Reyna: { bg: "#160d1f", side: "#0e0815", fg: "#efe6f5", accent: "#b54cff" },
        Jett: { bg: "#0d1820", side: "#08111a", fg: "#e9f3f7", accent: "#5fd0ff" },
        Sage: { bg: "#0c1b1a", side: "#081312", fg: "#e6f2ee", accent: "#2fe0b0" },
        Phoenix: { bg: "#1b120d", side: "#120c08", fg: "#f5ebe2", accent: "#ff8a2a" },
        Viper: { bg: "#0d1a10", side: "#08120a", fg: "#e7f2e6", accent: "#62e65a" },
        Neon: { bg: "#0b1222", side: "#070c18", fg: "#e9f0ff", accent: "#2f6bff" },
      },
    },
    paper: { label: "Paper", base: { bg: "#fbf8f1", side: "#f3ecdf", fg: "#2b2622", accent: "#a0522d" } },
    midnight: { label: "Midnight", base: { bg: "#13162b", side: "#0c0f20", fg: "#e6e6f5", accent: "#8b7cf6" } },
    terminal: { label: "Terminal", base: { bg: "#050805", side: "#000000", fg: "#33ff66", accent: "#33ff66" } },
  };

  const baseFor = (name) => {
    const b = { ...THEMES[name]?.base, ...settings.colors[name] };
    if (name === "valorant" && settings.videoAccent && videoAccent.color) b.accent = videoAccent.color;
    return b;
  };

  // "match accent to the video": the most vivid colour in the dash video's thumbnail.
  // (youtube's player itself can't be read from here, but its thumbnail image can.)
  const videoAccent = { id: null, color: null };
  function pickVividColor(img) {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 36;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, 64, 36);
    const px = g.getImageData(0, 0, 64, 36).data;
    // bucket by hue, weighting colourful, not-too-dark pixels
    const buckets = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < px.length; i += 4) {
      const [r, gr, b] = [px[i], px[i + 1], px[i + 2]];
      const max = Math.max(r, gr, b);
      const min = Math.min(r, gr, b);
      const sat = max ? (max - min) / max : 0;
      if (sat < 0.25 || max < 60) continue;
      let hue = 0;
      if (max === r) hue = ((gr - b) / (max - min)) % 6;
      else if (max === gr) hue = (b - r) / (max - min) + 2;
      else hue = (r - gr) / (max - min) + 4;
      const k = Math.floor(((hue * 60 + 360) % 360) / 15);
      const w = sat * sat * (max / 255);
      Object.assign(buckets[k], { w: buckets[k].w + w, r: buckets[k].r + r * w, g: buckets[k].g + gr * w, b: buckets[k].b + b * w });
    }
    const best = buckets.reduce((a, x) => (x.w > a.w ? x : a));
    if (best.w < 0.5) return null;
    // keep the hue but make it punchy enough to be an accent (thumbnails run muted)
    const [r, gr, b] = [best.r / best.w / 255, best.g / best.w / 255, best.b / best.w / 255];
    const max = Math.max(r, gr, b);
    const min = Math.min(r, gr, b);
    const d = max - min;
    let hue = d === 0 ? 0 : max === r ? ((gr - b) / d) % 6 : max === gr ? (b - r) / d + 2 : (r - gr) / d + 4;
    hue = (hue * 60 + 360) % 360;
    const light = Math.min(0.66, Math.max(0.55, (max + min) / 2));
    const sat = 0.8;
    const k = (n) => (n + hue / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
  }

  async function updateVideoAccent() {
    if (!settings.videoAccent) return;
    const id = youtubeId(settings.dashVideo || DEFAULT_VIDEO);
    if (!id || id === videoAccent.id) return;
    videoAccent.id = id;
    for (const size of ["maxresdefault", "hqdefault"]) {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise((ok, fail) => {
          img.onload = ok;
          img.onerror = fail;
          img.src = `https://i.ytimg.com/vi/${id}/${size}.jpg`;
        });
        // youtube serves a tiny grey placeholder when a size doesn't exist
        if (img.naturalWidth < 200) continue;
        const col = pickVividColor(img);
        if (col) {
          videoAccent.color = col;
          applyTheme();
          if (panelEl) renderThemes();
        }
        return;
      } catch {}
    }
  }

  // slack defines its colours as css variables on a handful of selectors.
  // we find those selectors and redeclare the variables on them.
  let varCache = null;
  function slackColorVars() {
    if (varCache && varCache.sheets === document.styleSheets.length) return varCache;
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
    return (varCache = { names: [...names], selectors: [...selectors], sheets: document.styleSheets.length });
  }

  // which of slack's own selectors set a given property. overriding just those is far
  // cheaper than a rule on every element (`body *`), which makes the browser recheck the
  // whole page on every new message or scroll.
  const selectorCache = new Map();
  function slackSelectorsSetting(prop) {
    const key = prop + "|" + document.styleSheets.length;
    if (selectorCache.has(key)) return selectorCache.get(key);
    const out = new Set();
    const walk = (rules) => {
      for (const r of rules) {
        if (r.cssRules?.length) walk(r.cssRules);
        if (!r.style || !r.selectorText || !r.style.getPropertyValue(prop)) continue;
        for (const sel of r.selectorText.split(",")) {
          const t = sel.trim();
          // body-level ones are covered separately; icons, emoji and code keep their fonts
          if (!t || /^(:root|html|body)\b/.test(t) || /icon|emoji|code|pre\b|monospace/i.test(t)) continue;
          out.add(t);
        }
      }
    };
    for (const ss of document.styleSheets) {
      if (ss.ownerNode?.id?.startsWith("sdd-")) continue;
      try {
        walk(ss.cssRules);
      } catch {}
    }
    const list = [...out];
    selectorCache.set(key, list);
    return list;
  }
  // "body.x a, body.x b, …" rather than :is(), so the browser can still index each one
  const scoped = (scope, sels) => sels.map((x) => `${scope} ${x}`).join(",\n");
  function fontRule(name, family, extra = "") {
    const scope = `body.sdd-${name}`;
    const sels = [scope, `${scope} :is(button, input, textarea, select)`, scoped(scope, slackSelectorsSetting("font-family"))].filter(Boolean).join(",\n");
    return `${sels} { font-family: ${family} !important; ${extra} }`;
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
    if (/-imp/.test(k)) return null;
    if (/^content.*hgl/.test(k)) return p.link;
    if (/hgl/.test(k)) return sidebar ? p.select : p.hl;
    if (/(hover|pressed)$/.test(k)) return sidebar ? p.sideHover : p.hover;
    if (/^content-(inv-)?pry/.test(k)) return sidebar ? p.sideFg : p.fg;
    if (/^content-(inv-)?sec/.test(k)) return sidebar ? p.sideFg2 : p.fg2;
    if (/^content/.test(k)) return sidebar ? p.sideFg2 : p.fg3;
    if (/^base-modal/.test(k)) return null;
    if (/^base-(inv-)?ter/.test(k)) return sidebar ? p.side : p.bg3;
    if (/^(base|ctr)/.test(k)) return sidebar ? p.side : p.bg;
    if (sidebar && /^surf-inv-sec/.test(k)) return p.side;
    if (/^surf-(inv-)?pry/.test(k)) return sidebar ? p.sideHover : p.hover;
    if (/^surf/.test(k)) return sidebar ? p.sideHover : p.border;
    if (/^otl/.test(k)) return p.border;
    return null;
  }


  const DOCS_CSS = `
    body.sdd-docs .p-rich_text_section, body.sdd-docs .c-message_kit__blocks .p-rich_text_block { line-height: 1.55 !important; }
    body.sdd-docs .p-rich_text_section a.c-link { color: #1155cc !important; text-decoration: underline !important; }
    body.sdd-docs .p-view_contents--sidebar { border-right: 1px solid var(--sdd-border) !important; }
    body.sdd-docs .p-ia4_top_nav { border-bottom: 1px solid var(--sdd-border) !important; }
    body.sdd-docs .c-message_kit__background:hover { background: #f8f9fa !important; }
    body.sdd-docs .c-wysiwyg_container { border: 1px solid #dadce0 !important; border-radius: 8px !important; box-shadow: none !important; }
    body.sdd-docs .c-wysiwyg_container:focus-within { border-color: #1a73e8 !important; box-shadow: 0 0 0 1px #1a73e8 !important; }
    body.sdd-docs [data-qa^="channel_sidebar__section_heading_label"] { font-weight: 700 !important; color: #444746 !important; }
  `;

  const VALORANT_CSS = `
    /* sharp corners on the parts you see, rather than on every element */
    body.sdd-valorant :is(button, input, textarea, select, img, .c-avatar, .c-base_icon, .c-button, .c-input_text, .c-select_input,
      .c-wysiwyg_container, .c-texty_input, .ReactModal__Content, .c-popover__content, .c-menu, .c-message_attachment, .c-pillow_file_container,
      .c-message_kit__file, .c-file_container, .c-reaction, .c-reaction_add, .c-tabs__tab, .p-top_nav__search, .p-channel_sidebar__channel,
      .c-message_actions__container, .c-message_kit__background, .c-virtual_list__item, .c-search_autocomplete, .c-dialog__content) { border-radius: 0 !important; }
    body.sdd-valorant .c-avatar img, body.sdd-valorant .c-base_icon { border-radius: 0 !important; }
    body.sdd-valorant .c-message_kit__background, body.sdd-valorant .c-virtual_list__item { background-color: transparent; }

    /* while dash is open, slack's own selected tab steps back */
    body.sdd-dash-open .p-tab_rail__tab_menu > :not(#sdd-dash-holder) .p-tab_rail__button--active { opacity: .55; }
    body.sdd-dash-open .p-tab_rail__tab_menu > :not(#sdd-dash-holder) .p-tab_rail__button--active .p-tab_rail__button__label { color: inherit !important; }

    /* dash mode: slack sits on frosted glass over the dash video */
    body.sdd-dashmode [data-sdd-rail], body.sdd-dashmode .p-control_strip { display: none !important; }
    /* the wrapper is a grid with a fixed column for the rail; give that space back */
    body.sdd-dashmode .p-client_workspace_wrapper { grid-template-columns: 0 1fr !important; }
    body.sdd-dashmode .p-client_workspace_wrapper {
      margin-top: 64px !important; height: calc(100% - 104px) !important; position: relative; z-index: 9001; background: transparent !important;
    }
    body.sdd-dashmode.sdd-dash-open .p-client_workspace_wrapper { visibility: hidden; }
    /* slack's menus, pop-ups and the emoji picker open on body; keep them above the raised panes */
    body.sdd-dashmode :is(.ReactModal__Overlay, .c-popover, .c-tooltip, .ReactModalPortal > div, .c-toast, [class*="toast__"], .p-download_modal, .p-downloads_modal) { z-index: 9400 !important; }
    body.sdd-dashmode .p-client_workspace_wrapper :is(.p-client_workspace, .p-client_workspace__layout, .p-view_header,
      .p-view_header--primary-background, .c-scrollbar__hider, .p-message_pane, .p-workspace__primary_view) { background: transparent !important; }
    body.sdd-dashmode .p-client_workspace_wrapper :is(.p-view_contents--primary, .p-view_contents--sidebar, .p-view_contents--secondary) {
      background: rgba(15, 25, 35, .5) !important; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(236, 232, 225, .12) !important;
    }
    body.sdd-dashmode .p-client_workspace_wrapper .c-wysiwyg_container { background: rgba(15, 25, 35, .55) !important; }
    #sdd-home.bg { z-index: 9000; pointer-events: none; }
    #sdd-home.bg .nav { pointer-events: auto; }
    #sdd-home.bg :is(.hero, .cards, .play) { display: none; }

    /* the valorant-style home page (dash) */
    #sdd-home {
      position: fixed; z-index: 9000; overflow: hidden; background: #0f1923; color: #ece8e1;
      font-family: Bahnschrift, "DIN Next", "Arial Narrow", sans-serif;
    }
    #sdd-home iframe {
      position: absolute; top: 50%; left: 50%; border: 0; pointer-events: none;
      /* cover the page, plus a bit extra so youtube's edges are cropped. the player is really
         this big (not scaled up), so youtube serves a sharper stream */
      width: calc(max(var(--w), var(--h) * 1.7778) * 1.15); height: calc(max(var(--h), var(--w) * .5625) * 1.15);
      transform: translate(-50%, -50%);
    }
    #sdd-home video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
    /* "hide the video": it keeps playing (sound, controls) behind a plain backdrop */
    body.sdd-novideo #sdd-home > :is(iframe:not(#sdd-spotify), video) { visibility: hidden; }
    body.sdd-novideo #sdd-home { background: radial-gradient(120% 90% at 100% 100%, color-mix(in srgb, var(--sdd-acc, #ff4655) 18%, transparent), transparent 60%), var(--sdd-bg, #0f1923); }
    #sdd-home .shade {
      position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(90deg, rgba(15,25,35,.85), rgba(15,25,35,.35) 45%, transparent 70%),
                  linear-gradient(0deg, rgba(15,25,35,.75), transparent 35%),
                  linear-gradient(180deg, rgba(15,25,35,.7), transparent 18%);
    }
    #sdd-home .nav {
      position: absolute; left: 0; right: 0; top: 0; height: 64px; display: flex; align-items: center; gap: 26px; padding: 0 32px;
      font-size: 14px; letter-spacing: .14em; text-transform: uppercase; color: rgba(236,232,225,.6);
    }
    #sdd-home .nav button {
      position: relative; padding: 6px 0; border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit;
      text-transform: inherit; cursor: pointer;
    }
    #sdd-home .nav button:hover { color: #ece8e1; }
    #sdd-home .nav .on { color: #ece8e1; cursor: default; }
    #sdd-home .nav .on::after { content: ""; position: absolute; left: 0; right: 0; bottom: -2px; height: 2px; background: var(--sdd-acc, #ff4655); }
    /* unread count right before the label (4DMS), mirrored from slack's rail */
    #sdd-home .nav button[data-badge]::before {
      content: attr(data-badge); color: color-mix(in srgb, var(--sdd-acc, #ff4655) 75%, #ffffff); font-weight: 700; margin-right: 2px;
    }
    #sdd-home .nav .right { margin-left: auto; display: flex; gap: 26px; align-items: center; }
    #sdd-home .spaces { position: relative; }
    body.sdd-nomedia #sdd-home .nav .media { display: none !important; }
    #sdd-home .nav .media { display: flex; align-items: center; gap: 12px; letter-spacing: .04em; }
    #sdd-home .nav .media button { padding: 4px; display: grid; place-items: center; color: rgba(236,232,225,.75); }
    #sdd-home .nav .media button:hover { color: #ece8e1; }
    #sdd-home .nav .seek {
      width: 180px; height: 4px; margin: 0; cursor: pointer; appearance: none; -webkit-appearance: none; border-radius: 2px !important;
      background: linear-gradient(90deg, var(--sdd-acc, #ff4655) var(--p, 0%), rgba(236,232,225,.25) var(--p, 0%));
    }
    #sdd-home .nav .vol {
      width: 80px; height: 4px; margin: 0; cursor: pointer; appearance: none; -webkit-appearance: none; border-radius: 2px !important;
      background: linear-gradient(90deg, #ece8e1 var(--p, 100%), rgba(236,232,225,.25) var(--p, 100%));
    }
    #sdd-home .nav .vol::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50% !important; background: #ece8e1; }
    #sdd-home .nav .seek::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50% !important; background: #ece8e1; }
    #sdd-home .nav .time { font-size: 12px; min-width: 88px; color: rgba(236,232,225,.7); text-transform: none; }
    #sdd-home .card.now { cursor: default; width: 300px; }
    /* spotify plays from a hidden player; its embed has no volume, so those controls go */
    #sdd-home #sdd-spotify { position: absolute; left: -10000px; top: 0; width: 400px; height: 352px; border: 0; }
    #sdd-home .nav .media.spotify :is([data-media="mute"], .vol) { display: none; }
    #sdd-home .card.now b { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #sdd-home .card.now small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* lives on body above everything, so slack's panes (in dash mode) can't cover it */
    #sdd-spaces-menu {
      position: fixed; z-index: 9500; min-width: 220px; padding: 6px 0;
      background: rgba(15,25,35,.96); border: 1px solid rgba(236,232,225,.15); letter-spacing: .08em;
      font: 14px Bahnschrift, "DIN Next", sans-serif; text-transform: uppercase;
    }
    #sdd-spaces-menu[hidden] { display: none; }
    #sdd-spaces-menu button {
      display: block; width: 100%; text-align: left; padding: 9px 16px; border: 0; background: none; cursor: pointer;
      color: rgba(236,232,225,.75); font: inherit; letter-spacing: inherit; text-transform: inherit;
    }
    #sdd-spaces-menu button:hover { color: #ece8e1; background: rgba(236,232,225,.08); }
    #sdd-spaces-menu button.on { color: #ece8e1; box-shadow: inset 3px 0 0 var(--sdd-acc, #ff4655); cursor: default; }
    /* play sits at the end of the top bar; on the background (dash mode, other pages) it hides */
    #sdd-home .nav button.play {
      position: relative; padding: 10px 44px; border: 0; cursor: pointer;
      background: var(--sdd-acc, #ff4655); color: var(--sdd-accfg, #fff); font: 700 22px/1 Bahnschrift, sans-serif; letter-spacing: .2em; text-transform: uppercase;
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%);
    }
    #sdd-home .nav button.play:hover { filter: brightness(1.1); color: var(--sdd-accfg, #fff); }
    #sdd-home .nav button.play::after { display: none; }
    #sdd-home .hero { position: absolute; left: 48px; bottom: 56px; max-width: 46%; }
    #sdd-home .tag {
      display: inline-block; padding: 4px 10px; background: var(--sdd-acc, #ff4655); color: var(--sdd-accfg, #fff);
      font-size: 12px; letter-spacing: .2em; font-weight: 700; text-transform: uppercase;
    }
    #sdd-home h1 { margin: 10px 0 2px; font-size: clamp(64px, 11vw, 150px); line-height: .85; font-weight: 700; letter-spacing: .02em; font-stretch: condensed; }
    #sdd-home .role { font-size: 15px; letter-spacing: .24em; text-transform: uppercase; color: rgba(236,232,225,.75); }
    #sdd-home .blurb { margin: 14px 0 0; font-size: 15px; line-height: 1.5; color: rgba(236,232,225,.85); max-width: 420px; }
    #sdd-home .cards { position: absolute; right: 32px; bottom: 32px; display: flex; gap: 12px; }
    #sdd-home .card {
      width: 220px; padding: 14px 16px; background: rgba(15,25,35,.78); border: 1px solid rgba(236,232,225,.15); cursor: pointer; color: inherit; text-align: left;
      font: inherit;
    }
    #sdd-home .card:hover { border-color: var(--sdd-acc, #ff4655); }
    #sdd-home .card small { display: block; font-size: 11px; letter-spacing: .2em; color: color-mix(in srgb, var(--sdd-acc, #ff4655) 65%, #ffffff); margin-bottom: 6px; text-transform: uppercase; }
    #sdd-home .card b { font-size: 16px; letter-spacing: .06em; text-transform: uppercase; font-weight: 600; }

    /* plain hover states, no motion */
    body.sdd-valorant [data-qa="channel-sidebar-chan"]:hover { box-shadow: inset 2px 0 0 var(--sdd-acc) !important; }
    body.sdd-valorant .c-message_kit__background:hover {
      box-shadow: inset 2px 0 0 var(--sdd-acc); background-color: color-mix(in srgb, var(--sdd-fg) 4%, transparent) !important;
    }
    body.sdd-valorant .p-tab_rail__button:hover .p-tab_rail__button__label { color: var(--sdd-acc) !important; }
    body.sdd-valorant .p-top_nav__search { border-bottom: 1px solid color-mix(in srgb, var(--sdd-fg) 25%, transparent) !important; }
    /* bahnschrift reads heavy at slack's weights, so lighten the everyday text */
    body.sdd-valorant .p-rich_text_section, body.sdd-valorant .p-rich_text_list, body.sdd-valorant .c-message_kit__blocks,
    body.sdd-valorant .c-message_attachment, body.sdd-valorant .ql-editor, body.sdd-valorant .p-view_header__topic {
      font-weight: 300 !important; letter-spacing: .01em !important;
    }
    body.sdd-valorant .p-rich_text_section b, body.sdd-valorant .p-rich_text_section strong { font-weight: 600 !important; }
    body.sdd-valorant [data-qa="channel-sidebar-chan"] { font-weight: 350 !important; }
    /* corner ticks on the message box, like valorant's framed panels */
    body.sdd-valorant .c-wysiwyg_container {
      background:
        linear-gradient(var(--sdd-fg2), var(--sdd-fg2)) left top / 12px 2px no-repeat,
        linear-gradient(var(--sdd-fg2), var(--sdd-fg2)) left top / 2px 12px no-repeat,
        linear-gradient(var(--sdd-fg2), var(--sdd-fg2)) right bottom / 12px 2px no-repeat,
        linear-gradient(var(--sdd-fg2), var(--sdd-fg2)) right bottom / 2px 12px no-repeat,
        color-mix(in srgb, var(--sdd-bg) 88%, transparent) !important;
    }
    body.sdd-valorant [data-qa^="channel_sidebar__section_heading_label"],
    body.sdd-valorant .p-tab_rail__button__label,
    body.sdd-valorant .c-tabs__tab,
    body.sdd-valorant .p-ia4_home_header,
    body.sdd-valorant .p-view_header__channel_title,
    body.sdd-valorant [data-qa="channel_name"] {
      text-transform: uppercase !important; letter-spacing: .08em !important;
    }
    body.sdd-valorant [data-qa^="channel_sidebar__section_heading_label"] { font-size: 13px !important; color: var(--sdd-fg2) !important; }
    body.sdd-valorant [data-qa^="channel_sidebar__section_heading_label"][class*="Unreads"] { color: var(--sdd-fg) !important; }
    body.sdd-valorant [data-qa-channel-sidebar-channel-is-selected="true"] {
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%);
      box-shadow: inset 3px 0 0 var(--sdd-accfg) !important;
    }
    body.sdd-valorant .c-message__sender_button { letter-spacing: .03em !important; font-weight: 600 !important; }
    body.sdd-valorant .c-wysiwyg_container, body.sdd-valorant .c-wysiwyg_container:focus-within {
      border: 1px solid var(--sdd-border) !important; box-shadow: none !important; outline: none !important;
    }
    body.sdd-valorant .c-wysiwyg_container__button--send:not(.c-wysiwyg_container__button--disabled) {
      background: var(--sdd-acc) !important; color: var(--sdd-accfg) !important;
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%);
    }
    body.sdd-valorant .c-tabs__tab--active { box-shadow: inset 0 -2px 0 var(--sdd-acc) !important; }
    body.sdd-valorant .p-tab_rail__button--active .p-tab_rail__button__label { color: var(--sdd-acc) !important; }
    body.sdd-valorant .p-ia4_top_nav { border-bottom: 1px solid var(--sdd-border) !important; }
    body.sdd-valorant .p-view_contents--sidebar { border-right: 1px solid var(--sdd-border) !important; }
    body.sdd-valorant ::selection { background: var(--sdd-acc); color: var(--sdd-accfg); }
    body.sdd-valorant ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--sdd-acc) 55%, transparent) !important; }
    body.sdd-valorant .p-rich_text_section a.c-link { color: var(--sdd-acc) !important; }
  `;

  let themeStyle = null;

  function applyTheme() {
    const name = THEMES[settings.theme] ? settings.theme : "slack";
    document.body.classList.remove(...Object.keys(THEMES).map((t) => `sdd-${t}`));
    themeStyle?.remove();
    themeStyle = null;
    stylePanel();
    if (!THEMES[name].base) return;

    const p = palette(baseFor(name));
    const { names, selectors } = slackColorVars();
    const decls = names
      .map((n) => [n, pickColor(n, p)])
      .filter(([, v]) => v)
      .map(([n, v]) => `${n}: ${v} !important;`)
      .join("\n");
    const sel = [...selectors, '[style*="--dt_color"]', '[style*="--sk_"]'].join(",\n");
    themeStyle = document.createElement("style");
    themeStyle.id = "sdd-theme";
    themeStyle.textContent = `
      ${sel} { ${decls} }
      body.sdd-${name} {
        --sdd-bg: ${p.bg}; --sdd-fg: ${p.fg}; --sdd-fg2: ${p.fg2}; --sdd-border: ${p.border};
        --sdd-acc: ${p.accent}; --sdd-accfg: ${p.accentFg}; --sdd-side: ${p.side};
        background: ${p.bg} !important; color: ${p.fg} !important;
      }
      ${["html", "body", scoped(`body.sdd-${name}`, slackSelectorsSetting("color-scheme"))].filter(Boolean).join(",\n")} { color-scheme: ${p.light ? "light" : "dark"} !important; }
      body.sdd-${name} .p-theme_background { background: ${p.side} !important; filter: none !important; }
      body.sdd-${name} .p-theme_background::before, body.sdd-${name} .p-theme_background::after { display: none !important; }
      body.sdd-${name} .c-wysiwyg_container { --TextyTheme-wysiwyg-bg: ${p.bg}; background: ${p.bg} !important; border-color: ${p.border} !important; }
      body.sdd-${name} [data-qa-channel-sidebar-channel-is-selected="true"] { background: ${p.select} !important; color: ${p.selectFg} !important; }
      body.sdd-${name} [data-qa-channel-sidebar-channel-is-selected="true"] * { color: ${p.selectFg} !important; }
      ${name === "terminal" ? fontRule("terminal", '"Cascadia Mono", Consolas, monospace') : ""}
      ${name === "docs" ? fontRule("docs", "Arial, Helvetica, sans-serif", "letter-spacing: normal !important;") : ""}
      ${name === "valorant" ? fontRule("valorant", 'Bahnschrift, "DIN Next", "D-DIN", "Arial Narrow", sans-serif') : ""}
      ${name === "valorant" ? `body.sdd-dashmode .p-client_workspace_wrapper,
${scoped("body.sdd-dashmode .p-client_workspace_wrapper", selectors.filter((x) => !/^(:root|html|body)\b/.test(x) && !x.startsWith("[style")))} {
        --dt_color-base-pry: transparent !important; --dt_color-base-sec: transparent !important; --dt_color-base-ter: transparent !important;
        --dt_color-theme-base-pry: transparent !important; --dt_color-theme-base-sec: transparent !important;
        --dt_color-theme-surf-inv-sec: transparent !important; --dt_color-ctr-pry: transparent !important;
      }` : ""}
      ${name === "paper" ? `body.sdd-paper .p-rich_text_section, body.sdd-paper .c-message_kit__blocks { font-family: Georgia, "Times New Roman", serif !important; font-size: 15.5px !important; }` : ""}
      ${name === "docs" ? DOCS_CSS : ""}
      ${name === "valorant" ? VALORANT_CSS : ""}
    `;
    document.head.appendChild(themeStyle);
    document.body.classList.add(`sdd-${name}`);
    mountFx();
  }

  // valorant gets a "dash" button in the left rail. it opens a valorant-style home page
  // over the rail, channel sidebar and messages, looping a video: the hush agent trailer
  // unless you've set your own link in the panel. youtube links play through youtube's
  // embed player, so nothing is downloaded; other links play as plain video files.
  const DEFAULT_VIDEO = "https://www.youtube.com/watch?v=AfcCyTsh4ag";
  settings.home ??= true;

  function youtubeId(url) {
    const s = String(url || "").trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    return s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/)?.[1] || null;
  }

  function dashVideo() {
    const url = settings.dashVideo || DEFAULT_VIDEO;
    const id = youtubeId(url);
    if (!id) return { kind: "file", src: url, custom: true };
    const src =
      `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}` +
      "&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&enablejsapi=1&cc_load_policy=0" +
      `&origin=${encodeURIComponent(location.origin)}`;
    return { kind: "youtube", src, custom: !!settings.dashVideo && url !== DEFAULT_VIDEO };
  }

  // anything that isn't a youtube link has to at least look like a web address
  function validVideoLink(url) {
    if (youtubeId(url)) return true;
    try {
      return /^https?:$/.test(new URL(url).protocol);
    } catch {
      return false;
    }
  }
  delete settings.video;

  const homeEnabled = () => settings.theme === "valorant" && settings.home;
  // dash mode: no rail or channel list; slack runs inside the dash, over the video
  const dashMode = () => homeEnabled() && !!settings.dashMode;
  const DASH_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 4l5.5 12h3L17 4h-3.6L10 11.6 6.6 4z"/></svg>`;

  let dashEl = null;
  function mountDash() {
    if (!homeEnabled()) {
      dashEl?.remove();
      dashEl = null;
      return;
    }
    if (dashEl?.isConnected) return;
    dashEl = cloneRailButton("sdd-dash-holder", "Dash", "Dash", DASH_ICON, () => (homeOpen ? closeHome() : openHome()));
    if (!dashEl) return;
    // first in the rail, above slack's home
    document.querySelector(".p-tab_rail__tab_menu")?.prepend(dashEl);
  }

  let homeOpen = false;
  let homeEl = null;
  let muted = true;

  // ---- dash media controls (top bar) and the "now playing" card
  const ic = (d) => `<svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">${d}</svg>`;
  const MEDIA_ICONS = {
    back: ic('<path d="M9 5 3 10l6 5V5zm8 0-6 5 6 5V5z"/>'),
    fwd: ic('<path d="m11 5 6 5-6 5V5zM3 5l6 5-6 5V5z"/>'),
    pause: ic('<path d="M5 4h3.5v12H5zm6.5 0H15v12h-3.5z"/>'),
    play: ic('<path d="M6 4v12l10-6z"/>'),
    muted: ic('<path d="M3 7.5h3L10 4v12l-4-3.5H3z"/><path d="m12.5 7.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="1.6" fill="none"/>'),
    sound: ic('<path d="M3 7.5h3L10 4v12l-4-3.5H3z"/><path d="M13 7a4 4 0 0 1 0 6m2-8.5a7 7 0 0 1 0 11" stroke="currentColor" stroke-width="1.6" fill="none"/>'),
  };
  const media = { time: 0, dur: 0, playing: true, muted: true, title: "", author: "", volume: 100 };
  let mediaDragging = false;

  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };
  const todayLabel = () => {
    const d = new Date();
    return `${d.toLocaleDateString("en-US", { month: "short" })} ${d.getDate()} // ${d.toLocaleDateString("en-US", { weekday: "short" })}`;
  };

  // youtube's embed player talks over postMessage: we ask it to report in, then it
  // streams its time, length, play state and title back
  const ytFrame = () => homeEl?.querySelector("iframe");
  const ytCmd = (func, args = []) => ytFrame()?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
  function onPlayerMessage(e) {
    // only our dash player; slack's own youtube previews talk on the same channel
    if (!e.source || e.source !== ytFrame()?.contentWindow) return;
    // with spotify on, the controls follow spotify; the video just plays quietly
    if (useSpotify() || useApp()) return;
    let d;
    try {
      d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    const i = d?.info;
    if (d?.event !== "infoDelivery" || !i) return;
    if (typeof i.currentTime === "number") media.time = i.currentTime;
    if (typeof i.duration === "number" && i.duration) media.dur = i.duration;
    if (typeof i.playerState === "number") media.playing = i.playerState === 1 || i.playerState === 3;
    if (typeof i.muted === "boolean") media.muted = i.muted;
    if (typeof i.volume === "number") media.volume = i.volume;
    if (i.videoData?.title) Object.assign(media, { title: i.videoData.title, author: i.videoData.author || "" });
    renderMedia();
  }
  window.addEventListener("message", onPlayerMessage);
  cleanups.push(() => window.removeEventListener("message", onPlayerMessage));

  // ---- spotify instead of the video's sound. its embed player takes play/pause/seek
  // over postMessage; next/previous song and the song name go through the launcher,
  // which can reach inside the player (window.sddBridge).
  function spotifyEmbed(url) {
    const m = String(url || "").match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|track|artist|show|episode)\/([A-Za-z0-9]+)/);
    return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
  }
  const useApp = () => !!settings.spotifyApp && navigator.userAgent.includes("Windows");
  const useSpotify = () => !useApp() && !!spotifyEmbed(settings.spotify);
  // "spotify:playlist:<id>" for opening the link in the desktop app
  const spotifyUri = (url) => {
    const m = String(url || "").match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|track|artist|show|episode)\/([A-Za-z0-9]+)/);
    return m ? `spotify:${m[1]}:${m[2]}` : null;
  };
  const spFrame = () => homeEl?.querySelector("#sdd-spotify");
  const spCmd = (command, extra = {}) => spFrame()?.contentWindow?.postMessage({ command, ...extra }, "*");
  let bridgeSeq = 0;
  const bridgeWaiters = new Map();
  window.__sddBridgeReply = ({ id, result }) => {
    bridgeWaiters.get(id)?.(result);
    bridgeWaiters.delete(id);
  };
  function bridge(action, extra = {}, cmd = "spotify") {
    if (typeof window.sddBridge !== "function") return Promise.resolve(null);
    const id = ++bridgeSeq;
    return new Promise((resolve) => {
      bridgeWaiters.set(id, resolve);
      window.sddBridge(JSON.stringify({ cmd, action, id, ...extra }));
      setTimeout(() => bridgeWaiters.has(id) && (bridgeWaiters.delete(id), resolve(null)), 3000);
    });
  }
  async function refreshSpotifyTrack() {
    const r = await bridge("track");
    if (!r) return;
    media.title = r.title || r.playlist || "Spotify";
    media.author = r.title ? r.artist || r.playlist : "Spotify";
    renderMedia();
  }
  function onSpotifyMessage(e) {
    if (!e.source || e.source !== spFrame()?.contentWindow) return;
    const d = typeof e.data === "string" ? (() => { try { return JSON.parse(e.data); } catch { return null; } })() : e.data;
    if (d?.type === "ready") refreshSpotifyTrack();
    if (d?.type !== "playback_update" || !d.payload) return;
    const p = d.payload;
    const was = media.title;
    Object.assign(media, { time: (p.position || 0) / 1000, dur: (p.duration || 0) / 1000, playing: !p.isPaused });
    // a new song started (position jumped back near zero): ask what it is
    if (media.time < 2 || !was) refreshSpotifyTrack();
    renderMedia();
  }
  // the spotify desktop app, via the launcher and windows' media controls
  const appCmd = (action, extra = {}) => bridge(action, extra, "app");
  let appBusy = false;
  let appLast = 0;
  function applyAppState(st) {
    if (!st) return;
    if (!st.ok) {
      Object.assign(media, { title: "Play something on your computer", author: "Nothing playing", playing: false, time: 0, dur: 0 });
    } else {
      Object.assign(media, { title: st.title || st.app || "Music", author: [st.artist, st.app].filter(Boolean).join(" · ") || "Now playing", time: st.time || 0, dur: st.dur || 0, playing: !!st.playing });
    }
    renderMedia();
  }
  async function pollApp(force) {
    if (!useApp() || !homeEl || appBusy || (!force && Date.now() - appLast < 2000)) return;
    appBusy = true;
    appLast = Date.now();
    try {
      applyAppState(await appCmd("state"));
    } finally {
      appBusy = false;
    }
  }
  window.addEventListener("message", onSpotifyMessage);
  cleanups.push(() => window.removeEventListener("message", onSpotifyMessage));

  // decoding a sharp video costs a lot, so only pay for it when it's actually seen:
  // 1080p on the dash, 720p behind the frosted glass, lowest when hidden (sound is the same)
  let qualitySet = { q: null, at: 0 };
  function tuneVideoQuality() {
    if (!homeEl || !ytFrame()) return;
    const hidden = !!settings.hideVideo || (!homeOpen && !homeEl.classList.contains("bg"));
    const q = hidden ? "tiny" : homeOpen ? "hd1080" : "hd720";
    // re-send now and then: the launcher picks its own quality while the player loads
    if (q === qualitySet.q && Date.now() - qualitySet.at < 5000) return;
    qualitySet = { q, at: Date.now() };
    ytCmd("setPlaybackQualityRange", [q, q]);
    ytCmd("setPlaybackQuality", [q]);
  }

  function renderMedia() {
    if (!homeEl) return;
    homeEl.querySelector(".media").classList.toggle("spotify", useSpotify() || useApp());
    const toggle = homeEl.querySelector('[data-media="toggle"]');
    const mute = homeEl.querySelector('[data-media="mute"]');
    toggle.innerHTML = media.playing ? MEDIA_ICONS.pause : MEDIA_ICONS.play;
    toggle.title = media.playing ? "Pause" : "Play";
    mute.innerHTML = media.muted ? MEDIA_ICONS.muted : MEDIA_ICONS.sound;
    mute.title = media.muted ? "Unmute" : "Mute";
    const seek = homeEl.querySelector(".seek");
    if (!mediaDragging) seek.value = media.dur ? Math.round((media.time / media.dur) * 1000) : 0;
    seek.style.setProperty("--p", `${seek.value / 10}%`);
    homeEl.querySelector(".time").textContent = media.dur ? `${fmtTime(media.time)} / ${fmtTime(media.dur)}` : fmtTime(media.time);
    const vol = homeEl.querySelector(".vol");
    if (document.activeElement !== vol) vol.value = media.muted ? 0 : media.volume;
    vol.style.setProperty("--p", `${vol.value}%`);
    homeEl.querySelector(".np-title").textContent = media.title || "On loop";
    homeEl.querySelector(".np-by").textContent = media.author || "Now playing";
  }

  function mediaCommand(cmd, arg) {
    if (useApp()) {
      const action = { toggle: "toggle", back: "prev", fwd: "next", seek: "seek" }[cmd];
      if (!action) return;
      if (cmd === "toggle") media.playing = !media.playing;
      if (cmd === "seek") media.time = arg * (media.dur || 0);
      renderMedia();
      appCmd(action, { arg: cmd === "seek" ? media.time : undefined }).then(applyAppState);
      return;
    }
    if (useSpotify() && spFrame()) {
      if (cmd === "toggle") {
        media.playing = !media.playing;
        spCmd("toggle");
      } else if (cmd === "back" || cmd === "fwd") {
        bridge(cmd === "fwd" ? "next" : "prev").then(() => setTimeout(refreshSpotifyTrack, 800));
      } else if (cmd === "seek" && media.dur) {
        media.time = arg * media.dur;
        spCmd("seek", { timestamp: media.time });
      }
      return renderMedia();
    }
    const v = homeEl?.querySelector("video");
    if (cmd === "toggle") {
      media.playing = !media.playing;
      if (v) media.playing ? v.play() : v.pause();
      else ytCmd(media.playing ? "playVideo" : "pauseVideo");
    } else if (cmd === "back" || cmd === "fwd") {
      const t = Math.max(0, Math.min(media.dur || Infinity, media.time + (cmd === "fwd" ? 5 : -5)));
      media.time = t;
      if (v) v.currentTime = t;
      else ytCmd("seekTo", [t, true]);
    } else if (cmd === "seek") {
      const t = arg * (media.dur || 0);
      media.time = t;
      if (v) v.currentTime = t;
      else ytCmd("seekTo", [t, true]);
    } else if (cmd === "mute") {
      media.muted = !media.muted;
      muted = media.muted;
      if (v) v.muted = media.muted;
      else {
        if (!media.muted && !media.volume) {
          media.volume = 60;
          ytCmd("setVolume", [60]);
        }
        ytCmd(media.muted ? "mute" : "unMute");
      }
    }
    renderMedia();
  }

  function wireMedia(root, vid) {
    root.querySelector(".media").addEventListener("click", (e) => {
      const b = e.target.closest("[data-media]");
      if (b) {
        e.stopPropagation();
        mediaCommand(b.dataset.media);
      }
    });
    const seek = root.querySelector(".seek");
    seek.addEventListener("input", () => {
      mediaDragging = true;
      seek.style.setProperty("--p", `${seek.value / 10}%`);
      root.querySelector(".time").textContent = `${fmtTime((seek.value / 1000) * media.dur)} / ${fmtTime(media.dur)}`;
    });
    seek.addEventListener("change", () => {
      mediaDragging = false;
      mediaCommand("seek", seek.value / 1000);
    });
    seek.addEventListener("keydown", (e) => e.stopPropagation());
    // volume: dragging it up from zero also unmutes
    const vol = root.querySelector(".vol");
    vol.addEventListener("input", () => {
      const n = Number(vol.value);
      vol.style.setProperty("--p", `${n}%`);
      media.volume = n;
      const vEl = root.querySelector("video");
      if (vEl) {
        vEl.volume = n / 100;
        vEl.muted = n === 0;
      } else {
        ytCmd("setVolume", [n]);
        ytCmd(n === 0 ? "mute" : "unMute");
      }
      media.muted = n === 0;
      muted = media.muted;
      renderMedia();
    });
    vol.addEventListener("keydown", (e) => e.stopPropagation());
    const v = root.querySelector("video");
    if (v) {
      const sync = () => {
        Object.assign(media, { time: v.currentTime, dur: v.duration || 0, playing: !v.paused, muted: v.muted });
        media.title ||= decodeURIComponent((vid.src.split("/").pop() || "").split("?")[0]) || "Your video";
        renderMedia();
      };
      for (const ev of ["timeupdate", "play", "pause", "volumechange", "loadedmetadata"]) v.addEventListener(ev, sync);
    } else {
      // keep asking the player to report in until it does
      const iframe = root.querySelector("iframe");
      const ping = () => iframe.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: "sdd", channel: "widget" }), "*");
      // with spotify on, the video stays muted
      const quiet = () => (useSpotify() || useApp()) && iframe.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "mute", args: [] }), "*");
      iframe.addEventListener("load", () => [0, 800, 2000, 4000].forEach((t) => setTimeout(() => (ping(), quiet()), t)));
    }
    renderMedia();
  }

  // covers everything under the top bar, left rail included
  function placeHome() {
    if (!homeEl) return;
    const ws = document.querySelector(".p-client_workspace_wrapper")?.getBoundingClientRect();
    if (!ws) return;
    const left = 0;
    const top = document.querySelector(".p-ia4_top_nav")?.getBoundingClientRect().bottom ?? ws.top;
    const width = ws.right - left;
    const height = ws.bottom - top;
    Object.assign(homeEl.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    homeEl.style.setProperty("--w", `${width}px`);
    homeEl.style.setProperty("--h", `${height}px`);
  }

  function openHome() {
    if (!homeEnabled()) return;
    const vid = dashVideo();
    // still playing from last time: just show it again
    if (homeEl && homeEl.dataset.src === vid.src + "|" + ((useSpotify() && spotifyEmbed(settings.spotify)) || "") + (useApp() ? "|app" : "")) {
      Object.assign(homeEl.style, { visibility: "", pointerEvents: "" });
      homeEl.classList.remove("bg");
      markNav();
      placeHome();
      homeOpen = true;
      homeRoute = location.pathname;
      dashEl?.querySelector("button")?.classList.add("p-tab_rail__button--active");
      document.body.classList.add("sdd-dash-open");
      return;
    }
    homeEl?.remove();
    muted = true;
    const media =
      vid.kind === "youtube"
        ? `<iframe src="${esc(vid.src)}" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media" tabindex="-1" title="Dash video"></iframe>`
        : `<video src="${esc(vid.src)}" autoplay muted loop playsinline tabindex="-1"></video>`;
    Object.assign(media, { time: 0, dur: 0, playing: !useSpotify() && !useApp(), muted: true, title: "", author: "" });
    const sp = useSpotify() ? spotifyEmbed(settings.spotify) : null;
    const spotifyFrame = sp
      ? `<iframe id="sdd-spotify" src="${esc(sp)}" allow="autoplay; encrypted-media; clipboard-write" tabindex="-1" title="Spotify"></iframe>`
      : "";
    homeEl = h(`<section id="sdd-home" aria-label="Dash">
      ${media}
      ${spotifyFrame}
      <div class="shade"></div>
      <div class="nav">
        <button type="button" class="on" data-act="dash">Dash</button>
        <button type="button" data-act="channels">Channels</button>
        <button type="button" data-tab="tab_rail_dms_button">DMs</button>
        <button type="button" data-tab="tab_rail_activity_button">Activity</button>
        <button type="button" data-tab="tab_rail_later_button">To-dos</button>
        <div class="right">
          <div class="media">
            <button type="button" data-media="back" title="${useSpotify() || useApp() ? "Previous song" : "Back 5 seconds"}">${MEDIA_ICONS.back}</button>
            <button type="button" data-media="toggle" title="Pause">${MEDIA_ICONS.pause}</button>
            <button type="button" data-media="fwd" title="${useSpotify() || useApp() ? "Next song" : "Forward 5 seconds"}">${MEDIA_ICONS.fwd}</button>
            <input type="range" class="seek" min="0" max="1000" value="0" aria-label="Video position">
            <span class="time">0:00</span>
            <button type="button" data-media="mute" title="Unmute">${MEDIA_ICONS.muted}</button>
            <input type="range" class="vol" min="0" max="100" value="100" aria-label="Volume">
          </div>
          <button type="button" data-act="panel">Sidebar</button>
          <div class="spaces">
            <button type="button" data-act="spaces" aria-haspopup="menu">Spaces ▾</button>
            <div class="menu" role="menu" hidden>${workspaceItems()}</div>
          </div>
          <button type="button" data-act="profile">Profile</button>
          <button class="play" type="button" title="Back to Slack">Play</button>
        </div>
      </div>
      <div class="hero">
        <span class="tag">It's go time!</span>
        <h1>OODLIA JU</h1>
        <div class="role">Gappie // Burlington VT</div>
        <p class="blurb">Checking the weather in Burlington…</p>
      </div>
      <div class="cards">
        <div class="card now"><small class="np-by">Now playing</small><b class="np-title">…</b></div>
        <button class="card" data-act="back" type="button"><small>${esc(todayLabel())}</small><b>Back to Slack</b></button>
      </div>
    </section>`);
    // the spaces menu moves to body so it sits above slack's panes in dash mode
    document.getElementById("sdd-spaces-menu")?.remove();
    const spacesMenu = homeEl.querySelector(".spaces .menu");
    spacesMenu.id = "sdd-spaces-menu";
    document.body.appendChild(spacesMenu);
    spacesMenu.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-team]");
      spacesMenu.hidden = true;
      if (b) switchWorkspace(b.dataset.team);
    });
    const toggleSpaces = (btn) => {
      if (!spacesMenu.hidden) return (spacesMenu.hidden = true);
      spacesMenu.innerHTML = workspaceItems();
      const r = btn.getBoundingClientRect();
      Object.assign(spacesMenu.style, { top: `${r.bottom + 10}px`, right: `${innerWidth - r.right}px` });
      spacesMenu.hidden = false;
    };

    homeEl.querySelector(".nav").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "dash") {
        if (!homeOpen) openHome();
      } else if (b.dataset.tab) {
        closeHome();
        document.querySelector(`[data-qa="${b.dataset.tab}"]`)?.click();
        setTimeout(markNav, 300);
      } else if (b.dataset.act === "channels") toggleDrawer();
      else if (b.dataset.act === "panel") togglePanel();
      else if (b.dataset.act === "spaces") toggleSpaces(b);
      else if (b.dataset.act === "profile") {
        // slack's profile menu hangs off the avatar in the rail, so bring the rail back first
        closeHome();
        document.querySelector('[data-qa="user-button"]')?.click();
      } else if (b.dataset.team) switchWorkspace(b.dataset.team);
    });
    homeEl.querySelector(".play").addEventListener("click", closeHome);
    homeEl.querySelector('[data-act="back"]').addEventListener("click", closeHome);
    wireMedia(homeEl, vid);
    homeEl.dataset.src = vid.src + "|" + (sp || "") + (useApp() ? "|app" : "");
    if (useApp()) setTimeout(() => pollApp(true), 300);
    document.body.appendChild(homeEl);
    placeHome();
    const blurb = homeEl.querySelector(".blurb");
    burlingtonWeather().then(
      (text) => (blurb.textContent = text),
      () => (blurb.textContent = "Couldn't get Burlington's weather right now."),
    );
    homeOpen = true;
    homeRoute = location.pathname;
    dashEl?.querySelector("button")?.classList.add("p-tab_rail__button--active");
    document.body.classList.add("sdd-dash-open");
  }

  // today's weather in burlington, vt from open-meteo (free, no key; only the city's
  // coordinates are sent). kept for 15 minutes so reopening dash doesn't refetch.
  const WEATHER = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "cloudy", 45: "foggy", 48: "foggy",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "rain showers", 81: "rain showers", 82: "heavy rain showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
  };
  let weatherCache = null;
  async function burlingtonWeather() {
    if (weatherCache && Date.now() - weatherCache.at < 15 * 60 * 1000) return weatherCache.text;
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=44.4759&longitude=-73.2121" +
      "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code" +
      "&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=1";
    const j = await (await fetch(url)).json();
    const now = Math.round(j.current.temperature_2m);
    const hi = Math.round(j.daily.temperature_2m_max[0]);
    const lo = Math.round(j.daily.temperature_2m_min[0]);
    const sky = WEATHER[j.current.weather_code] ?? "mixed";
    const day = WEATHER[j.daily.weather_code[0]] ?? "mixed";
    const text = `${now}°F and ${sky} in Burlington right now. Today: ${day}, high of ${hi}°, low of ${lo}°.`;
    weatherCache = { at: Date.now(), text };
    return text;
  }

  // the workspaces you're signed into, one per name (an org and its workspace share one)
  function workspaceList() {
    let teams = {};
    try {
      teams = JSON.parse(localStorage.getItem("localConfig_v2") || "{}").teams || {};
    } catch {}
    const byName = new Map();
    for (const t of Object.values(teams)) {
      if (!t?.id || !t.name) continue;
      const prev = byName.get(t.name);
      if (!prev || t.id.startsWith("E")) byName.set(t.name, t);
    }
    return [...byName.values()];
  }

  function workspaceItems() {
    const current = location.pathname.split("/")[2];
    return workspaceList()
      .map((t) => `<button type="button" role="menuitem" class="${t.id === current ? "on" : ""}" data-team="${esc(t.id)}">${esc(t.name)}</button>`)
      .join("");
  }

  // go straight to the workspace's address. slack's own switcher menu hangs off the
  // workspace icon in the rail, which dash mode hides, so it opens invisibly.
  function switchWorkspace(id) {
    const team = workspaceList().find((t) => t.id === id);
    if (!team || id === location.pathname.split("/")[2]) return;
    location.assign(`/client/${team.id}`);
  }

  let homeRoute = null;
  // leaving dash only hides it, so the video (and sound) keeps going in the background
  // in dash mode it drops behind slack instead, as the background with the top bar
  function closeHome() {
    if (homeEl && dashMode()) homeEl.classList.add("bg");
    else if (homeEl) Object.assign(homeEl.style, { visibility: "hidden", pointerEvents: "none" });
    homeOpen = false;
    markNav();
    dashEl?.querySelector("button")?.classList.remove("p-tab_rail__button--active");
    document.body.classList.remove("sdd-dash-open");
  }

  // actually stops the video: theme changes, dash turned off, or a new video link
  function destroyHome() {
    closeHome();
    document.getElementById("sdd-spaces-menu")?.remove();
    homeEl?.remove();
    homeEl = null;
  }

  // the channels tab is slack's home, channel list and all
  function toggleDrawer() {
    closeHome();
    const home = document.querySelector('[data-qa="tab_rail_home_button"]');
    if (!home?.classList.contains("p-tab_rail__button--active")) home?.click();
    setTimeout(() => {
      layoutSidebar();
      markNav();
    }, 200);
  }

  // underline whichever tab you're on in the dash top bar
  function markNav() {
    if (!homeEl) return;
    const active = document.querySelector(".p-tab_rail__button--active[data-qa]")?.getAttribute("data-qa");
    for (const b of homeEl.querySelectorAll(".nav > button")) {
      const tab = b.dataset.tab || (b.dataset.act === "channels" ? "tab_rail_home_button" : null);
      const on = homeOpen ? b.dataset.act === "dash" : !!active && tab === active;
      b.classList.toggle("on", on);
      // copy slack's unread count (or unread dot) from the matching rail tab
      const rail = tab && document.querySelector(`[data-qa="${tab}"]`);
      const badge = rail?.querySelector(".c-badge, .p-unread_dot");
      // only real counts; slack's plain unread dot (on home/channels) is left out
      const value = badge?.textContent.trim() || null;
      if (value === null) b.removeAttribute("data-badge");
      else if (b.getAttribute("data-badge") !== value) b.setAttribute("data-badge", value);
    }
  }

  // slack's left rail, marked so dash mode can hide it
  function markRail() {
    let el = document.querySelector(".p-tab_rail__tab_menu");
    while (el?.parentElement && el.parentElement.getBoundingClientRect().width < 160 && el.parentElement !== document.body) el = el.parentElement;
    if (el && !el.hasAttribute("data-sdd-rail")) el.setAttribute("data-sdd-rail", "");
  }

  // picking any other rail tab, the search bar or a workspace leaves the dash
  function onLeaveHome(e) {
    if (!homeOpen || e.target.closest("#sdd-home, #sdd-dash-holder, #sdd-panel, #sdd-rail-holder")) return;
    if (e.target.closest(".p-tab_rail__tab_menu, .p-ia4_top_nav, [data-qa='account_switcher_team_icon']")) closeHome();
  }
  document.addEventListener("click", onLeaveHome, true);
  // clicking anywhere else closes the spaces menu
  const closeSpaces = (e) => {
    const m = document.getElementById("sdd-spaces-menu");
    if (m && !e.target.closest("#sdd-spaces-menu, [data-act='spaces']")) m.hidden = true;
  };
  document.addEventListener("click", closeSpaces, true);
  window.addEventListener("resize", placeHome);

  // called on theme changes and every tick: keeps the button and page in step
  function mountFx() {
    mountDash();
    if (settings.theme === "valorant") updateVideoAccent();
    pollApp();
    tuneVideoQuality();
    markRail();
    document.body.classList.toggle("sdd-dashmode", dashMode());
    document.body.classList.toggle("sdd-novideo", homeEnabled() && !!settings.hideVideo);
    document.body.classList.toggle("sdd-nomedia", homeEnabled() && !!settings.hideMediaBar);
    if (!homeEnabled()) destroyHome();
    else if (dashMode() && !homeEl) openHome();
    else if (homeOpen) {
      if (location.pathname !== homeRoute) closeHome();
      else placeHome();
    } else if (homeEl) {
      if (!dashMode() && homeEl.classList.contains("bg")) closeHome();
      placeHome();
    }
    markNav();
  }
  cleanups.push(() => {
    destroyHome();
    document.body.classList.remove("sdd-dashmode", "sdd-novideo", "sdd-nomedia");
    document.querySelectorAll("[data-sdd-rail]").forEach((el) => el.removeAttribute("data-sdd-rail"));
    dashEl?.remove();
    document.removeEventListener("click", onLeaveHome, true);
    document.removeEventListener("click", closeSpaces, true);
    window.removeEventListener("resize", placeHome);
    themeStyle?.remove();
    document.body.classList.remove(...Object.keys(THEMES).map((t) => `sdd-${t}`));
  });

  // ---------------------------------------------------------------- panel

  const PANEL_CSS = `
    [data-sdd-hide] { display: none !important; }
    [data-sdd-noscroll] .c-scrollbar__track, [data-sdd-noscroll] .c-scrollbar__bar { display: none !important; }
    [data-sdd-quiet] .p-channel_sidebar__section_heading,
    [data-sdd-quiet] .p-channel_sidebar__section_heading *,
    [data-sdd-quiet] [class*="sectionHeadingLabelUnreads"],
    [data-sdd-quiet] [class*="sectionHeadingLabelUnreads"] * {
      color: var(--sdd-read-color, inherit) !important; font-weight: var(--sdd-read-weight, inherit) !important;
    }
    [data-sdd-group] [data-qa^="channel_sidebar__section_heading_label"] { cursor: pointer; }
    [data-sdd-group] [data-qa^="section_heading_toggle_and_label"]::after {
      content: "▾"; flex: none; align-self: center; margin-left: 6px; opacity: .55; font-size: 11px; line-height: 1; transition: transform .15s;
    }
    [data-sdd-group="folded"] [data-qa^="section_heading_toggle_and_label"]::after { transform: rotate(-90deg); }
    #sdd-fab {
      position: fixed; left: 10px; bottom: 90px; z-index: 9999; width: 34px; height: 34px; border-radius: 10px; border: 0;
      background: rgba(127,127,127,.25); color: inherit; cursor: pointer; display: grid; place-items: center;
      backdrop-filter: blur(6px); opacity: .7; transition: opacity .15s, transform .15s;
    }
    #sdd-fab:hover { opacity: 1; transform: scale(1.06); }
    #sdd-panel {
      --bg: #1c1e22; --bg2: #25282d; --fg: #eceef1; --fg2: #a3a7ae; --line: #33373d; --acc: #7aa7ff; --accfg: #fff; --hov: #2c3036;
      position: fixed; top: 0; right: 0; bottom: 0; width: 390px; max-width: 100vw; z-index: 10000; background: var(--bg); color: var(--fg);
      box-shadow: -12px 0 40px rgba(0,0,0,.35); display: flex; flex-direction: column;
      font: 14px/1.4 system-ui, "Segoe UI", sans-serif; transform: translateX(105%); transition: transform .2s ease;
    }
    #sdd-panel.open { transform: none; }
    #sdd-panel * { box-sizing: border-box; font-family: inherit !important; }
    #sdd-panel header { padding: 16px 18px 10px; display: flex; align-items: center; gap: 8px; }
    #sdd-panel header h2 { margin: 0; font-size: 17px; font-weight: 700; flex: 1; color: var(--fg); }
    #sdd-panel button { font: inherit; color: inherit; cursor: pointer; }
    #sdd-panel .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--fg2); padding: 6px 18px; }
    #sdd-panel .themes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 2px 18px 10px; }
    #sdd-panel .theme { border: 2px solid var(--line); background: var(--bg2); border-radius: 10px; padding: 8px; text-align: left; font-size: 12px; color: var(--fg); }
    #sdd-panel .theme.on { border-color: var(--acc); }
    #sdd-panel .theme .sw { display: flex; gap: 3px; margin-bottom: 6px; }
    #sdd-panel .theme .sw i { flex: 1; height: 16px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(127,127,127,.3); }
    #sdd-panel .colors { padding: 0 18px 10px; display: flex; flex-direction: column; gap: 8px; }
    #sdd-panel .colors[hidden] { display: none; }
    #sdd-panel .presets { display: flex; flex-wrap: wrap; gap: 6px; }
    #sdd-panel .preset { display: flex; align-items: center; gap: 6px; padding: 4px 9px 4px 5px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg2); font-size: 12px; }
    #sdd-panel .preset i { width: 14px; height: 14px; border-radius: 50%; }
    #sdd-panel .picks { display: grid; grid-template-columns: repeat(4, 1fr) auto; gap: 6px; align-items: end; }
    #sdd-panel .picks label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--fg2); }
    #sdd-panel .picks input { width: 100%; height: 28px; padding: 0; border: 1px solid var(--line); border-radius: 6px; background: none; cursor: pointer; }
    #sdd-panel .tools { display: flex; gap: 6px; padding: 4px 18px 10px; }
    #sdd-panel input[type=search] { flex: 1; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); outline: none; }
    #sdd-panel input[type=search]:focus { border-color: var(--acc); }
    #sdd-panel .btn { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg2); font-size: 12px; white-space: nowrap; color: var(--fg); }
    #sdd-panel .btn:hover { background: var(--hov); }
    #sdd-panel .list { flex: 1; overflow-y: auto; padding: 0 10px 20px; border-top: 1px solid var(--line); }
    #sdd-panel .status { padding: 18px 8px; color: var(--fg2); }
    #sdd-panel .sec { border-bottom: 1px solid var(--line); }
    #sdd-panel .grp > .grp-body > .sec:last-child { border-bottom: 0; }
    #sdd-panel .row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; cursor: pointer; user-select: none; }
    #sdd-panel .row:hover { background: var(--hov); }
    #sdd-panel .row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #sdd-panel .sec > .row .name { font-weight: 600; }
    #sdd-panel .row .count { color: var(--fg2); font-size: 12px; }
    #sdd-panel .caret { width: 20px; text-align: center; color: var(--fg2); transition: transform .15s; border: 0; background: none; padding: 0; flex: none; }
    #sdd-panel .expanded > .row .caret, #sdd-panel .grp.open > .row .caret { transform: rotate(90deg); }
    #sdd-panel .chans { display: none; padding: 0 0 6px 26px; }
    #sdd-panel .sec.expanded .chans { display: block; }
    #sdd-panel .chans .row { padding: 4px 8px; font-size: 13px; }
    #sdd-panel .chans .icon { width: 14px; color: var(--fg2); text-align: center; }
    #sdd-panel .grp { margin-top: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg2); }
    #sdd-panel .grp > .row .name { font-weight: 700; text-transform: uppercase; letter-spacing: .05em; font-size: 12px; }
    #sdd-panel .grp-body { display: none; padding: 0 6px 4px 18px; }
    #sdd-panel .grp.open > .grp-body { display: block; }
    #sdd-panel .fold { font-size: 11px; color: var(--fg2); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; background: none; }
    #sdd-panel .fold.on { color: var(--accfg); background: var(--acc); border-color: var(--acc); }
    #sdd-panel .off > .name { color: var(--fg2); text-decoration: line-through; }
    #sdd-panel input[type=checkbox] { width: 16px; height: 16px; margin: 0; accent-color: var(--acc); cursor: pointer; flex: none; }
    #sdd-panel .vid { display: flex; flex-direction: column; gap: 4px; }
    #sdd-panel .vid label { font-size: 11px; color: var(--fg2); }
    #sdd-panel .vid-row { display: flex; gap: 6px; }
    #sdd-panel .vid input {
      flex: 1; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); outline: none; font-size: 12px;
    }
    #sdd-panel .vid input:focus { border-color: var(--acc); }
    #sdd-panel .vid-note { font-size: 11px; color: var(--fg2); min-height: 14px; }
    #sdd-panel details.ui { padding: 0 0 8px; }
    #sdd-panel details.ui summary { cursor: pointer; list-style: none; user-select: none; }
    #sdd-panel details.ui summary::before { content: "›"; display: inline-block; width: 12px; transition: transform .15s; }
    #sdd-panel details.ui[open] summary::before { transform: rotate(90deg); }
    #sdd-panel details.ui .hint { text-transform: none; letter-spacing: 0; font-weight: 400; }
    #sdd-panel .ui-groups { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 10px; padding: 2px 18px 6px; }
    #sdd-panel .ui-title { font-size: 11px; color: var(--fg2); margin: 4px 0; font-weight: 600; }
    #sdd-panel .ui-item { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 0; cursor: pointer; }
    #sdd-panel .ui-item.off .name { color: var(--fg2); text-decoration: line-through; }
    #sdd-panel footer { padding: 10px 18px; border-top: 1px solid var(--line); color: var(--fg2); font-size: 12px; }
  `;

  let panelEl = null;
  let fabEl = null;
  let baseStyle = null;
  let query = "";
  const expanded = new Set();
  const openGroups = new Set();

  // the panel picks up the current theme's colours
  function stylePanel() {
    if (!panelEl) return;
    const name = settings.theme;
    if (!THEMES[name]?.base) {
      const dark = document.body.classList.contains("sk-client-theme--dark");
      const vars = dark
        ? { bg: "#1c1e22", bg2: "#25282d", fg: "#eceef1", fg2: "#a3a7ae", line: "#33373d", acc: "#7aa7ff", accfg: "#ffffff", hov: "#2c3036" }
        : { bg: "#ffffff", bg2: "#f4f6f8", fg: "#1f2328", fg2: "#626a73", line: "#e3e6ea", acc: "#0b57d0", accfg: "#ffffff", hov: "#eef1f4" };
      for (const [k, v] of Object.entries(vars)) panelEl.style.setProperty(`--${k}`, v);
    } else {
      const p = palette(baseFor(name));
      const vars = { bg: p.side, bg2: p.bg, fg: p.sideFg, fg2: p.sideFg2, line: mix(p.side, p.sideFg, 0.14), acc: p.accent, accfg: p.accentFg, hov: p.sideHover };
      for (const [k, v] of Object.entries(vars)) panelEl.style.setProperty(`--${k}`, v);
    }
    panelEl.style.fontFamily = name === "valorant" ? 'Bahnschrift, "DIN Next", sans-serif' : name === "docs" ? "Arial, Helvetica, sans-serif" : "";
  }

  const EYE_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.3"/><path d="M3.5 16.5l13-13"/></svg>`;

  // a copy of slack's own "More" rail button, so ours match whatever theme is on.
  // it goes right after "more"; returns null if the rail isn't there.
  function cloneRailButton(id, label, title, icon, onClick) {
    // not every workspace has "more" (cal hacks has "agents & tools" instead), so fall
    // back to the last of slack's own rail tabs
    const menu = document.querySelector(".p-tab_rail__tab_menu");
    if (!menu) return null;
    const tabs = [...menu.querySelectorAll("button.p-tab_rail__button")].filter((b) => !b.closest("[id^='sdd-']"));
    const more = document.querySelector('[data-qa="tab_rail_browse_button"]') || tabs.at(-1);
    if (!more) return null;
    let anchor = more;
    while (anchor.parentElement && anchor.parentElement !== menu) anchor = anchor.parentElement;
    if (anchor.parentElement !== menu) return null;
    const btn = more.cloneNode(true);
    btn.removeAttribute("data-qa");
    btn.removeAttribute("aria-describedby");
    btn.classList.remove("p-tab_rail__button--active");
    btn.setAttribute("aria-label", title);
    btn.title = title;
    // drop unread badges and keyboard-shortcut hints copied from the original
    btn.querySelectorAll("[class*='badge'], [data-qa='tab_rail_shortcut_hint'], [class*='shortcut']").forEach((el) => el.remove());
    btn.querySelectorAll("[data-qa]").forEach((el) => el.removeAttribute("data-qa"));
    const svgs = btn.querySelectorAll("svg");
    svgs.forEach((s, i) => (i ? s.remove() : (s.outerHTML = icon)));
    const labelEl = btn.querySelector(".p-tab_rail__button__label");
    if (labelEl) labelEl.textContent = label;
    else {
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      for (let n, done = false; (n = walker.nextNode()); ) if (n.nodeValue.trim()) (n.nodeValue = done ? "" : label), (done = true);
    }
    const holder = document.createElement("div");
    holder.id = id;
    holder.appendChild(btn);
    anchor.after(holder);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return holder;
  }

  // falls back to a small corner button if the rail isn't there
  function mountRailButton() {
    if (fabEl?.isConnected && (fabEl.id === "sdd-rail-holder" || !document.querySelector(".p-tab_rail__tab_menu"))) return;
    fabEl?.remove();
    const holder = cloneRailButton("sdd-rail-holder", "Sidebar", "Sidebar & themes (Ctrl+Alt+H)", EYE_ICON, () => togglePanel());
    if (holder) {
      // keep dash (if it's there) ahead of us
      document.getElementById("sdd-dash-holder")?.after(holder);
      fabEl = holder;
    } else {
      fabEl = h(`<button id="sdd-fab" title="Sidebar & themes (Ctrl+Alt+H)">${EYE_ICON}</button>`);
      fabEl.addEventListener("click", () => togglePanel());
      document.body.appendChild(fabEl);
    }
  }

  function buildPanel() {
    baseStyle = document.createElement("style");
    baseStyle.id = "sdd-base";
    baseStyle.textContent = PANEL_CSS;
    document.head.appendChild(baseStyle);

    mountRailButton();

    panelEl = h(`<aside id="sdd-panel" aria-label="stop dont do">
      <header><h2>Sidebar & themes</h2></header>
      <div class="label">Theme</div>
      <div class="themes"></div>
      <div class="colors"></div>
      <details class="ui">
        <summary class="label">Slack buttons <span class="hint"></span></summary>
        <div class="ui-groups"></div>
      </details>
      <div class="label">Sections</div>
      <div class="tools">
        <input type="search" placeholder="Filter sections and channels">
        <button class="btn" data-act="all">Show all</button>
        <button class="btn" data-act="refresh" title="Reload from Slack">↻</button>
      </div>
      <div class="list"><div class="status">Loading…</div></div>
      <footer>Ticked = shown in your sidebar. Click a ── divider in your sidebar to fold its group. Ctrl+Alt+H opens this.</footer>
    </aside>`);
    document.body.appendChild(panelEl);

    panelEl.querySelector("input[type=search]").addEventListener("input", (e) => {
      query = e.target.value.trim().toLowerCase();
      renderList();
    });
    panelEl.querySelector('[data-act="all"]').addEventListener("click", () => {
      const data = currentData();
      if (!data) return;
      for (const s of data.sections) {
        delete settings.hiddenSections[s.id];
        delete settings.foldedGroups[s.id];
        s.channels.forEach((c) => delete settings.hiddenChannels[c]);
      }
      changed();
    });
    panelEl.querySelector('[data-act="refresh"]').addEventListener("click", () => refreshList(true));
    panelEl.querySelector(".list").addEventListener("click", onListClick);
    panelEl.querySelector(".ui-groups").addEventListener("change", (e) => {
      const key = e.target.dataset.ui;
      if (!key) return;
      e.target.checked ? delete settings.hiddenUi[key] : (settings.hiddenUi[key] = true);
      save();
      applyUi();
      updateHideCss();
      layoutSidebar();
      renderUi();
    });

    renderThemes();
    renderUi();
  }

  function renderUi() {
    const hiddenCount = UI_ITEMS.filter((i) => settings.hiddenUi[i.key]).length;
    panelEl.querySelector(".ui .hint").textContent = hiddenCount ? `· ${hiddenCount} hidden` : "";
    panelEl.querySelector(".ui-groups").innerHTML = UI_GROUPS.map(
      (g) => `<div class="ui-group"><div class="ui-title">${esc(g.label)}</div>${g.items
        .map(
          (i) => `<label class="ui-item ${settings.hiddenUi[i.key] ? "off" : ""}">
            <input type="checkbox" data-ui="${i.key}" ${settings.hiddenUi[i.key] ? "" : "checked"}><span class="name">${esc(i.label)}</span></label>`,
        )
        .join("")}</div>`,
    ).join("");
  }

  function onListClick(e) {
    const row = e.target.closest(".row");
    if (!row) return;
    const data = currentData();

    if (e.target.closest(".fold")) {
      const id = row.dataset.group;
      settings.foldedGroups[id] ? delete settings.foldedGroups[id] : (settings.foldedGroups[id] = true);
      return changed();
    }
    if (e.target.closest(".caret")) {
      const box = row.parentElement;
      const set = box.classList.contains("grp") ? openGroups : expanded;
      const cls = box.classList.contains("grp") ? "open" : "expanded";
      box.classList.toggle(cls);
      box.classList.contains(cls) ? set.add(box.dataset.id) : set.delete(box.dataset.id);
      return;
    }

    const box = row.querySelector("input[type=checkbox]");
    if (!box || box.disabled) return;
    if (e.target !== box) box.checked = !box.checked;
    if (row.dataset.group) {
      // the group checkbox flips the divider and every section under it
      const ids = [row.dataset.group, ...data.sections.filter((s) => data.groupOf[s.id] === row.dataset.group).map((s) => s.id)];
      for (const id of ids) {
        box.checked ? delete settings.hiddenSections[id] : (settings.hiddenSections[id] = true);
        collapseTried.delete(id);
      }
    } else if (row.dataset.sec) {
      box.checked ? delete settings.hiddenSections[row.dataset.sec] : (settings.hiddenSections[row.dataset.sec] = true);
      collapseTried.delete(row.dataset.sec);
    } else if (row.dataset.ch) {
      box.checked ? delete settings.hiddenChannels[row.dataset.ch] : (settings.hiddenChannels[row.dataset.ch] = true);
    }
    changed();
  }

  function renderThemes() {
    const wrap = panelEl.querySelector(".themes");
    wrap.innerHTML = Object.entries(THEMES)
      .map(([k, t]) => {
        const b = t.base ? baseFor(k) : { side: "#4a154b", bg: "#1a1d21", accent: "#1264a3", fg: "#ffffff" };
        return `<button class="theme ${settings.theme === k ? "on" : ""}" data-theme="${k}">
          <div class="sw">${[b.side, b.bg, b.accent, b.fg].map((c) => `<i style="background:${c}"></i>`).join("")}</div>${esc(t.label)}</button>`;
      })
      .join("");
    wrap.querySelectorAll(".theme").forEach((b) =>
      b.addEventListener("click", () => {
        settings.theme = b.dataset.theme;
        save();
        applyTheme();
        renderThemes();
      }),
    );
    renderColors();
  }

  function renderColors() {
    const wrap = panelEl.querySelector(".colors");
    const name = settings.theme;
    const t = THEMES[name];
    wrap.hidden = !t?.base;
    if (!t?.base) return (wrap.innerHTML = "");
    const b = baseFor(name);
    const presets = t.presets
      ? `<div class="presets">${Object.entries(t.presets)
          .map(([n, p]) => `<button class="preset" data-preset="${esc(n)}"><i style="background:${p.accent}"></i>${esc(n)}</button>`)
          .join("")}</div>`
      : "";
    const field = (k, label) => `<label>${label}<input type="color" data-k="${k}" value="${b[k]}"></label>`;
    const video =
      name === "valorant"
        ? `<label class="ui-item"><input type="checkbox" data-act="home" ${settings.home ? "checked" : ""}><span class="name">Dash button in the left rail</span></label>
          <label class="ui-item"><input type="checkbox" data-act="dashmode" ${settings.dashMode ? "checked" : ""}><span class="name">Run Slack from Dash (no rail or channel list)</span></label>
          <label class="ui-item"><input type="checkbox" data-act="nomedia" ${settings.hideMediaBar ? "checked" : ""}><span class="name">Hide the music bar (play, seek, volume)</span></label>
          <label class="ui-item"><input type="checkbox" data-act="novideo" ${settings.hideVideo ? "checked" : ""}><span class="name">Hide the video (keeps its sound)</span></label>
          <label class="ui-item"><input type="checkbox" data-act="vidaccent" ${settings.videoAccent ? "checked" : ""}><span class="name">Match accent to the Dash video${settings.videoAccent && videoAccent.color ? ` <i style="display:inline-block;width:10px;height:10px;background:${videoAccent.color};vertical-align:middle"></i>` : ""}</span></label>
          <div class="vid">
            <label for="sdd-dash-video">Dash video</label>
            <div class="vid-row">
              <input id="sdd-dash-video" type="url" placeholder="YouTube or video link (blank = Hush trailer)" value="${esc(settings.dashVideo || "")}">
              <button class="btn" data-act="video-save">Set</button>
            </div>
            <div class="vid-note"></div>
          </div>
          <div class="vid">
            <label for="sdd-spotify-link">Spotify instead of the video's sound</label>
            <div class="vid-row">
              <input id="sdd-spotify-link" type="url" placeholder="Spotify playlist, album or song link (blank = off)" value="${esc(settings.spotify || "")}">
              <button class="btn" data-act="spotify-save">Set</button>
            </div>
            <div class="sp-note vid-note"></div>
            <label class="ui-item"><input type="checkbox" data-act="spapp" ${settings.spotifyApp ? "checked" : ""}><span class="name">Follow the music playing on this computer (Spotify app or anything else, full songs; a Spotify link opens in the app)</span></label>
          </div>`
        : "";
    wrap.innerHTML = `${presets}${video}<div class="picks">${field("bg", "Background")}${field("side", "Sidebar")}${field("fg", "Text")}${field("accent", "Accent")}
      <button class="btn" data-act="reset" title="Back to this theme's colours">Reset</button></div>`;

    let pending = 0;
    wrap.querySelectorAll("input[type=color]").forEach((inp) =>
      inp.addEventListener("input", () => {
        settings.colors[name] = { ...settings.colors[name], [inp.dataset.k]: inp.value };
        save();
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => {
          applyTheme();
          panelEl.querySelectorAll(`.theme[data-theme="${name}"] .sw i`).forEach((i, n) => {
            const nb = baseFor(name);
            i.style.background = [nb.side, nb.bg, nb.accent, nb.fg][n];
          });
        });
      }),
    );
    wrap.querySelectorAll(".preset").forEach((btn) =>
      btn.addEventListener("click", () => {
        settings.colors[name] = { ...t.presets[btn.dataset.preset] };
        save();
        applyTheme();
        renderThemes();
      }),
    );
    const vidInput = wrap.querySelector("#sdd-dash-video");
    const setVideo = () => {
      const url = vidInput.value.trim();
      const note = wrap.querySelector(".vid-note");
      if (url && !validVideoLink(url)) {
        note.textContent = "That doesn't look like a YouTube or video link.";
        return;
      }
      settings.dashVideo = url || undefined;
      save();
      note.textContent = url ? (youtubeId(url) ? "Set. Dash will loop that YouTube video." : "Set. Dash will loop that video file.") : "Back to the Hush trailer.";
      const wasOpen = homeOpen;
      destroyHome();
      if (wasOpen) openHome();
    };
    wrap.querySelector('[data-act="video-save"]')?.addEventListener("click", setVideo);
    const spInput = wrap.querySelector("#sdd-spotify-link");
    const setSpotify = () => {
      const url = spInput.value.trim();
      const note = wrap.querySelector(".sp-note");
      if (url && !spotifyEmbed(url)) return (note.textContent = "That doesn't look like a Spotify playlist, album or song link.");
      settings.spotify = url || undefined;
      save();
      if (url && useApp()) appCmd("open", { uri: spotifyUri(url) });
      note.textContent = url ? "Set. Press play in the Dash bar; back/forward now skip songs." : "Back to the video's own sound.";
      const wasOpen = homeOpen;
      destroyHome();
      if (wasOpen || dashMode()) openHome();
      if (!wasOpen && dashMode()) closeHome();
    };
    wrap.querySelector('[data-act="spotify-save"]')?.addEventListener("click", setSpotify);
    wrap.querySelector('[data-act="spapp"]')?.addEventListener("change", (e) => {
      settings.spotifyApp = e.target.checked;
      save();
      if (settings.spotifyApp && spotifyUri(settings.spotify)) appCmd("open", { uri: spotifyUri(settings.spotify) });
      const wasOpen = homeOpen;
      destroyHome();
      if (wasOpen || dashMode()) openHome();
      if (!wasOpen && dashMode()) closeHome();
    });
    spInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") setSpotify();
      e.stopPropagation();
    });
    vidInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") setVideo();
      e.stopPropagation();
    });
    wrap.querySelector('[data-act="nomedia"]')?.addEventListener("change", (e) => {
      settings.hideMediaBar = e.target.checked;
      save();
      mountFx();
    });
    wrap.querySelector('[data-act="novideo"]')?.addEventListener("change", (e) => {
      settings.hideVideo = e.target.checked;
      save();
      mountFx();
    });
    wrap.querySelector('[data-act="vidaccent"]')?.addEventListener("change", (e) => {
      settings.videoAccent = e.target.checked;
      save();
      videoAccent.id = null;
      if (!settings.videoAccent) videoAccent.color = null;
      if (settings.videoAccent) updateVideoAccent();
      else {
        applyTheme();
        renderThemes();
      }
    });
    wrap.querySelector('[data-act="dashmode"]')?.addEventListener("change", (e) => {
      settings.dashMode = e.target.checked;
      save();
      mountFx();
      layoutSidebar();
    });
    wrap.querySelector('[data-act="home"]')?.addEventListener("change", (e) => {
      settings.home = e.target.checked;
      save();
      mountFx();
    });
    wrap.querySelector('[data-act="reset"]').addEventListener("click", () => {
      delete settings.colors[name];
      save();
      applyTheme();
      renderThemes();
    });
  }

  function changed() {
    save();
    renderList();
    updateHideCss();
    layoutSidebar();
  }

  async function refreshList(force) {
    const list = panelEl.querySelector(".list");
    if (!currentData()?.sections) list.innerHTML = `<div class="status">Loading your sections…</div>`;
    try {
      await loadSections(true);
      renderList();
      if (force) for (const k of Object.keys(currentData().names)) delete currentData().names[k];
      await loadNames();
      renderList();
    } catch (e) {
      list.innerHTML = `<div class="status">Couldn't load sections: ${esc(e.message)}</div>`;
    }
  }

  const ICONS = { channel: "#", private: "🔒", dm: "@", group: "👥" };

  function sectionHtml(s, data, q) {
    const chans = s.channels.map((c) => ({ id: c, ...(data.names[c] || { kind: "channel", label: "…" }) }));
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
  }

  function renderList() {
    const data = currentData();
    if (!data?.sections || !panelEl) return;
    const list = panelEl.querySelector(".list");
    const top = list.scrollTop;
    const q = query;

    // split into: loose sections, then one block per divider
    const blocks = [];
    for (const s of data.sections) {
      if (s.divider) blocks.push({ divider: s, sections: [] });
      else if (data.groupOf[s.id]) blocks.at(-1).sections.push(s);
      else blocks.push({ loose: s });
    }

    const html = blocks
      .map((b) => {
        if (b.loose) return sectionHtml(b.loose, data, q);
        const d = b.divider;
        const label = groupLabel(d.name);
        const inner = b.sections.map((s) => sectionHtml(s, data, q)).join("");
        const groupMatch = !q || label.toLowerCase().includes(q);
        if (!groupMatch && !inner) return "";
        const ids = [d.id, ...b.sections.map((s) => s.id)];
        const shownCount = ids.filter((id) => !settings.hiddenSections[id]).length;
        const state = shownCount === ids.length ? "checked" : "";
        const partial = shownCount && shownCount < ids.length ? 1 : "";
        const open = openGroups.has(d.id) || !!q;
        const folded = !!settings.foldedGroups[d.id];
        return `<div class="grp ${open ? "open" : ""}" data-id="${esc(d.id)}">
          <div class="row ${shownCount ? "" : "off"}" data-group="${esc(d.id)}">
            <input type="checkbox" ${state} data-partial="${partial}">
            <span class="name" title="${esc(d.name)}">${esc(label)}</span>
            <button class="fold ${folded ? "on" : ""}" title="Fold this group in your sidebar (same as clicking the divider there)">${folded ? "folded" : "fold"}</button>
            <span class="count">${b.sections.length}</span>
            ${b.sections.length ? `<button class="caret" title="Show sections">›</button>` : `<span class="caret"></span>`}
          </div>
          <div class="grp-body">${inner}</div>
        </div>`;
      })
      .join("");
    list.innerHTML = html || `<div class="status">Nothing matches.</div>`;
    list.querySelectorAll('[data-partial="1"]').forEach((b) => (b.indeterminate = true));
    list.scrollTop = top;
  }

  function togglePanel(force) {
    const open = force ?? !panelEl.classList.contains("open");
    // open below the dash bar when it's showing, so its Sidebar button (the way to close
    // this) never ends up underneath the panel
    const nav = homeEl?.querySelector(".nav");
    const barShown = nav && (homeOpen || homeEl.classList.contains("bg")) && homeEl.style.visibility !== "hidden";
    panelEl.style.top = barShown ? `${Math.round(nav.getBoundingClientRect().bottom)}px` : "";
    panelEl.classList.toggle("open", open);
    // the rail button shows as active while the panel is open, since it's also how you close it
    fabEl?.querySelector("button")?.classList.toggle("p-tab_rail__button--active", open);
    fabEl?.toggleAttribute("data-open", open);
    if (open) {
      stylePanel();
      refreshList(false);
    }
  }

  function onKey(e) {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      togglePanel();
    } else if (e.key === "Escape" && homeOpen && !panelEl?.classList.contains("open")) {
      closeHome();
    } else if (e.key === "Escape" && panelEl?.classList.contains("open")) {
      togglePanel(false);
    }
  }

  // ---------------------------------------------------------------- boot

  function init() {
    buildPanel();
    applyTheme();
    applyUi();
    updateHideCss();
    markPanes();
    layoutSidebar();
    mountObserver.observe(document.body, { childList: true, subtree: true });
    loadSections(false).then(() => (updateHideCss(), scheduleLayout()), () => {});
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onSidebarClick, true);
    // slack swaps the sidebar out when switching workspaces; re-check now and then
    let lastWs = location.pathname.split("/")[2];
    const timer = setInterval(() => {
      const list = document.querySelector(".p-channel_sidebar__list .c-virtual_list__scroll_container");
      if (list !== observedList) layoutSidebar();
      mountRailButton();
      markUi();
      mountFx();
      if (!document.getElementById("sdd-theme") && THEMES[settings.theme]?.base) applyTheme();
      const ws = location.pathname.split("/")[2];
      if (ws !== lastWs) {
        lastWs = ws;
        loadSections(false).then(() => (updateHideCss(), scheduleLayout()), () => {});
        if (panelEl.classList.contains("open")) refreshList(false);
      }
    }, 800);
    cleanups.push(() => {
      clearInterval(timer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onSidebarClick, true);
      for (const a of ["data-sdd-hide", "data-sdd-quiet", "data-sdd-group"]) document.querySelectorAll(`[${a}]`).forEach((el) => el.removeAttribute(a));
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
