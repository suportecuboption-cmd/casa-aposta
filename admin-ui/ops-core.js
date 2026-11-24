/* ══════════════ Operação — kit compartilhado (barra de ferramentas, filtros, gráfico, tabela, modal) ══════════════
   Usa os utilitários do script principal via window.CA (api, escA, money…). Cada tela registra sua view em CA.registerViews. */
(function () {
  "use strict";
  const CA = window.CA;
  const esc = CA.escA;
  const money = CA.money;
  const num2 = CA.num2;
  const int = CA.int;

  /* ── seletores curtos dentro da área de conteúdo ── */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  CA.$ = $; CA.$$ = $$;
  CA.render = (html) => { CA.view().innerHTML = html; };

  /* ── datas (fuso São Paulo) ── */
  const ymdSP = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const todaySP = () => ymdSP(new Date());
  const shift = (ymd, days) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return ymdSP(d); };
  const monthFirst = (ymd) => ymd.slice(0, 8) + "01";
  const dmy = CA.dmy;
  CA.ymdSP = ymdSP; CA.todaySP = todaySP; CA.shift = shift;

  const dtSP = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  const dtFull = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "long", year: "numeric" });
  CA.fdt = (iso) => (iso ? dtSP.format(new Date(iso)).replace(",", "") : "—");
  CA.fdate = (iso) => (iso ? dtFull.format(new Date(iso)) : "—");
  CA.rel = (iso) => {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "agora";
    if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
    if (s < 86400) return `${Math.floor(s / 3600)}h atrás`;
    if (s < 2592000) return `${Math.floor(s / 86400)}d atrás`;
    return CA.fdate(iso);
  };

  /* ── intervalo de datas padrão: últimos 30 dias ── */
  CA.defaultRange = () => ({ preset: "30d", from: shift(todaySP(), -29), to: todaySP() });
  const PRESETS = [
    ["today", "Hoje"], ["yesterday", "Ontem"], ["7d", "7 dias"],
    ["30d", "30 dias"], ["month", "Este mês"], ["custom", "Personalizado"],
  ];
  function applyPreset(st, p) {
    const t = todaySP();
    st.preset = p;
    if (p === "today") { st.from = t; st.to = t; }
    else if (p === "yesterday") { st.from = shift(t, -1); st.to = shift(t, -1); }
    else if (p === "7d") { st.from = shift(t, -6); st.to = t; }
    else if (p === "30d") { st.from = shift(t, -29); st.to = t; }
    else if (p === "month") { st.from = monthFirst(t), st.to = t; }
  }
  CA.rangeLabel = (st) => (PRESETS.find((p) => p[0] === st.preset) || [])[1] || `${dmy(st.from)} – ${dmy(st.to)}`;

  /* botão + popover de intervalo de datas. onApply() é chamado quando muda. */
  CA.rangeBtn = (st, onApply) => `<div class="op-pop-wrap" data-range>
      <button type="button" class="op-btn" data-range-btn>${ICON.cal}<span data-range-lbl>${esc(CA.rangeLabel(st))}</span></button>
      <div class="op-pop" data-range-pop hidden>
        <div class="presets">${PRESETS.map((p) => `<button type="button" data-preset="${p[0]}" class="${st.preset === p[0] ? "on" : ""}">${p[1]}</button>`).join("")}</div>
        <label>De</label><input type="date" data-range-from value="${st.from}" />
        <label>Até</label><input type="date" data-range-to value="${st.to}" />
        <div class="pop-actions"><button type="button" class="op-btn sm" data-range-cancel>Fechar</button><button type="button" class="op-btn sm green" data-range-apply>Aplicar</button></div>
      </div></div>`;
  CA.wireRange = (root, st, onApply) => {
    const wrap = $("[data-range]", root); if (!wrap) return;
    const pop = $("[data-range-pop]", wrap);
    const close = () => { pop.hidden = true; };
    $("[data-range-btn]", wrap).onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; };
    $$("[data-preset]", wrap).forEach((b) => (b.onclick = () => {
      $$("[data-preset]", wrap).forEach((x) => x.classList.toggle("on", x === b));
      const p = b.dataset.preset;
      if (p === "custom") { st.preset = "custom"; return; }
      applyPreset(st, p);
      $("[data-range-from]", wrap).value = st.from; $("[data-range-to]", wrap).value = st.to;
    }));
    $("[data-range-cancel]", wrap).onclick = close;
    $("[data-range-apply]", wrap).onclick = () => {
      st.from = $("[data-range-from]", wrap).value || st.from;
      st.to = $("[data-range-to]", wrap).value || st.to;
      if ($("[data-range-from]", wrap).value && $("[data-range-to]", wrap).value &&
          !PRESETS.some((p) => p[0] !== "custom" && isPreset(st, p[0]))) st.preset = "custom";
      close(); onApply();
    };
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); }, { once: true });
  };
  const isPreset = (st, p) => { const c = { ...st }; applyPreset(c, p); return c.from === st.from && c.to === st.to; };

  /* ── ícones de apoio ── */
  const I = (p, fill) => CA.svgI(p, fill);
  const ICON = {
    cal: I('<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>'),
    filter: I('<path d="M3 5h18l-7 8v6l-4-2v-4z"/>'),
    download: I('<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/>'),
    refresh: I('<path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v4h-4"/>'),
    dot3: I('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
    copy: I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
    check: I('<path d="M20 6 9 17l-5-5"/>'),
    x: I('<path d="M18 6 6 18M6 6l12 12"/>'),
    ext: I('<path d="M14 4h6v6M20 4l-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>'),
    person: I('<circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.3-3.5 4-5 7.5-5s6.2 1.5 7.5 5"/>'),
    inbox: I('<path d="M3 13l2.5-7.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>'),
    arrowDown: I('<path d="M12 4v14m0 0 5-5m-5 5-5-5"/>'),
    arrowUp: I('<path d="M12 20V6m0 0 5 5M12 6 7 11"/>'),
    coins: I('<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 12.9V18c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.3-1.5-2.4-3.8-2.8"/>'),
    doc: I('<path d="M6 2.5h8l5 5V21a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 21V4A1.5 1.5 0 0 1 6 2.5z"/><path d="M14 2.5V8h5"/>'),
    warn: I('<path d="M12 3 1.5 21h21z"/><path d="M12 10v4M12 17.5v.5" stroke-width="2.2"/>'),
    shield: I('<path d="M12 3l8 3v6c0 4.5-3.4 8.1-8 9-4.6-.9-8-4.5-8-9V6z"/>'),
    ban: I('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
    lock: I('<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>'),
    trophy: I('<path d="M7 4h10v3a5 5 0 0 1-10 0z"/><path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3M9 13h6M10 13v4M14 13v4M8 20h8"/>'),
    chart: I('<path d="M4 20V4M20 20H4M8 20v-6M12 20V9M16 20v-9"/>'),
    scale: I('<path d="M12 3v18M7 7h10M6 7l-3 6h6zM18 7l-3 6h6zM3 13a3 3 0 0 0 6 0M15 13a3 3 0 0 0 6 0M8 21h8"/>'),
    edit: I('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    trash: I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  };
  CA.ICON = ICON;

  /* ── cabeçalho de página ── */
  CA.opHead = ({ title, sub, icon, actions }) => `<div class="op-head">
      <div><h1>${icon ? icon : ""}${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}</div>
      ${actions ? `<div class="op-actions">${actions}</div>` : ""}
    </div>`;
  CA.crumb = (parentView, parentLabel, current) => `<div class="crumb">
      <button type="button" data-go="${parentView}">${esc(parentLabel)}</button>
      <span>›</span><span class="c-pill">${esc(current)}</span></div>`;

  /* ── controle segmentado (abas Todos/Ação, Geral/Cassino/Esporte…) ── */
  CA.seg = (opts, active, attr) => `<div class="op-seg inline" data-seg="${attr}">${opts.map(([v, l, ic]) =>
    `<button type="button" data-${attr}="${v}" class="${v === active ? "on" : ""}">${ic ? ICON[ic] || ic : ""}${esc(l)}</button>`).join("")}</div>`;

  /* ── KPI (ícone redondo em cima) ── */
  CA.kpi = ({ label, value, sub, tone = "green", icon, vclass }) => `<div class="kcard tone-${tone}">
      <div class="k-ic">${icon || ICON.chart}</div>
      <div class="k-l">${esc(label)}</div>
      <div class="k-v ${vclass || ""}">${value}</div>
      ${sub ? `<div class="k-s">${sub}</div>` : ""}
    </div>`;

  /* ── badges ── */
  CA.badge = (text, tone) => `<span class="badge b-${tone}">${esc(text)}</span>`;
  const PIX_STATUS = {
    PENDING: ["Pendente", "orange"], PROCESSING: ["Processando", "blue"], PAID: ["Pago", "green"], FAILED: ["Falhou", "red"], EXPIRED: ["Expirado", "gray"],
  };
  CA.pixBadge = (s) => { const x = PIX_STATUS[s] || [s, "gray"]; return CA.badge(x[0], x[1]); };

  /* ── avatar com iniciais ── */
  CA.initials = (name) => (String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("") || "?").toUpperCase();
  CA.avatar = (name, cls) => `<span class="avatar ${cls || ""}">${esc(CA.initials(name))}</span>`;

  /* ── célula de usuário (avatar + nome + e-mail + abrir ficha) ── */
  CA.userCell = (u, { open = true } = {}) => `<div class="ucell">${CA.avatar(u.name)}
      <div class="u-txt"><b>${esc(u.name || "—")}${u.isTest ? CA.badge("teste", "purple") : ""}</b><span title="${esc(u.email || "")}">${esc(u.email || "—")}</span></div>
      ${open && u.id ? `<button type="button" class="ext" title="Abrir ficha" data-open-user="${esc(u.id)}">${ICON.ext}</button>` : ""}
    </div>`;

  /* ── copiar ── */
  CA.copyBtn = (value, label) => `<button type="button" class="copy" data-copy="${esc(value)}" title="Copiar ${esc(label || "")}">${ICON.copy}</button>`;
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.classList.add("ok");
      setTimeout(() => b.classList.remove("ok"), 900); } catch {}
  });
  // abrir ficha a partir de qualquer "ext" de usuário
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open-user]"); if (!b) return;
    CA.goView("user", b.dataset.openUser);
  });
  // breadcrumb / botões "voltar"
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]"); if (!b) return;
    CA.goView(b.dataset.go);
  });

  /* ── paginação (N itens · ‹ · pág/total · › · Ir Para · tamanho) ── */
  CA.pager = (total, page, size, onPage, onSize) => {
    const pages = Math.max(1, Math.ceil(total / size));
    return `<div class="pager">
      <span>${int(total)} ${total === 1 ? "item" : "itens"}</span>
      <div class="pg-mid">
        <button type="button" data-pg="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹</button>
        <span>${page} / ${pages}</span>
        <button type="button" data-pg="${page + 1}" ${page >= pages ? "disabled" : ""}>›</button>
        <input type="number" min="1" max="${pages}" value="${page}" data-pg-go /> <button type="button" class="op-btn sm" data-pg-goto>Ir</button>
      </div>
      <select data-pg-size>${[25, 50, 100].map((n) => `<option value="${n}" ${n === size ? "selected" : ""}>${n} / pág.</option>`).join("")}</select>
    </div>`;
  };
  CA.wirePager = (root, onPage, onSize) => {
    $$("[data-pg]", root).forEach((b) => (b.onclick = () => { if (!b.disabled) onPage(+b.dataset.pg); }));
    const goto = $("[data-pg-goto]", root), inp = $("[data-pg-go]", root);
    if (goto) goto.onclick = () => onPage(Math.max(1, +inp.value || 1));
    if (inp) inp.onkeydown = (e) => { if (e.key === "Enter") onPage(Math.max(1, +inp.value || 1)); };
    const sz = $("[data-pg-size]", root); if (sz) sz.onchange = () => onSize(+sz.value);
  };

  /* ── gráfico de barras por dia (com dica no hover) ── */
  const tip = document.createElement("div"); tip.className = "op-tip"; document.body.append(tip);
  CA.barChart = (series, { fmt = money, height = 150, tone = "green" } = {}) => {
    if (!series.length) return `<div class="op-empty" style="padding:30px">Sem dados no período.</div>`;
    const W = 760, H = height, pad = 6, max = Math.max(1, ...series.map((d) => d.value));
    const bw = (W - pad * 2) / series.length, gap = Math.min(10, bw * 0.3);
    const col = tone === "orange" ? "#f59e0b" : "#22c55e";
    const bars = series.map((d, i) => {
      const h = Math.max(1, (d.value / max) * (H - 24));
      const x = pad + i * bw, y = H - 20 - h;
      return `<rect class="bar" x="${x + gap / 2}" y="${y}" width="${bw - gap}" height="${h}" rx="3" fill="${col}" opacity="${d.value ? 0.85 : 0.25}"></rect>
        <rect class="hit" x="${x}" y="0" width="${bw}" height="${H - 16}" data-l="${esc(dmy(d.date))}" data-v="${esc(fmt(d.value))}" data-s="${esc(d.sub || "")}"></rect>`;
    }).join("");
    const ticks = series.map((d, i) => (i % Math.ceil(series.length / 8 || 1) === 0 || i === series.length - 1)
      ? `<text x="${pad + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" font-size="9" fill="#6f747d">${d.date.slice(8, 10)}/${d.date.slice(5, 7)}</text>` : "").join("");
    return `<div class="bars"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}${ticks}</svg></div>`;
  };
  CA.wireChart = (root) => {
    const box = $(".bars", root); if (!box) return;
    box.addEventListener("mousemove", (e) => {
      const hit = e.target.closest(".hit"); if (!hit) { tip.style.display = "none"; return; }
      tip.innerHTML = `<b>${hit.dataset.l}</b>${hit.dataset.v}${hit.dataset.s ? `<br>${hit.dataset.s}` : ""}`;
      tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = e.clientY - 10 + "px";
    });
    box.addEventListener("mouseleave", () => (tip.style.display = "none"));
  };

  /* ── estado vazio ── */
  CA.empty = (title, sub, icon) => `<div class="op-empty"><div class="e-ic">${icon || ICON.inbox}</div><b>${esc(title)}</b>${sub ? `<div>${esc(sub)}</div>` : ""}</div>`;

  /* ── toast ── */
  let toastTimer = null;
  CA.toast = (msg, kind = "ok") => {
    let t = $("#op_toast"); if (!t) { t = document.createElement("div"); t.id = "op_toast"; document.body.append(t); }
    t.style.cssText = "position:fixed;z-index:120;left:50%;bottom:26px;transform:translateX(-50%);padding:11px 18px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 12px 30px rgba(0,0,0,.5);" +
      (kind === "err" ? "background:#3a1414;color:#fca5a5;border:1px solid rgba(239,68,68,.5)" : "background:#13261a;color:#86efac;border:1px solid rgba(34,197,94,.5)");
    t.textContent = msg; t.style.display = "block";
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.style.display = "none"), 2600);
  };

  /* ── modal genérico ── */
  CA.modal = ({ title, body, footer, wide }) => {
    closeModal();
    const bg = document.createElement("div"); bg.className = "op-modal-bg"; bg.id = "op_modal";
    bg.innerHTML = `<div class="op-modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
        <div class="op-modal-h"><b>${esc(title)}</b><button type="button" data-mclose aria-label="Fechar">×</button></div>
        <div class="op-modal-b">${body}</div>
        ${footer ? `<div class="op-modal-f">${footer}</div>` : ""}
      </div>`;
    document.body.append(bg);
    bg.addEventListener("click", (e) => { if (e.target === bg || e.target.closest("[data-mclose]")) closeModal(); });
    return bg;
  };
  function closeModal() { const m = $("#op_modal"); if (m) m.remove(); }
  CA.closeModal = closeModal;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  /* confirmação simples → Promise<boolean> */
  CA.confirm = ({ title, message, confirmLabel = "Confirmar", danger }) => new Promise((resolve) => {
    const bg = CA.modal({ title, body: `<p style="margin:0;color:#c9cdd4;font-size:13.5px;line-height:1.5">${esc(message)}</p>`,
      footer: `<button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn ${danger ? "red" : "green"}" data-yes>${esc(confirmLabel)}</button>` });
    $("[data-no]", bg).onclick = () => { closeModal(); resolve(false); };
    $("[data-yes]", bg).onclick = () => { closeModal(); resolve(true); };
  });

  /* ── exportar CSV ── */
  CA.exportCsv = (filename, headers, rows) => {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [headers.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /* ── helpers de formulário no modal ── */
  CA.field = (label, inner) => `<label>${esc(label)}</label>${inner}`;
  CA.num = (name, { value = "", step = "0.01", min = "0", ph = "" } = {}) =>
    `<input type="number" data-f="${name}" step="${step}" min="${min}" value="${value}" placeholder="${esc(ph)}" />`;
  CA.sel = (name, opts, value) => `<select data-f="${name}">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  CA.area = (name, { value = "", ph = "" } = {}) => `<textarea data-f="${name}" placeholder="${esc(ph)}">${esc(value)}</textarea>`;
  CA.readForm = (root) => { const o = {}; $$("[data-f]", root).forEach((el) => { o[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value; }); return o; };

  /* ── chamada de API com aviso de erro padronizado ── */
  CA.call = async (path, opts) => {
    try { return await CA.api(path, opts); }
    catch (e) { CA.toast(e.message || "Falha na operação", "err"); throw e; }
  };
  CA.isAdmin = () => CA.me.role === "ADMIN";
  CA.isFinance = () => ["ADMIN", "FINANCE"].includes(CA.me.role);

  /* querystring a partir de objeto (ignora vazios) */
  CA.qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "" && v !== "all") p.set(k, v); }); const s = p.toString(); return s ? "?" + s : ""; };
})();
