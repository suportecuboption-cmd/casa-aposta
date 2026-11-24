/* ══════════════ Operação — Depósitos e Saques (modelo Axio) ══════════════ */
(function () {
  "use strict";
  const CA = window.CA, esc = CA.escA, money = CA.money, int = CA.int, ICON = CA.ICON;
  const $ = CA.$, $$ = CA.$$;

  const CFG = {
    DEPOSIT: { view: "deposits", title: "Depósitos", sub: "Entradas via PIX dos jogadores no período.", icon: ICON.arrowDown, tone: "green", actionTab: "Confirmar", confirmLabel: "Confirmar depósito" },
    WITHDRAW: { view: "withdrawals", title: "Saques", sub: "Pedidos de retirada que passam pela aprovação da equipe.", icon: ICON.arrowUp, tone: "orange", actionTab: "Ação necessária", confirmLabel: "Aprovar saque" },
  };
  const state = {};
  const st = (k) => state[k] || (state[k] = { ...CA.defaultRange(), tab: "all", status: "", gateway: "", q: "", page: 1, size: 25, sort: "date", dir: "desc", hideChart: false });

  async function load(kind) {
    const s = st(kind), seq = CA.bumpSeq(), cfg = CFG[kind];
    let data;
    try {
      data = await CA.api(`/admin/ops/pix${CA.qs({ kind, from: s.from, to: s.to, status: s.status, gateway: s.gateway, q: s.q, tab: s.tab, page: s.page, size: s.size, sort: s.sort, dir: s.dir })}`);
    } catch (e) { if (seq === CA.seq()) CA.render(CA.opHead({ title: cfg.title, icon: cfg.icon }) + CA.empty("Não foi possível carregar", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    paint(kind, data);
  }

  function paint(kind, d) {
    const s = st(kind), cfg = CFG[kind], k = d.kpis;
    const actionCount = kind === "WITHDRAW" ? d.actionCount : (s.tab === "action" ? d.total : null);
    const actBadge = actionCount ? `<span class="badge b-red" style="margin-left:6px">${int(actionCount)}</span>` : "";

    const kpis = kind === "DEPOSIT"
      ? [
          CA.kpi({ label: "Total recebido", value: money(k.totalPaid), sub: `${int(k.paidCount)} confirmados`, icon: ICON.coins, tone: "green" }),
          CA.kpi({ label: "Pendentes", value: money(k.pendingAmount), sub: `${int(k.pendingCount)} aguardando`, icon: ICON.inbox, tone: "orange" }),
          CA.kpi({ label: "Taxa de conversão", value: k.rate == null ? "—" : (k.rate * 100).toFixed(1) + "%", sub: "confirmados ÷ total", icon: ICON.chart, tone: "purple" }),
          CA.kpi({ label: "Ticket médio", value: money(k.avgTicket), sub: "por depósito pago", icon: ICON.scale, tone: "green" }),
        ].join("")
      : [
          CA.kpi({ label: "Total pago", value: money(k.totalPaid), sub: `${int(k.paidCount)} saques`, icon: ICON.coins, tone: "green" }),
          CA.kpi({ label: "Ação necessária", value: money(k.pendingAmount), sub: `${int(d.actionCount)} aguardando`, icon: ICON.warn, tone: "red" }),
          CA.kpi({ label: "Taxa de aprovação", value: k.rate == null ? "—" : (k.rate * 100).toFixed(1) + "%", sub: "aprovados ÷ decididos", icon: ICON.chart, tone: "purple" }),
          CA.kpi({ label: "Ticket médio", value: money(k.avgTicket), sub: "por saque pago", icon: ICON.scale, tone: "orange" }),
        ].join("");

    const series = d.daily.map((x) => ({ date: x.date, value: x.paid, sub: x.other ? "Outros status: " + money(x.other) : "" }));
    const chart = s.hideChart ? "" : `<div class="chart-box">
        <button type="button" class="hide-btn" data-hidechart>Ocultar</button>
        <h3>Volume por dia</h3><div class="sub">Pago em ${cfg.tone === "orange" ? "laranja" : "verde"} · ${CA.rangeLabel(s)}</div>
        ${CA.barChart(series, { fmt: money, tone: cfg.tone })}</div>`;

    const statusOpts = [["", "Todos os status"], ["PENDING", "Pendente"], ["PROCESSING", "Processando"], ["PAID", "Pago"], ["FAILED", "Recusado"], ["EXPIRED", "Expirado"]];
    const gwOpts = [["", "Todos os gateways"], ...d.gateways.map((g) => [g, g])];

    const html = CA.opHead({
      title: cfg.title, sub: cfg.sub, icon: cfg.icon,
      actions: `<button type="button" class="op-btn" data-export>${ICON.download}Exportar</button><button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    })
      + `<div class="op-seg">
          <button type="button" data-tab="all" class="${s.tab === "all" ? "on" : ""}">Todos</button>
          <button type="button" data-tab="action" class="${s.tab === "action" ? "on" : ""}">${cfg.actionTab}${actBadge}</button>
        </div>`
      + `<div class="op-toolbar">
          <div class="op-search">${ICON.search}<input placeholder="Buscar por usuário, e-mail, chave ou referência" value="${esc(s.q)}" data-q /></div>
          <select data-status ${s.tab === "action" ? "disabled" : ""}>${statusOpts.map(([v, l]) => `<option value="${v}" ${v === s.status ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select data-gateway>${gwOpts.map(([v, l]) => `<option value="${v}" ${v === s.gateway ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
          ${s.tab === "action" ? "" : CA.rangeBtn(s)}
        </div>`
      + `<div class="kgrid">${kpis}</div>`
      + chart
      + table(kind, d)
      + (d.total > d.size ? CA.pager(d.total, d.page, d.size) : "");

    CA.render(html);
    wire(kind, d);
  }

  function table(kind, d) {
    if (!d.items.length) return `<div class="op-table">${CA.empty(st(kind).tab === "action" ? "Nada aguardando" : "Sem registros no período", "Ajuste os filtros ou o intervalo de datas.")}</div>`;
    const heads = kind === "DEPOSIT"
      ? ["Usuário", `<span class="num">Valor</span>`, "Status", "Gateway", "Referência", "Data", `<span class="num">Ações</span>`]
      : ["Usuário", `<span class="num">Valor</span>`, "Status", "Chave PIX", "Gateway", "Data", `<span class="num">Ações</span>`];
    const rows = d.items.map((o) => {
      const valCell = kind === "WITHDRAW"
        ? `<div class="num"><b>${money(o.amount)}</b>${o.fee ? `<span class="muted" style="display:block;font-size:11px">taxa ${money(o.fee)} · líq. ${money(o.net)}</span>` : ""}</div>`
        : `<div class="num"><b>${money(o.amount)}</b></div>`;
      const pixCell = kind === "WITHDRAW"
        ? (o.pixKey ? `<div><span class="tag-s">${esc(o.pixKeyType || "PIX")}</span> <span style="font-size:12px">${esc(o.pixKey)}</span>${CA.copyBtn(o.pixKey, "chave")}</div>` : `<span class="muted">—</span>`)
        : "";
      const refCell = o.reference ? `<span style="font-size:12px;font-family:monospace">${esc(o.reference)}</span>${CA.copyBtn(o.reference, "referência")}` : `<span class="muted">—</span>`;
      const dtCell = `<div class="dt"><b>${CA.fdt(o.createdAt)}</b>${o.paidAt ? `<span>pago ${CA.fdt(o.paidAt)}</span>` : ""}</div>`;
      const acts = o.status === "PENDING"
        ? `<button type="button" class="icon-btn" title="${CFG[kind].confirmLabel}" data-approve="${o.id}" style="color:#4ade80">${ICON.check}</button>
           <button type="button" class="icon-btn" title="Recusar" data-reject="${o.id}" style="color:#f87171">${ICON.x}</button>`
        : `<button type="button" class="icon-btn" title="Detalhes" data-open="${o.id}">${ICON.ext}</button>`;
      const cells = kind === "DEPOSIT"
        ? [CA.userCell(o.user), valCell, CA.pixBadge(o.status), esc(o.gateway || "—"), refCell, dtCell, `<div class="row-actions">${acts}</div>`]
        : [CA.userCell(o.user), valCell, CA.pixBadge(o.status), pixCell, esc(o.gateway || "—"), dtCell, `<div class="row-actions">${acts}</div>`];
      return `<tr class="click" data-id="${o.id}">${cells.map((c, i) => `<td${i === 1 || i === cells.length - 1 ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`;
    }).join("");
    return `<div class="op-table"><div class="tscroll"><table>
      <thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  function wire(kind, d) {
    const s = st(kind), root = CA.view();
    $("[data-reload]", root).onclick = () => load(kind);
    const exp = $("[data-export]", root); if (exp) exp.onclick = () => exportCsv(kind, d);
    $$("[data-tab]", root).forEach((b) => (b.onclick = () => { s.tab = b.dataset.tab; s.page = 1; load(kind); }));
    const q = $("[data-q]", root); let qt; if (q) q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { s.q = q.value.trim(); s.page = 1; load(kind); }, 350); };
    const stat = $("[data-status]", root); if (stat) stat.onchange = () => { s.status = stat.value; s.page = 1; load(kind); };
    const gw = $("[data-gateway]", root); if (gw) gw.onchange = () => { s.gateway = gw.value; s.page = 1; load(kind); };
    const hc = $("[data-hidechart]", root); if (hc) hc.onclick = () => { s.hideChart = true; load(kind); };
    CA.wireRange(root, s, () => { s.page = 1; load(kind); });
    CA.wireChart(root);
    CA.wirePager(root, (p) => { s.page = p; load(kind); }, (sz) => { s.size = sz; s.page = 1; load(kind); });
    // ações da tabela
    root.querySelector(".op-table")?.addEventListener("click", (e) => {
      const ap = e.target.closest("[data-approve]"); if (ap) { e.stopPropagation(); return approve(kind, ap.dataset.approve); }
      const rj = e.target.closest("[data-reject]"); if (rj) { e.stopPropagation(); return reject(kind, rj.dataset.reject); }
      if (e.target.closest("[data-copy]") || e.target.closest("[data-open-user]")) return;
      const tr = e.target.closest("tr[data-id]"); if (tr) detail(kind, tr.dataset.id);
    });
  }

  async function approve(kind, id) {
    const ok = await CA.confirm({ title: CFG[kind].confirmLabel, message: kind === "DEPOSIT" ? "Confirmar este depósito e creditar o saldo do jogador?" : "Aprovar e pagar este saque? O valor sai do saldo do jogador.", confirmLabel: "Sim, confirmar" });
    if (!ok) return;
    const r = await CA.call(`/admin/pix/${id}/approve`, { method: "POST" });
    CA.toast(kind === "DEPOSIT" ? "Depósito confirmado"
      : r && r.status === "PROCESSING" ? "Saque enviado ao gateway — fica \"Processando\" até a confirmação" : "Saque aprovado");
    CA.refreshPending(); load(kind);
  }
  function reject(kind, id) {
    const bg = CA.modal({
      title: "Recusar pedido",
      body: CA.field("Motivo da recusa", CA.area("reason", { ph: "Fica registrado no histórico e visível no detalhe." })),
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn red" data-yes>Recusar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const reason = $("[data-f=reason]", bg).value.trim();
      if (reason.length < 3) { $("[data-msg]", bg).textContent = "Explique o motivo (mín. 3 letras)."; return; }
      try { await CA.api(`/admin/pix/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; return; }
      CA.closeModal(); CA.toast("Pedido recusado"); CA.refreshPending(); load(kind);
    };
  }

  async function detail(kind, id) {
    let o; try { o = await CA.api(`/admin/ops/pix/${id}`); } catch (e) { CA.toast(e.message, "err"); return; }
    const kv = [
      ["Jogador", `${esc(o.user.name)} · <span class="muted">${esc(o.user.email)}</span>`],
      ["Valor", money(o.amount)],
      ...(o.fee ? [["Taxa", money(o.fee)], ["Líquido", money(o.net)]] : []),
      ["Status", CA.pixBadge(o.status)],
      ["Gateway / Método", `${esc(o.gateway || "—")} · ${esc(o.method || "—")}`],
      ...(o.pixKey ? [["Chave PIX", `<span class="tag-s">${esc(o.pixKeyType || "PIX")}</span> ${esc(o.pixKey)}`]] : []),
      ["Referência", o.reference ? `<span style="font-family:monospace;font-size:12px">${esc(o.reference)}</span>` : "—"],
      ["Criado em", CA.fdt(o.createdAt)],
      ...(o.paidAt ? [["Pago em", CA.fdt(o.paidAt)]] : []),
      ["Saldo atual do jogador", money(o.user.balance)],
      ...(o.note ? [["Observação", esc(o.note)]] : []),
    ];
    const tl = o.timeline.map((t) => `<li class="${t.label.includes("Recus") ? "t-red" : t.label.includes("aprovad") || t.label.includes("confirmad") || t.label.includes("Pago") ? "t-green" : "t-blue"}">
        <b>${esc(t.label)}</b><small>${CA.fdt(t.at)}${t.by ? " · " + esc(t.by) : ""}${t.note ? " — " + esc(t.note) : ""}</small></li>`).join("");
    const footer = o.status === "PENDING"
      ? `<button type="button" class="op-btn red" data-rj>Recusar</button><button type="button" class="op-btn green" data-ap>${CFG[kind].confirmLabel}</button>`
      : `<button type="button" class="op-btn" data-mclose>Fechar</button>`;
    const bg = CA.modal({ title: `${kind === "DEPOSIT" ? "Depósito" : "Saque"} · ${o.id.slice(-8)}`, wide: true,
      body: `<div class="kv2">${kv.map(([l, v]) => `<div><span>${esc(l)}</span><b>${v}</b></div>`).join("")}</div>
             <div class="sec-cap">Linha do tempo</div><ul class="tl">${tl}</ul>`,
      footer });
    const ap = $("[data-ap]", bg); if (ap) ap.onclick = () => { CA.closeModal(); approve(kind, id); };
    const rj = $("[data-rj]", bg); if (rj) rj.onclick = () => { CA.closeModal(); reject(kind, id); };
  }

  function exportCsv(kind, d) {
    const head = kind === "DEPOSIT"
      ? ["Usuário", "E-mail", "Valor", "Status", "Gateway", "Referência", "Criado", "Pago"]
      : ["Usuário", "E-mail", "Valor", "Taxa", "Líquido", "Status", "Chave PIX", "Gateway", "Criado", "Pago"];
    const rows = d.items.map((o) => kind === "DEPOSIT"
      ? [o.user.name, o.user.email, o.amount, o.status, o.gateway, o.reference, CA.fdt(o.createdAt), o.paidAt ? CA.fdt(o.paidAt) : ""]
      : [o.user.name, o.user.email, o.amount, o.fee, o.net, o.status, o.pixKey, o.gateway, CA.fdt(o.createdAt), o.paidAt ? CA.fdt(o.paidAt) : ""]);
    CA.exportCsv(`${CFG[kind].view}-${d.range.from}_a_${d.range.to}.csv`, head, rows);
  }

  CA.registerViews({ deposits: () => load("DEPOSIT"), withdrawals: () => load("WITHDRAW") });
})();
