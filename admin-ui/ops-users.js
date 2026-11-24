/* ══════════════ Operação — Usuários e ficha do jogador (12 abas, modelo Axio) ══════════════ */
(function () {
  "use strict";
  const CA = window.CA, esc = CA.escA, money = CA.money, int = CA.int, ICON = CA.ICON;
  const $ = CA.$, $$ = CA.$$;

  const MODE = {
    OPERATIONAL: ["Operacional", "green"], WITHDRAW_ONLY: ["Somente saque", "orange"], BLOCKED: ["Bloqueado", "red"],
  };
  const modeBadge = (m) => { const x = MODE[m] || ["—", "gray"]; return CA.badge(x[0], x[1]); };
  const KYC_BADGE = { verified: ["Verificado", "green"], none: ["Sem KYC", "gray"] };
  const kycBadge = (k) => { const x = KYC_BADGE[k] || ["—", "gray"]; return CA.badge(x[0], x[1]); };
  const KIND_PT = { SELF_EXCLUSION: "Autoexclusão", SUSPENSION: "Suspensão", MANUAL_BLOCK: "Bloqueio manual" };

  /* ═════════════ lista de usuários ═════════════ */
  const ls = { q: "", account: "all", kyc: "all", activity: "all", signup: "all", page: 1, size: 25, sort: "createdAt", dir: "desc" };

  async function loadList() {
    const seq = CA.bumpSeq();
    let d; try { d = await CA.api(`/admin/ops/users${CA.qs(ls)}`); } catch (e) { if (seq === CA.seq()) CA.render(CA.opHead({ title: "Usuários", icon: ICON.person }) + CA.empty("Não foi possível carregar", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    paintList(d);
  }

  function paintList(d) {
    const k = d.kpis;
    const sel = (name, opts) => `<select data-f="${name}">${opts.map(([v, l]) => `<option value="${v}" ${v === ls[name] ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const html = CA.opHead({
      title: "Usuários", sub: "Base de jogadores, com filtros de conta, KYC e atividade.", icon: ICON.person,
      actions: `${CA.isAdmin() ? `<button type="button" class="op-btn green" data-newtest>${ICON.plus}Criar Conta Teste</button>` : ""}<button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    })
      + `<div class="kgrid three">
          ${CA.kpi({ label: "Total de jogadores", value: int(k.total), sub: "todas as contas", icon: ICON.person, tone: "green" })}
          ${CA.kpi({ label: "Ativos (30 dias)", value: int(k.active30), sub: (k.activeShare * 100).toFixed(0) + "% da base", icon: ICON.chart, tone: "purple" })}
          ${CA.kpi({ label: "Contas de teste", value: int(k.test), sub: "fora das métricas", icon: ICON.shield, tone: "orange" })}
        </div>`
      + `<div class="op-toolbar">
          <div class="op-search">${ICON.search}<input placeholder="Buscar por nome, e-mail, CPF, telefone ou ID" value="${esc(ls.q)}" data-q /></div>
          ${sel("account", [["all", "Todas as contas"], ["active", "Ativas"], ["blocked", "Bloqueadas"], ["restricted", "Com restrição"], ["test", "Contas de teste"]])}
          ${sel("kyc", [["all", "KYC: todos"], ["verified", "KYC verificado"], ["none", "Sem KYC"]])}
          ${sel("activity", [["all", "Atividade: toda"], ["active30", "Ativos 30d"], ["inactive30", "Inativos 30d"]])}
          ${sel("signup", [["all", "Cadastro: sempre"], ["today", "Hoje"], ["7d", "7 dias"], ["30d", "30 dias"]])}
        </div>`
      + listTable(d)
      + (d.total > d.size ? CA.pager(d.total, d.page, d.size) : "");
    CA.render(html);
    const root = CA.view();
    $("[data-reload]", root).onclick = loadList;
    const nt = $("[data-newtest]", root); if (nt) nt.onclick = newTestAccount;
    const q = $("[data-q]", root); let qt; q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { ls.q = q.value.trim(); ls.page = 1; loadList(); }, 350); };
    ["account", "kyc", "activity", "signup"].forEach((n) => { $(`[data-f=${n}]`, root).onchange = (e) => { ls[n] = e.target.value; ls.page = 1; loadList(); }; });
    CA.wirePager(root, (p) => { ls.page = p; loadList(); }, (sz) => { ls.size = sz; ls.page = 1; loadList(); });
  }

  function listTable(d) {
    if (!d.items.length) return `<div class="op-table">${CA.empty("Nenhum jogador", "Ajuste os filtros.")}</div>`;
    const rows = d.items.map((u) => `<tr class="click" data-open-user="${u.id}">
        <td>${CA.userCell(u, { open: false })}</td>
        <td>${u.cpf ? esc(u.cpf) + CA.copyBtn(u.cpf, "CPF") : '<span class="muted">—</span>'}</td>
        <td>${u.phone ? esc(u.phone) : '<span class="muted">—</span>'}</td>
        <td>${CA.fdt(u.createdAt)}</td>
        <td>${modeBadge(u.mode)}${u.restriction ? " " + CA.badge(KIND_PT[u.restriction] || u.restriction, "gray") : ""}</td>
        <td>${kycBadge(u.kyc)}</td>
        <td class="num"><button type="button" class="icon-btn" title="Abrir ficha" data-open-user="${u.id}">${ICON.ext}</button></td>
      </tr>`).join("");
    return `<div class="op-table"><div class="tscroll"><table>
      <thead><tr><th>Usuário</th><th>CPF</th><th>Telefone</th><th>Cadastro</th><th>Conta</th><th>KYC</th><th class="num">Ações</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  }

  function newTestAccount() {
    const bg = CA.modal({
      title: "Criar conta de teste",
      body: `${CA.field("Nome", `<input data-f="name" placeholder="Jogador de Teste" />`)}
             ${CA.field("E-mail", `<input data-f="email" type="email" placeholder="teste@lab.local" />`)}
             ${CA.field("Senha", `<input data-f="password" type="text" value="Teste123!" />`)}
             ${CA.field("Saldo inicial (opcional)", CA.num("initialBalance", { value: "0", min: "0" }))}
             <p class="op-note" style="margin-top:10px">A conta fica fora das métricas, rankings e vitrine de vitórias.</p>`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Criar conta</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const f = CA.readForm(bg);
      const body = { name: f.name, email: f.email, password: f.password, initialBalance: Number(f.initialBalance || 0) };
      try { const r = await CA.api("/admin/ops/users/test", { method: "POST", body: JSON.stringify(body) }); CA.closeModal(); CA.toast("Conta de teste criada"); CA.goView("user", r.id); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }

  /* ═════════════ ficha do jogador ═════════════ */
  let D = null, fid = null, activeTab = "overview", quickOpen = true;
  const frange = {}; // intervalos por aba

  const TABS = [
    ["overview", "Visão Geral"], ["bets", "Apostas"], ["deposits", "Depósitos"], ["withdrawals", "Saques"],
    ["ledger", "Extrato"], ["kyc", "Perfil & KYC"], ["risk", "Risco & Limites"], ["protection", "Proteção do Jogador"],
    ["security", "Segurança"], ["timeline", "Timeline"], ["cashback", "Cashback"], ["bonus", "Bônus"],
  ];

  async function loadUser(id) {
    const seq = CA.bumpSeq();
    fid = id; activeTab = "overview";
    let d; try { d = await CA.api(`/admin/ops/users/${id}`); } catch (e) { if (seq === CA.seq()) CA.render(CA.crumb("users", "Usuários", "—") + CA.empty("Jogador não encontrado", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    D = d;
    paintUser();
  }

  function paintUser() {
    const u = D.user, q = D.quick, mode = D.protection.mode;
    const alert = mode === "BLOCKED"
      ? `<div class="alert-banner"><div class="ab-ic">${ICON.ban}</div><div><b>Conta bloqueada</b>O jogador não consegue depositar nem apostar. Saques seguem sob avaliação.</div></div>`
      : mode === "WITHDRAW_ONLY"
      ? `<div class="alert-banner warn"><div style="display:flex;gap:12px;align-items:center"><div class="ab-ic" style="background:rgba(245,158,11,.15);color:#f59e0b">${ICON.warn}</div><div><b>Somente saque</b> — depósitos e apostas estão suspensos para esta conta.</div></div></div>`
      : "";
    const block = mode === "BLOCKED"
      ? `<button type="button" class="op-btn green" data-unblock>${ICON.check}Desbloquear</button>`
      : `<button type="button" class="op-btn red" data-block>${ICON.ban}Bloquear usuário</button>`;

    const q4 = (label, value, mono) => `<div><span>${esc(label)}</span><b class="${mono ? "mono" : ""}">${value}</b></div>`;
    const quick = `<div class="quick-h"><span>Detalhes rápidos</span><button type="button" data-togglequick>${quickOpen ? "Recolher" : "Expandir"}</button></div>
      <div class="quick" ${quickOpen ? "" : "hidden"}>
        ${q4("E-mail", esc(u.email) + CA.copyBtn(u.email, "e-mail"))}
        ${q4("Telefone", u.phone ? esc(u.phone) + CA.copyBtn(u.phone, "telefone") : "—")}
        ${q4("ID", `<span class="mono">${esc(u.id.slice(0, 14))}…</span>` + CA.copyBtn(u.id, "ID"), false)}
        ${q4("Saldo disponível", `<span class="${D.wallet.balance > 0 ? "v-green" : ""}">${money(D.wallet.balance)}</span>`)}
        ${q4("Data de nascimento", u.birthDate ? CA.fdate(u.birthDate) : "—")}
        ${q4("Data de cadastro", CA.fdt(u.createdAt))}
        ${q4("CPF", u.cpf ? esc(u.cpf) + CA.copyBtn(u.cpf, "CPF") : "—", true)}
        ${q4("IP", u.lastIp ? `<span class="mono">${esc(u.lastIp)}</span>` + CA.copyBtn(u.lastIp, "IP") : "—", false)}
        ${q4("Último depósito", q.lastDeposit ? money(q.lastDeposit) : money(0))}
        ${q4("Qtd. Depósitos", int(q.depositsCount))}
        ${q4("Qtd. Saques", int(q.withdrawalsCount))}
        ${q4("Primeiro depósito", q.firstDeposit ? money(q.firstDeposit) : money(0))}
      </div>`;

    const html = CA.crumb("users", "Usuários", u.email)
      + alert
      + `<div class="uhead">
          <div class="uhead-top">
            <div class="u-id"><span class="u-av">${ICON.person}</span>
              <div><h2>${esc(u.name)}${u.isTest ? CA.badge("teste", "purple") : ""}${modeBadge(mode)}</h2>
                <div class="u-sub">Jogador · ${CA.rel(u.lastSeenAt)} · entrou em ${CA.fdate(u.createdAt)}</div></div>
            </div>
            <div class="op-actions">
              <button type="button" class="op-btn" data-acts>${ICON.dot3}Ações</button>
              ${block}
            </div>
          </div>
          ${quick}
        </div>`
      + `<div class="utabs">${TABS.map(([v, l]) => `<button type="button" data-tab="${v}" class="${v === activeTab ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`
      + `<div id="utab"></div>`;
    CA.render(html);
    wireHead();
    renderTab(activeTab);
  }

  function wireHead() {
    const root = CA.view();
    $("[data-togglequick]", root).onclick = () => { quickOpen = !quickOpen; const qd = $(".quick", root); qd.hidden = !quickOpen; $("[data-togglequick]", root).textContent = quickOpen ? "Recolher" : "Expandir"; };
    $$("[data-tab]", root).forEach((b) => (b.onclick = () => { activeTab = b.dataset.tab; $$("[data-tab]", root).forEach((x) => x.classList.toggle("on", x === b)); renderTab(activeTab); }));
    const bl = $("[data-block]", root); if (bl) bl.onclick = () => blockUser();
    const ub = $("[data-unblock]", root); if (ub) ub.onclick = () => unblockUser();
    $("[data-acts]", root).onclick = (e) => openActions(e.currentTarget);
  }

  const tabEl = () => document.getElementById("utab");
  const rng = (tab) => frange[tab] || (frange[tab] = CA.defaultRange());

  async function renderTab(tab) {
    const el = tabEl(); if (!el) return;
    if (tab === "overview") return el.innerHTML = tabOverview();
    if (tab === "kyc") return el.innerHTML = tabKyc();
    if (tab === "risk") return (el.innerHTML = tabRisk(), wireRisk());
    if (tab === "protection") return (el.innerHTML = tabProtection(), wireProtection());
    if (tab === "cashback") return el.innerHTML = tabCashback();
    el.innerHTML = `<div class="op-empty">Carregando…</div>`;
    const seq = CA.bumpSeq();
    try {
      if (tab === "bets") { const d = await CA.api(`/admin/ops/users/${fid}/bets${CA.qs({ ...rng("bets") })}`); if (seq === CA.seq()) (el.innerHTML = tabBets(d), wireTabRange("bets"), CA.wirePager(el, () => {}, () => {})); }
      else if (tab === "deposits" || tab === "withdrawals") { const kind = tab === "deposits" ? "DEPOSIT" : "WITHDRAW"; const d = await CA.api(`/admin/ops/users/${fid}/pix${CA.qs({ kind, ...rng(tab) })}`); if (seq === CA.seq()) (el.innerHTML = tabPix(kind, d), wireTabRange(tab)); }
      else if (tab === "ledger") { const d = await CA.api(`/admin/ops/users/${fid}/ledger${CA.qs({ ...rng("ledger"), category: rng("ledger").category || "all" })}`); if (seq === CA.seq()) (el.innerHTML = tabLedger(d), wireLedger()); }
      else if (tab === "timeline") { const d = await CA.api(`/admin/ops/users/${fid}/timeline`); if (seq === CA.seq()) (el.innerHTML = tabTimeline(d), wireTimeline(d)); }
      else if (tab === "security") { const d = await CA.api(`/admin/ops/users/${fid}/security`); if (seq === CA.seq()) el.innerHTML = tabSecurity(d); }
      else if (tab === "bonus") { const d = await CA.api(`/admin/incentives/grants${CA.qs({ userId: fid, size: 100 })}`); if (seq === CA.seq()) (el.innerHTML = tabBonus(d), wireBonus()); }
    } catch (e) { if (seq === CA.seq()) el.innerHTML = CA.empty("Não foi possível carregar", e.message, ICON.warn); }
  }

  /* ── aba: Visão Geral ── */
  function tabOverview() {
    const o = D.overview;
    const stat = (label, value, sub, cls) => `<div class="box"><span style="color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em">${esc(label)}</span>
      <div style="font-size:20px;font-weight:700;margin-top:6px" class="${cls || ""}">${value}</div>${sub ? `<div style="color:var(--muted);font-size:12px;margin-top:3px">${sub}</div>` : ""}</div>`;
    const pend = [];
    if (o.pending.withdrawals) pend.push(CA.badge(`${o.pending.withdrawals} saque(s) pendente(s)`, "orange"));
    if (o.pending.kycSent) pend.push(CA.badge("KYC em análise", "blue"));
    if (o.pending.selfExclusion) pend.push(CA.badge("Autoexcluído", "red"));
    return (pend.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${pend.join("")}</div>` : "")
      + `<div class="sec-cap">Resultado financeiro</div>
      <div class="g4">
        ${stat("Net depósitos (total)", money(o.netDepositsLifetime), "depósitos − saques", o.netDepositsLifetime >= 0 ? "v-green" : "v-red")}
        ${stat("Net depósitos (30d)", money(o.netDeposits30d), "últimos 30 dias", o.netDeposits30d >= 0 ? "v-green" : "v-red")}
        ${stat("GGR do jogador", money(o.ggrLifetime), "o que a casa ganhou", o.ggrLifetime >= 0 ? "v-green" : "v-red")}
        ${stat("Apostado (total)", money(o.bets.staked), int(o.bets.count) + " apostas")}
      </div>
      <div class="sec-cap">Caixa</div>
      <div class="g4">
        ${stat("Depositado", money(o.deposited), int(o.depositedN) + " depósitos", "v-green")}
        ${stat("Sacado", money(o.withdrawn), int(o.withdrawnN) + " saques", "v-orange")}
        ${stat("Ajustes manuais", `+${money(o.adjustments.added)} / −${money(o.adjustments.subtracted)}`, `${int(o.adjustments.addedN + o.adjustments.subtractedN)} lançamentos`)}
        ${stat("Bônus recebido", money(o.bonus.received), int(o.bonus.receivedN) + " créditos", "v-green")}
      </div>
      <div class="sec-cap">Atividade de jogo</div>
      <div class="g3">
        ${stat("Última aposta", o.bets.lastAt ? CA.fdt(o.bets.lastAt) : "—", o.bets.lastGame || "—")}
        ${stat("Provedor preferido", o.bets.topProvider || "—", "por volume apostado")}
        ${stat("Saldo em carteira", money(D.wallet.balance), D.wallet.bonus ? "bônus " + money(D.wallet.bonus) : "sem bônus", "v-green")}
      </div>`;
  }

  /* ── aba: Apostas ── */
  function tabBets(d) {
    const k = d.kpis;
    const head = toolbarRange("bets") + `<div class="kgrid"><div class="kcard tone-green"><div class="k-l">Rodadas</div><div class="k-v">${int(k.rounds)}</div></div>
      <div class="kcard tone-gray"><div class="k-l">Turnover</div><div class="k-v">${money(k.turnover)}</div></div>
      <div class="kcard tone-orange"><div class="k-l">Retorno ao jogador</div><div class="k-v">${money(k.payout)}</div></div>
      <div class="kcard tone-purple"><div class="k-l">GGR (casa)</div><div class="k-v ${k.ggr >= 0 ? "v-green" : "v-red"}">${money(k.ggr)}</div></div></div>`;
    if (!d.items.length) return head + `<div class="op-table">${CA.empty("Sem apostas no período", "Ajuste o intervalo de datas.")}</div>`;
    const rows = d.items.map((r) => `<tr>
      <td><div class="dt"><b>${esc(r.game)}</b><span>${esc(r.provider)}</span></div></td>
      <td>${CA.badge(r.type, r.type === "Esportes" ? "blue" : "gray")}</td>
      <td>${CA.badge(r.status, r.status === "Ganhou" ? "green" : r.status === "Perdeu" ? "gray" : "orange")}</td>
      <td class="num">${money(r.turnover)}</td>
      <td class="num">${money(r.payout)}</td>
      <td class="num ${r.result >= 0 ? "v-green" : "v-red"}">${money(r.result)}</td>
      <td>${CA.fdt(r.at)}</td></tr>`).join("");
    return head + `<div class="op-table"><div class="tscroll"><table>
      <thead><tr><th>Jogo</th><th>Tipo</th><th>Situação</th><th class="num">Apostado</th><th class="num">Retorno</th><th class="num">Resultado</th><th>Quando</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  }

  /* ── abas: Depósitos / Saques da ficha ── */
  function tabPix(kind, d) {
    const k = d.kpis;
    const head = toolbarRange(kind === "DEPOSIT" ? "deposits" : "withdrawals")
      + `<div class="kgrid"><div class="kcard tone-green"><div class="k-l">Total pago</div><div class="k-v">${money(k.totalPaid)}</div></div>
        <div class="kcard tone-gray"><div class="k-l">Qtde paga</div><div class="k-v">${int(k.paidCount)}</div></div>
        <div class="kcard tone-orange"><div class="k-l">Pendentes</div><div class="k-v">${money(k.pendingAmount)}</div></div>
        <div class="kcard tone-purple"><div class="k-l">Ticket médio</div><div class="k-v">${money(k.avgTicket)}</div></div></div>`;
    if (!d.items.length) return head + `<div class="op-table">${CA.empty("Sem registros", "Ajuste o intervalo de datas.")}</div>`;
    const rows = d.items.map((o) => `<tr>
      <td class="num"><b>${money(o.amount)}</b></td>
      <td>${CA.pixBadge(o.status)}</td>
      ${kind === "WITHDRAW" ? `<td>${o.pixKey ? `<span class="tag-s">${esc(o.pixKeyType || "PIX")}</span> ${esc(o.pixKey)}` : "—"}</td>` : `<td>${esc(o.gateway || "—")}</td>`}
      <td>${o.reference ? `<span style="font-family:monospace;font-size:12px">${esc(o.reference)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${CA.fdt(o.createdAt)}</td>
      <td>${o.paidAt ? CA.fdt(o.paidAt) : '<span class="muted">—</span>'}</td></tr>`).join("");
    return head + `<div class="op-table"><div class="tscroll"><table>
      <thead><tr><th class="num">Valor</th><th>Status</th><th>${kind === "WITHDRAW" ? "Chave PIX" : "Gateway"}</th><th>Referência</th><th>Criado</th><th>Pago</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  }

  /* ── aba: Extrato ── */
  function tabLedger(d) {
    const k = d.kpis, r = rng("ledger");
    const bal = d.series.balance.map((x) => ({ date: x.date, value: x.balance, sub: "" }));
    const cats = [["all", "Tudo"], ["deposits", "Depósitos"], ["withdrawals", "Saques"], ["casino", "Cassino"], ["sports", "Esportes"], ["adjustments", "Ajustes"], ["bonus", "Bônus"]];
    const head = toolbarRange("ledger")
      + `<div class="stat-line">
          <div><span>Saldo inicial</span><b>${money(k.startBalance)}</b></div>
          <div><span>Entradas</span><b class="v-green">${money(k.inflow.amount)}</b></div>
          <div><span>Saídas</span><b class="v-red">${money(k.outflow.amount)}</b></div>
          <div><span>Saldo final</span><b>${money(k.endBalance)}</b></div>
        </div>`
      + `<div class="chart-box"><h3>Evolução do saldo</h3><div class="sub">${CA.rangeLabel(r)}</div>${CA.barChart(bal, { fmt: money, tone: "green" })}</div>`
      + `<div class="op-toolbar"><div class="op-seg inline">${cats.map(([v, l]) => `<button type="button" data-cat="${v}" class="${(r.category || "all") === v ? "on" : ""}">${esc(l)}</button>`).join("")}</div></div>`;
    if (!d.items.length) return head + `<div class="op-table">${CA.empty("Sem lançamentos", "Ajuste o período ou a categoria.")}</div>`;
    const rows = d.items.map((t) => `<tr>
      <td>${CA.fdt(t.at)}</td>
      <td>${CA.badge(LTYPE[t.type] || t.type, LTONE[t.category] || "gray")}</td>
      <td class="muted">${esc(t.details)}</td>
      <td class="num ${t.amount >= 0 ? "v-green" : "v-red"}">${t.amount >= 0 ? "+" : ""}${money(t.amount)}</td>
      <td class="num">${money(t.balanceAfter)}</td></tr>`).join("");
    return head + `<div class="op-table"><div class="tscroll"><table>
      <thead><tr><th>Data</th><th>Tipo</th><th>Detalhe</th><th class="num">Valor</th><th class="num">Saldo após</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>` + (d.total > d.size ? CA.pager(d.total, d.page, d.size) : "");
  }
  const LTYPE = { DEPOSIT: "Depósito", WITHDRAW: "Saque", CASINO_BET: "Aposta cassino", CASINO_WIN: "Prêmio cassino", CASINO_REFUND: "Estorno cassino", BET_STAKE: "Aposta esporte", BET_WIN: "Prêmio esporte", BET_REFUND: "Estorno esporte", ADJUSTMENT: "Ajuste", BONUS: "Bônus" };
  const LTONE = { deposits: "green", withdrawals: "orange", casino: "purple", sports: "blue", adjustments: "gray", bonus: "green" };

  /* ── aba: Perfil & KYC ── */
  function tabKyc() {
    const u = D.user, k = D.kyc;
    const row = (l, v) => `<div><span>${esc(l)}</span><b>${v}</b></div>`;
    return `<div class="sec-cap">Verificação (KYC)</div>
      <div class="box"><div class="box-h"><b><span class="box-ic" style="--tone:${k.verified ? "var(--green)" : "#f59e0b"};--tone-bg:${k.verified ? "rgba(34,197,94,.15)" : "rgba(245,158,11,.15)"}">${ICON.shield}</span>${esc(k.status)}</b>${kycBadge(k.verified ? "verified" : "none")}</div>
        <div class="kv2"><div><span>Nível</span><b>${int(k.level)}</b></div><div><span>Atualizado</span><b>${k.updatedAt ? CA.fdt(k.updatedAt) : "—"}</b></div></div></div>
      <div class="sec-cap">Dados cadastrais</div>
      <div class="box"><div class="kv2">
        ${row("Nome", esc(u.name))}
        ${row("E-mail", esc(u.email) + CA.copyBtn(u.email, "e-mail"))}
        ${row("CPF", u.cpf ? esc(u.cpf) : "—")}
        ${row("Telefone", u.phone ? esc(u.phone) : "—")}
        ${row("Data de nascimento", u.birthDate ? CA.fdate(u.birthDate) : "—")}
        ${row("Cadastro", CA.fdt(u.createdAt))}
      </div></div>`;
  }

  /* ── aba: Risco & Limites ── */
  function tabRisk() {
    const r = D.risk, wl = D.withdrawLimits, rg = D.protection.limits;
    const ring = r ? riskRing(r) : CA.empty("Sem score de risco", "Ainda não há dados suficientes.");
    const comp = r ? r.components.map((c) => {
      const bad = (c.value || 0) >= 50;
      const notes = Array.isArray(c.notes) ? c.notes : c.notes ? [c.notes] : [];
      return `<div class="comp-row ${bad ? "bad" : ""}"><div class="c-ic">${bad ? ICON.warn : ICON.check}</div>
        <div><b>${esc(c.label)}</b>${notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</div>
        <span class="c-v">${(c.value || 0).toFixed(0)}</span></div>`;
    }).join("") : "";
    const limFmt = (v, kind) => v == null ? '<span class="muted">Sem limite</span>' : kind === "count" ? int(v) + " / dia" : kind === "min" ? int(v) + " min" : money(v);
    const eff = wl.effective;
    return `<div class="g2">
        <div class="box"><div class="box-h"><b><span class="box-ic" style="--tone:var(--green);--tone-bg:rgba(34,197,94,.15)">${ICON.shield}</span>Score de risco</b></div>${ring}${comp ? `<div style="margin-top:14px">${comp}</div>` : ""}</div>
        <div class="box"><div class="box-h"><b><span class="box-ic" style="--tone:#f59e0b;--tone-bg:rgba(245,158,11,.15)">${ICON.scale}</span>Limites de saque</b>${CA.isFinance() ? `<button type="button" class="link-pill" data-setwl>${ICON.edit} Ajustar individual</button>` : ""}</div>
          <div class="kv2">
            <div><span>Máx. por saque</span><b>${limFmt(eff.maxPerWithdrawal)}</b></div>
            <div><span>Diário (valor)</span><b>${limFmt(eff.dailyAmount)}</b></div>
            <div><span>Diário (qtde)</span><b>${limFmt(eff.dailyCount, "count")}</b></div>
            <div><span>Intervalo mínimo</span><b>${limFmt(eff.minIntervalMin, "min")}</b></div>
          </div>
          <p class="op-note" style="margin:10px 0 0">Fonte: ${wl.source === "individual" ? "limite individual" : wl.source === "mixed" ? "individual + casa" : "padrão da casa"}.${wl.updatedBy ? " Alterado por " + esc(wl.updatedBy) + "." : ""}</p>
        </div>
      </div>
      <div class="sec-cap">Limites de jogo responsável</div>
      ${rg.length ? `<div class="op-table"><div class="tscroll"><table><thead><tr><th>Tipo</th><th>Período</th><th class="num">Limite</th><th>Definido por</th><th class="num"></th></tr></thead><tbody>
        ${rg.map((l) => `<tr><td>${esc(RG_KIND[l.kind] || l.kind)}</td><td>${esc(RG_PER[l.period] || l.period)}</td><td class="num">${money(l.amount)}</td><td class="muted">${esc(l.by)}</td><td class="num"><button type="button" class="icon-btn" title="Remover" data-rmlimit="${l.id}">${ICON.trash}</button></td></tr>`).join("")}
      </tbody></table></div></div>` : `<div class="dashed">Nenhum limite de jogo responsável configurado.</div>`}
      <div style="margin-top:12px"><button type="button" class="op-btn" data-addlimit>${ICON.plus}Adicionar limite</button></div>`;
  }
  const RG_KIND = { DEPOSIT: "Depósito", BET: "Aposta", LOSS: "Perda", SESSION: "Sessão" };
  const RG_PER = { DAY: "Diário", WEEK: "Semanal", MONTH: "Mensal" };

  function riskRing(r) {
    const score = Math.round(r.score || 0), lvl = r.level || "—";
    const col = score >= 60 ? "#f87171" : score >= 30 ? "#fbbf24" : "#4ade80";
    const circ = 2 * Math.PI * 54, off = circ * (1 - score / 100);
    return `<div class="risk-ring"><svg viewBox="0 0 150 150">
        <circle cx="75" cy="75" r="54" fill="none" stroke="#24262c" stroke-width="12"/>
        <circle cx="75" cy="75" r="54" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 75 75)"/>
        <text x="75" y="72" text-anchor="middle" font-size="34" font-weight="700" fill="#fff">${score}</text>
        <text x="75" y="95" text-anchor="middle" font-size="12" fill="${col}">${esc(lvl)}</text></svg></div>`;
  }

  function wireRisk() {
    const el = tabEl();
    const sw = $("[data-setwl]", el); if (sw) sw.onclick = setWithdrawLimits;
    const al = $("[data-addlimit]", el); if (al) al.onclick = addRgLimit;
    $$("[data-rmlimit]", el).forEach((b) => (b.onclick = async () => { if (await CA.confirm({ title: "Remover limite", message: "Remover este limite de jogo responsável?", danger: true, confirmLabel: "Remover" })) { await CA.call(`/admin/ops/limits/${b.dataset.rmlimit}`, { method: "DELETE" }); CA.toast("Limite removido"); refresh(); } }));
  }

  /* ── aba: Proteção do Jogador ── */
  function tabProtection() {
    const p = D.protection, active = p.restrictions.filter((r) => r.active), hist = p.history;
    const selfExcl = active.find((r) => r.kind === "SELF_EXCLUSION");
    const cards = `<div class="g3">
      ${protCard("Acesso da conta", MODE[p.mode][0], p.mode === "OPERATIONAL" ? "green" : "red", p.mode === "OPERATIONAL" ? "Jogador pode depositar, apostar e sacar." : p.mode === "WITHDRAW_ONLY" ? "Apenas saques permitidos." : "Conta bloqueada para jogo.")}
      ${protCard("Autoexclusão", selfExcl ? "Ativa" : "Não", selfExcl ? "red" : "green", selfExcl ? `Até ${selfExcl.endsAt ? CA.fdate(selfExcl.endsAt) : "sem prazo"}.` : "Jogador não está autoexcluído.")}
      ${protCard("Restrições ativas", String(active.length), active.length ? "red" : "green", active.length ? "Veja a lista abaixo." : "Nenhuma restrição em vigor.")}
    </div>`;
    const activeList = active.length ? `<div class="sec-cap">Restrições em vigor</div>
      <div class="op-table"><div class="tscroll"><table><thead><tr><th>Tipo</th><th>Motivo</th><th>Início</th><th>Prazo</th><th>Por</th><th class="num">Ações</th></tr></thead><tbody>
        ${active.map((r) => `<tr><td>${CA.badge(r.kindPt || KIND_PT[r.kind], "red")}${r.scope === "TOTAL" ? " " + CA.badge("total", "gray") : ""}</td>
          <td>${esc(r.reason)}</td><td>${CA.fdt(r.startsAt || r.createdAt)}</td><td>${r.endsAt ? CA.fdate(r.endsAt) : "sem prazo"}</td><td class="muted">${r.selfApplied ? "Próprio jogador" : esc(r.by)}</td>
          <td class="num row-actions"><button type="button" class="icon-btn" title="Editar prazo" data-editr="${r.id}">${ICON.edit}</button>${CA.isAdmin() ? `<button type="button" class="icon-btn" title="Retirar" data-revoke="${r.id}">${ICON.check}</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div></div>` : `<div class="dashed" style="margin-top:14px">Nenhuma restrição em vigor.</div>`;
    const history = hist.length ? `<div class="sec-cap">Histórico de proteção</div><ul class="tl">${hist.slice(0, 40).map((h) => `<li class="t-${h.tone === "red" ? "red" : h.tone === "green" ? "green" : "blue"}"><b>${esc(h.label)}</b><small>${CA.fdt(h.at)} · ${esc(h.by)}${h.note ? " — " + esc(h.note) : ""}</small></li>`).join("")}</ul>` : "";
    return cards
      + `<div style="margin:16px 0;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="op-btn red" data-addrestr>${ICON.ban}Aplicar restrição</button></div>`
      + activeList + history;
  }
  function protCard(title, state, tone, desc) {
    return `<div class="prot-card on-${tone === "green" ? "green" : "red"}"><div class="p-t">${tone === "green" ? ICON.check : ICON.warn} ${esc(title)}</div><p>${esc(desc)}</p><span class="state-pill ${tone === "green" ? "green" : "red"}">${esc(state)}</span></div>`;
  }
  function wireProtection() {
    const el = tabEl();
    $("[data-addrestr]", el).onclick = addRestriction;
    $$("[data-editr]", el).forEach((b) => (b.onclick = () => editRestriction(b.dataset.editr)));
    $$("[data-revoke]", el).forEach((b) => (b.onclick = () => revokeRestriction(b.dataset.revoke)));
  }

  /* ── aba: Segurança ── */
  function tabSecurity(d) {
    const devices = new Set(d.accesses.map((a) => a.device)).size;
    const ips = d.ips.length, shared = d.sharedIps.length;
    const kgrid = `<div class="kgrid">
      ${CA.kpi({ label: "Acessos recentes", value: int(d.accesses.length), icon: ICON.person, tone: "green" })}
      ${CA.kpi({ label: "Dispositivos", value: int(devices), icon: ICON.shield, tone: "purple" })}
      ${CA.kpi({ label: "IPs distintos", value: int(ips), icon: ICON.chart, tone: "orange" })}
      ${CA.kpi({ label: "IPs compartilhados", value: int(shared), sub: shared ? "com outras contas" : "nenhum", icon: ICON.warn, tone: shared ? "red" : "gray" })}
    </div>`;
    const sessions = d.accesses.length ? `<div class="op-table"><div class="tscroll"><table><thead><tr><th>Data/Hora</th><th>Evento</th><th>Dispositivo</th><th>IP</th></tr></thead><tbody>
      ${d.accesses.map((a) => `<tr><td>${CA.fdt(a.at)}<br><span class="muted" style="font-size:11px">${CA.rel(a.at)}</span></td><td>${CA.badge(a.kind === "login" ? "Login" : a.kind === "register" ? "Cadastro" : "Sessão", "gray")}</td><td>${esc(a.device)}</td><td><span style="font-family:monospace;font-size:12px">${esc(a.ip || "—")}</span></td></tr>`).join("")}
    </tbody></table></div></div>` : `<div class="op-table">${CA.empty("Sem acessos registrados", "")}</div>`;
    const sharedBlk = shared ? `<div class="sec-cap">IPs compartilhados com outras contas</div>
      <div class="op-table"><div class="tscroll"><table><thead><tr><th>IP</th><th>Outra conta</th></tr></thead><tbody>
      ${d.sharedIps.map((s) => `<tr><td><span style="font-family:monospace;font-size:12px">${esc(s.ip)}</span></td><td><button type="button" class="link-pill" data-open-user="${esc(s.userId)}">${esc(s.email)}</button></td></tr>`).join("")}
      </tbody></table></div></div>` : "";
    return kgrid + `<div class="sec-cap">Acessos</div>` + sessions + sharedBlk
      + (!d.mfa.available ? `<p class="op-note" style="margin-top:12px">Autenticação em duas etapas (MFA) ainda não disponível nesta plataforma.</p>` : "");
  }

  /* ── aba: Timeline ── */
  let tlFilter = "30d";
  function tabTimeline(d) {
    const now = Date.now(), days = { today: 1, "7d": 7, "30d": 30, "90d": 90, all: 99999 }[tlFilter];
    const since = now - days * 86400000;
    const items = d.items.filter((e) => tlFilter === "all" || new Date(e.at).getTime() >= since);
    const crit = items.filter((e) => e.tone === "red").length, imp = items.filter((e) => e.tone === "blue").length;
    const kgrid = `<div class="kgrid">
      ${CA.kpi({ label: "Eventos filtrados", value: int(items.length), icon: ICON.chart, tone: "green" })}
      ${CA.kpi({ label: "Críticos", value: int(crit), sub: "pedem atenção", icon: ICON.warn, tone: crit ? "red" : "gray" })}
      ${CA.kpi({ label: "Ações da equipe", value: int(imp), icon: ICON.shield, tone: "purple" })}
      ${CA.kpi({ label: "Última atividade", value: items[0] ? CA.rel(items[0].at) : "—", icon: ICON.person, tone: "orange" })}
    </div>`;
    const chips = `<div class="op-toolbar"><div class="op-seg inline">${[["today", "Hoje"], ["7d", "7 dias"], ["30d", "30 dias"], ["90d", "90 dias"], ["all", "Tudo"]].map(([v, l]) => `<button type="button" data-tl="${v}" class="${tlFilter === v ? "on" : ""}">${l}</button>`).join("")}</div></div>`;
    if (!items.length) return kgrid + chips + `<div class="op-table">${CA.empty("Sem eventos no período", "")}</div>`;
    const feed = items.slice(0, 200).map((e) => `<li class="t-${e.tone === "red" ? "red" : e.tone === "green" ? "green" : e.tone === "blue" ? "blue" : "orange"}">
      <b>${esc(e.label)}</b> ${CA.badge(e.group, "gray")}<small>${CA.fdt(e.at)}${e.by ? " · " + esc(e.by) : ""}${e.detail ? " — " + esc(e.detail) : ""}</small></li>`).join("");
    return kgrid + chips + `<div class="box"><ul class="tl">${feed}</ul></div>`;
  }
  function wireTimeline(d) {
    $$("[data-tl]", tabEl()).forEach((b) => (b.onclick = () => { tlFilter = b.dataset.tl; tabEl().innerHTML = tabTimeline(d); wireTimeline(d); }));
  }

  /* ── aba: Cashback (sem sistema de cashback — estado vazio fiel) ── */
  function tabCashback() {
    return `<div class="kgrid">
      ${CA.kpi({ label: "Saldo de cashback", value: money(0), sub: "sem carteira de cashback", icon: ICON.coins, tone: "green" })}
      ${CA.kpi({ label: "Total creditado", value: money(0), icon: ICON.arrowDown, tone: "purple" })}
      ${CA.kpi({ label: "Total resgatado", value: money(0), icon: ICON.arrowUp, tone: "orange" })}
      ${CA.kpi({ label: "Saúde dos pagamentos", value: "Operacional", icon: ICON.check, tone: "green" })}
    </div><div class="op-table">${CA.empty("Nenhuma operação de cashback", "Este jogador ainda não tem histórico de cashback.")}</div>`;
  }

  /* ── aba: Bônus (incentivos com rollover — admin → Incentivos) ── */
  function tabBonus(d) {
    const active = d.rows.find((r) => r.status === "ACTIVE");
    const bonus = active ? active.bonusBalance : 0;
    const converted = d.rows.reduce((s, r) => s + (r.converted || 0), 0);
    return `<div class="kgrid">
      ${CA.kpi({ label: "Incentivo em andamento", value: active ? "1" : "0", sub: active ? `${active.campaign.name}` : "nenhum", icon: ICON.coins, tone: "green" })}
      ${CA.kpi({ label: "Bônus ativo total", value: money(bonus), sub: active ? `rollover ${money(active.rolloverDone)} de ${money(active.rolloverTarget)}` : "sem saldo de bônus", icon: ICON.scale, tone: "purple", vclass: bonus ? "v-green" : "" })}
      ${CA.kpi({ label: "Total de incentivos", value: int(d.total), sub: `${int(d.counts.COMPLETED || 0)} cumpridos`, icon: ICON.chart, tone: "orange" })}
      ${CA.kpi({ label: "Virou saldo real", value: money(converted), sub: "rollover cumprido", icon: ICON.arrowDown, tone: "green", vclass: converted ? "v-green" : "" })}
    </div>
    <div class="sec-cap">Incentivos ${CA.isFinance() ? `<button type="button" class="op-btn sm green" data-grant-inc style="margin-left:auto">${ICON.plus}Conceder incentivo</button>` : ""}</div>
    ${CA.incentivesTable ? CA.incentivesTable(d, { showUser: false }) : ""}
    <div class="sec-cap">Free spins manuais</div><div class="op-table">${CA.empty("Nenhuma adição manual de free spins", "As rodadas grátis da PlayFivers ficam em Cassino → PlayFivers.")}</div>`;
  }
  function wireBonus() {
    const root = tabEl(); if (!root) return;
    if (CA.wireIncentivesTable) CA.wireIncentivesTable(root, () => renderTab("bonus"));
    const b = root.querySelector("[data-grant-inc]");
    if (b) b.onclick = () => CA.grantIncentive({ user: { id: fid, label: `${D.user.name || D.user.email} · ${D.user.email}` }, onDone: () => renderTab("bonus") });
  }

  /* ── barra de intervalo por aba ── */
  function toolbarRange(tab) {
    return `<div class="op-toolbar"><div class="op-spacer"></div>${CA.rangeBtn(rng(tab))}</div>`;
  }
  function wireTabRange(tab) {
    CA.wireRange(tabEl(), rng(tab), () => renderTab(activeTab));
    CA.wireChart(tabEl());
  }
  function wireLedger() {
    wireTabRange("ledger");
    $$("[data-cat]", tabEl()).forEach((b) => (b.onclick = () => { rng("ledger").category = b.dataset.cat; renderTab("ledger"); }));
    CA.wirePager(tabEl(), () => {}, () => {});
  }

  function refresh() { loadUser(fid); }

  /* ═════════════ ações da ficha ═════════════ */
  function openActions(btn) {
    const u = D.user;
    const items = [
      ["adjust", "Ajustar saldo", ICON.scale],
      [u.isTest ? "untest" : "test", u.isTest ? "Remover marca de teste" : "Marcar como teste", ICON.shield],
    ];
    const old = document.getElementById("acts_menu"); if (old) { old.remove(); return; }
    const m = document.createElement("div"); m.id = "acts_menu"; m.className = "flyout"; m.style.minWidth = "210px";
    m.innerHTML = items.map(([a, l]) => `<button type="button" data-a="${a}">${esc(l)}</button>`).join("");
    document.body.append(m);
    const r = btn.getBoundingClientRect();
    m.style.left = Math.min(r.left, innerWidth - 230) + "px"; m.style.top = r.bottom + 6 + "px";
    const close = () => m.remove();
    m.querySelectorAll("button").forEach((b) => (b.onclick = () => { close(); act(b.dataset.a); }));
    setTimeout(() => document.addEventListener("click", function h(e) { if (!m.contains(e.target) && e.target !== btn) { close(); document.removeEventListener("click", h); } }), 0);
  }
  function act(a) {
    if (a === "adjust") return adjustBalance();
    if (a === "test" || a === "untest") return toggleTest(a === "test");
  }

  function adjustBalance() {
    const bg = CA.modal({
      title: "Ajustar saldo",
      body: `<p class="op-note" style="margin:0 0 10px">Saldo atual: <b style="color:var(--text)">${money(D.wallet.balance)}</b>. Use valor negativo para debitar.</p>
             ${CA.field("Valor (R$)", CA.num("amount", { value: "", step: "0.01", min: "-1000000", ph: "ex.: 50 ou -50" }))}
             ${CA.field("Motivo", CA.area("reason", { ph: "Fica no histórico e na auditoria." }))}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Aplicar ajuste</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const f = CA.readForm(bg), amount = Number(f.amount);
      if (!amount) { $("[data-msg]", bg).textContent = "Informe um valor diferente de zero."; return; }
      if (!f.reason || f.reason.trim().length < 3) { $("[data-msg]", bg).textContent = "Explique o motivo."; return; }
      try { await CA.api(`/admin/users/${fid}/adjust`, { method: "POST", body: JSON.stringify({ amount, reason: f.reason.trim() }) }); CA.closeModal(); CA.toast("Saldo ajustado"); refresh(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }
  async function toggleTest(makeTest) {
    await CA.call(`/admin/ops/users/${fid}/test`, { method: "PATCH", body: JSON.stringify({ isTest: makeTest }) });
    CA.toast(makeTest ? "Marcada como teste" : "Marca de teste removida"); refresh();
  }

  function blockUser() {
    const bg = CA.modal({
      title: "Bloquear usuário",
      body: `<p class="op-note" style="margin:0 0 10px">Bloqueio total: o jogador não consegue entrar, depositar nem apostar.</p>${CA.field("Motivo", CA.area("reason", { ph: "Motivo do bloqueio (fica no histórico)." }))}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn red" data-yes>Bloquear</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const reason = $("[data-f=reason]", bg).value.trim();
      if (reason.length < 3) { $("[data-msg]", bg).textContent = "Explique o motivo."; return; }
      try { await CA.api(`/admin/ops/users/${fid}/restrictions`, { method: "POST", body: JSON.stringify({ kind: "MANUAL_BLOCK", reason }) }); CA.closeModal(); CA.toast("Usuário bloqueado"); refresh(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }
  async function unblockUser() {
    const block = D.protection.restrictions.find((r) => r.active && r.scope === "TOTAL");
    if (!block) { CA.toast("Nenhum bloqueio ativo", "err"); return; }
    if (!CA.isAdmin()) { CA.toast("Só administrador pode desbloquear", "err"); return; }
    const bg = CA.modal({
      title: "Desbloquear usuário",
      body: CA.field("Observação", CA.area("note", { ph: "Por que está retirando o bloqueio?" })),
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Desbloquear</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const note = $("[data-f=note]", bg).value.trim();
      if (note.length < 3) { $("[data-msg]", bg).textContent = "Explique o motivo."; return; }
      try { await CA.api(`/admin/ops/restrictions/${block.id}/revoke`, { method: "POST", body: JSON.stringify({ note }) }); CA.closeModal(); CA.toast("Usuário desbloqueado"); refresh(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }

  function addRestriction() {
    const bg = CA.modal({
      title: "Aplicar restrição",
      body: `${CA.field("Tipo", CA.sel("kind", [["SELF_EXCLUSION", "Autoexclusão"], ["SUSPENSION", "Suspensão"], ["MANUAL_BLOCK", "Bloqueio manual (total)"]], "SUSPENSION"))}
             ${CA.field("Abrangência", CA.sel("scope", [["GAMING", "Apenas jogo (deposita/aposta)"], ["TOTAL", "Total (bloqueia a conta)"]], "GAMING"))}
             ${CA.field("Prazo em dias (vazio = sem prazo)", `<input type="number" data-f="days" min="1" max="3650" placeholder="ex.: 30" />`)}
             ${CA.field("Motivo", CA.area("reason", { ph: "Motivo da restrição." }))}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn red" data-yes>Aplicar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const f = CA.readForm(bg);
      if (!f.reason || f.reason.trim().length < 3) { $("[data-msg]", bg).textContent = "Explique o motivo."; return; }
      const body = { kind: f.kind, scope: f.scope, reason: f.reason.trim(), days: f.days ? Number(f.days) : null };
      try { await CA.api(`/admin/ops/users/${fid}/restrictions`, { method: "POST", body: JSON.stringify(body) }); CA.closeModal(); CA.toast("Restrição aplicada"); refresh(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }
  function editRestriction(id) {
    const bg = CA.modal({
      title: "Editar prazo",
      body: CA.field("Novo prazo em dias a partir de agora (vazio = sem prazo)", `<input type="number" data-f="days" min="1" max="3650" placeholder="ex.: 15" />`),
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Salvar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const v = $("[data-f=days]", bg).value;
      try { await CA.api(`/admin/ops/restrictions/${id}`, { method: "PATCH", body: JSON.stringify({ days: v ? Number(v) : null }) }); CA.closeModal(); CA.toast("Prazo atualizado"); refresh(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }
  function revokeRestriction(id) {
    if (!CA.isAdmin()) { CA.toast("Só administrador pode retirar", "err"); return; }
    const bg = CA.modal({
      title: "Retirar restrição",
      body: CA.field("Observação", CA.area("note", { ph: "Por que está retirando?" })),
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Retirar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const note = $("[data-f=note]", bg).value.trim();
      if (note.length < 3) { $("[data-msg]", bg).textContent = "Explique o motivo."; return; }
      try { await CA.api(`/admin/ops/restrictions/${id}/revoke`, { method: "POST", body: JSON.stringify({ note }) }); CA.closeModal(); CA.toast("Restrição retirada"); refresh(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }
  function addRgLimit() {
    const bg = CA.modal({
      title: "Adicionar limite de jogo responsável",
      body: `${CA.field("Tipo", CA.sel("kind", [["DEPOSIT", "Depósito"], ["BET", "Aposta"], ["LOSS", "Perda"], ["SESSION", "Sessão"]], "DEPOSIT"))}
             ${CA.field("Período", CA.sel("period", [["DAY", "Diário"], ["WEEK", "Semanal"], ["MONTH", "Mensal"]], "DAY"))}
             ${CA.field("Valor (R$)", CA.num("amount", { value: "", min: "0" }))}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Salvar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const f = CA.readForm(bg), amount = Number(f.amount);
      if (!(amount > 0)) { $("[data-msg]", bg).textContent = "Informe um valor maior que zero."; return; }
      try { await CA.api(`/admin/ops/users/${fid}/limits`, { method: "POST", body: JSON.stringify({ kind: f.kind, period: f.period, amount }) }); CA.closeModal(); CA.toast("Limite salvo"); refresh(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }
  function setWithdrawLimits() {
    const i = D.withdrawLimits.individual || {};
    const bg = CA.modal({
      title: "Limite de saque individual",
      body: `<p class="op-note" style="margin:0 0 10px">Deixe em branco para herdar o limite padrão da casa.</p>
             ${CA.field("Máximo por saque (R$)", CA.num("maxPerWithdrawal", { value: i.maxPerWithdrawal ?? "", min: "0" }))}
             ${CA.field("Máximo diário (R$)", CA.num("dailyAmount", { value: i.dailyAmount ?? "", min: "0" }))}
             ${CA.field("Máximo de saques por dia", `<input type="number" data-f="dailyCount" min="1" max="1000" value="${i.dailyCount ?? ""}" />`)}
             ${CA.field("Intervalo mínimo entre saques (min)", `<input type="number" data-f="minIntervalMin" min="1" max="10080" value="${i.minIntervalMin ?? ""}" />`)}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Salvar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const f = CA.readForm(bg);
      const n = (v) => (v === "" || v == null ? null : Number(v));
      const body = { maxPerWithdrawal: n(f.maxPerWithdrawal), dailyAmount: n(f.dailyAmount), dailyCount: n(f.dailyCount), minIntervalMin: n(f.minIntervalMin) };
      try { await CA.api(`/admin/ops/users/${fid}/withdraw-limits`, { method: "PUT", body: JSON.stringify(body) }); CA.closeModal(); CA.toast("Limite individual salvo"); refresh(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }

  CA.registerViews({ users: loadList, user: (id) => loadUser(id) });
})();
