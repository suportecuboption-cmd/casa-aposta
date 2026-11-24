/* ══════════════ Operação — Ranking, Gestão de Risco, Bloqueios e Ajustes (modelo Axio) ══════════════ */
(function () {
  "use strict";
  const CA = window.CA, esc = CA.escA, money = CA.money, int = CA.int, ICON = CA.ICON;
  const $ = CA.$, $$ = CA.$$;
  const pct = (v, d = 1) => (v == null ? "—" : (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%");

  /* ═════════════ Ranking Operacional ═════════════ */
  const rk = { board: "players", metric: "balance", by: "game", order: "desc", ...CA.defaultRange() };

  async function loadRanking() {
    const seq = CA.bumpSeq();
    let d;
    try {
      d = rk.board === "players"
        ? await CA.api(`/admin/ops/ranking/players${CA.qs({ metric: rk.metric, from: rk.from, to: rk.to })}`)
        : await CA.api(`/admin/ops/ranking/games${CA.qs({ by: rk.by, order: rk.order, from: rk.from, to: rk.to })}`);
    } catch (e) { if (seq === CA.seq()) CA.render(CA.opHead({ title: "Ranking Operacional", icon: ICON.trophy }) + CA.empty("Não foi possível carregar", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    paintRanking(d);
  }

  function paintRanking(d) {
    const head = CA.opHead({
      title: "Ranking Operacional", sub: "Quem mais movimenta a operação e quais jogos trazem mais resultado.", icon: ICON.trophy,
      actions: `<button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    }) + `<div class="op-seg">
        <button type="button" data-board="players" class="${rk.board === "players" ? "on" : ""}">${ICON.person}Jogadores</button>
        <button type="button" data-board="games" class="${rk.board === "games" ? "on" : ""}">${ICON.dice || ICON.chart}Jogos & Provedores</button>
      </div>`;
    CA.render(head + (rk.board === "players" ? boardPlayers(d) : boardGames(d)));
    const root = CA.view();
    $("[data-reload]", root).onclick = loadRanking;
    $$("[data-board]", root).forEach((b) => (b.onclick = () => { rk.board = b.dataset.board; loadRanking(); }));
    if (rk.board === "players") {
      $$("[data-metric]", root).forEach((b) => (b.onclick = () => { rk.metric = b.dataset.metric; loadRanking(); }));
    } else {
      $$("[data-by]", root).forEach((b) => (b.onclick = () => { rk.by = b.dataset.by; loadRanking(); }));
      $$("[data-order]", root).forEach((b) => (b.onclick = () => { rk.order = b.dataset.order; loadRanking(); }));
    }
    if (rk.metric !== "balance" || rk.board === "games") CA.wireRange(root, rk, loadRanking);
  }

  function boardPlayers(d) {
    const metricLabel = { balance: "Saldo em carteira", deposits: "Depósitos pagos", withdrawals: "Saques pagos" }[d.metric];
    const tabs = `<div class="op-toolbar">
      <div class="op-seg inline">${[["balance", "Saldo"], ["deposits", "Depósitos"], ["withdrawals", "Saques"]].map(([v, l]) => `<button type="button" data-metric="${v}" class="${d.metric === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="op-spacer"></div>${d.metric !== "balance" ? CA.rangeBtn(rk) : ""}</div>`;
    if (!d.items.length) return tabs + `<div class="op-table">${CA.empty("Sem dados", "Nenhum jogador neste recorte.")}</div>`;
    const top3 = d.items.slice(0, 3), rest = d.items.slice(3);
    const order = [top3[1], top3[0], top3[2]]; // prata, ouro, bronze
    const medal = ["silver", "gold", "bronze"];
    const podium = `<div class="podium">${order.map((u, i) => u ? `<div class="pod ${medal[i]}">
        <div class="p-av">${esc(CA.initials(u.name))}</div><div class="p-mail">${esc(u.email)}</div>
        <div class="p-block"><span class="crown">${medal[i] === "gold" ? "👑" : medal[i] === "silver" ? "🥈" : "🥉"}</span><b>${money(u.value)}</b><span>${esc(metricLabel)}</span></div>
        ${u.count != null ? `<div class="p-at">${int(u.count)} ${d.metric === "deposits" ? "depósitos" : "saques"}</div>` : u.at ? `<div class="p-at">${CA.rel(u.at)}</div>` : ""}
      </div>` : `<div class="pod"></div>`).join("")}</div>`;
    const agg = `<div class="agg-row"><div class="ag"><div><span>Total do ranking</span><b>${money(d.aggregate)}</b></div></div><span class="upd">atualizado ${CA.rel(d.updatedAt)}</span></div>`;
    const list = rest.length ? `<div class="op-table"><div class="tscroll"><table><thead><tr><th>#</th><th>Jogador</th><th class="num">${esc(metricLabel)}</th>${d.metric !== "balance" ? '<th class="num">Qtde</th>' : ""}<th>Quando</th></tr></thead><tbody>
      ${rest.map((u) => `<tr class="click" data-open-user="${u.userId}"><td><span class="rank-n">${u.pos}</span></td><td>${CA.userCell({ id: u.userId, name: u.name, email: u.email }, { open: false })}</td><td class="num"><b>${money(u.value)}</b></td>${d.metric !== "balance" ? `<td class="num">${int(u.count)}</td>` : ""}<td class="muted">${u.at ? CA.rel(u.at) : "—"}</td></tr>`).join("")}
    </tbody></table></div></div>` : "";
    return tabs + agg + podium + (list ? `<div class="sec-cap">4º em diante</div>` + list : "");
  }

  function boardGames(d) {
    const tabs = `<div class="op-toolbar">
      <div class="op-seg inline">${[["game", "Por jogo"], ["provider", "Por provedor"]].map(([v, l]) => `<button type="button" data-by="${v}" class="${rk.by === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="op-seg inline">${[["desc", "Maiores GGR"], ["asc", "Menores GGR"]].map(([v, l]) => `<button type="button" data-order="${v}" class="${rk.order === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="op-spacer"></div>${CA.rangeBtn(rk)}</div>`;
    const t = d.totals || {};
    const kpis = `<div class="kgrid three">
      ${CA.kpi({ label: "GGR total", value: money(t.ggr ?? 0), icon: ICON.coins, tone: "green", vclass: (t.ggr ?? 0) >= 0 ? "v-green" : "v-red" })}
      ${CA.kpi({ label: "Turnover", value: money(t.turnover ?? 0), icon: ICON.chart, tone: "gray" })}
      ${CA.kpi({ label: "Payout", value: money(t.payout ?? 0), icon: ICON.arrowUp, tone: "orange" })}
    </div>`;
    if (!d.items.length) return tabs + kpis + `<div class="op-table">${CA.empty("Sem atividade", "Nenhum jogo no período.")}</div>`;
    const isGame = rk.by === "game";
    const rows = d.items.map((r) => `<tr><td><span class="rank-n">${r.rank}</span></td>
      <td><div class="dt"><b>${esc(r.name)}</b>${isGame && r.provider ? `<span>${esc(r.provider)}</span>` : ""}</div></td>
      <td class="num">${money(r.turnover)}</td><td class="num">${money(r.payout)}</td>
      <td class="num ${r.ggr >= 0 ? "v-green" : "v-red"}"><b>${money(r.ggr)}</b></td>
      <td class="num">${r.rounds != null ? int(r.rounds) : "—"}</td></tr>`).join("");
    return tabs + kpis + `<div class="op-table"><div class="tscroll"><table><thead><tr><th>#</th><th>${isGame ? "Jogo" : "Provedor"}</th><th class="num">Turnover</th><th class="num">Payout</th><th class="num">GGR</th><th class="num">Rodadas</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  /* ═════════════ Gestão de Risco ═════════════ */
  const risk = { scope: "all", under: "overview", provider: "", game: "", sort: "net", dir: "desc", page: 1, size: 25, ...CA.defaultRange() };

  async function loadRisk() {
    const seq = CA.bumpSeq();
    let d;
    try {
      if (risk.under === "overview") d = await CA.api(`/admin/ops/risk${CA.qs({ scope: risk.scope, from: risk.from, to: risk.to, provider: risk.provider, game: risk.game })}`);
      else if (risk.under === "results") d = await CA.api(`/admin/ops/risk/results${CA.qs({ scope: risk.scope, from: risk.from, to: risk.to, provider: risk.provider, game: risk.game, sort: risk.sort, dir: risk.dir, page: risk.page, size: risk.size })}`);
      else d = await CA.api(`/admin/ops/risk/scores${CA.qs({ scope: risk.scope, from: risk.from, to: risk.to })}`);
    } catch (e) { if (seq === CA.seq()) CA.render(CA.opHead({ title: "Gestão de Risco", icon: ICON.shield }) + CA.empty("Não foi possível carregar", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    paintRisk(d);
  }

  function paintRisk(d) {
    const head = CA.opHead({
      title: "Gestão de Risco", sub: "Exposição da casa por jogador, jogo e provedor no período.", icon: ICON.shield,
      actions: `${CA.isAdmin() ? `<button type="button" class="op-btn" data-alert>${ICON.warn}Configurar alerta</button>` : ""}<button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    })
      + `<div class="op-seg">${[["all", "Geral"], ["casino", "Cassino"], ["sports", "Esporte"]].map(([v, l]) => `<button type="button" data-scope="${v}" class="${risk.scope === v ? "on" : ""}">${l}</button>`).join("")}</div>`
      + `<div class="under-tabs">${[["overview", "Visão Geral"], ["results", "Resultado dos Usuários"], ["scores", "Score de Risco"]].map(([v, l]) => `<button type="button" data-under="${v}" class="${risk.under === v ? "on" : ""}">${l}</button>`).join("")}</div>`
      + `<div class="op-toolbar"><div class="op-spacer"></div>${CA.rangeBtn(risk)}</div>`;
    let body = "";
    if (risk.under === "overview") body = riskOverview(d);
    else if (risk.under === "results") body = riskResults(d);
    else body = riskScores(d);
    CA.render(head + body);
    const root = CA.view();
    $("[data-reload]", root).onclick = loadRisk;
    const al = $("[data-alert]", root); if (al) al.onclick = () => configAlert(d.alertConfig);
    $$("[data-scope]", root).forEach((b) => (b.onclick = () => { risk.scope = b.dataset.scope; risk.provider = ""; risk.game = ""; risk.page = 1; loadRisk(); }));
    $$("[data-under]", root).forEach((b) => (b.onclick = () => { risk.under = b.dataset.under; risk.page = 1; loadRisk(); }));
    CA.wireRange(root, risk, () => { risk.page = 1; loadRisk(); });
    if (risk.under === "overview") wireOverview(d);
    if (risk.under === "results") CA.wirePager(root, (p) => { risk.page = p; loadRisk(); }, (sz) => { risk.size = sz; risk.page = 1; loadRisk(); });
  }

  function riskOverview(d) {
    const k = d.kpis;
    const kpis = `<div class="kgrid">
      ${CA.kpi({ label: "Ganhos dos vencedores", value: money(k.winnersTotal), sub: int(k.positiveUsers) + " no positivo", icon: ICON.warn, tone: "red" })}
      ${CA.kpi({ label: "Resultado dos jogadores", value: money(k.playersResult), sub: "positivo = casa perdeu", icon: ICON.scale, tone: k.playersResult > 0 ? "red" : "green", vclass: k.playersResult > 0 ? "v-red" : "v-green" })}
      ${CA.kpi({ label: "Jogadores no período", value: int(k.totalUsers), sub: int(k.positiveUsers) + " ganhando", icon: ICON.person, tone: "purple" })}
      ${CA.kpi({ label: "RTP médio", value: pct(k.avgRtp), sub: "retorno ao jogador", icon: ICON.chart, tone: "orange" })}
    </div>`;
    const filters = (d.providers && d.providers.length) ? `<div class="op-toolbar">
      <select data-provider><option value="">Todos os provedores</option>${d.providers.map((p) => `<option value="${esc(p.id)}" ${risk.provider === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <select data-game><option value="">Todos os jogos</option>${(d.games || []).map((g) => `<option value="${esc(g.id)}" ${risk.game === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
    </div>` : "";
    const alertBox = d.alertConfig && d.alertConfig.bigWinAmount != null
      ? `<div class="alert-banner ${d.alerts.length ? "" : "warn"}"><div class="ab-ic">${ICON.warn}</div><div><b>Alerta de grande prêmio</b> ${d.alerts.length ? `${d.alerts.length} jogador(es) acima de ${money(d.alertConfig.bigWinAmount)} no período.` : `nenhum jogador passou de ${money(d.alertConfig.bigWinAmount)}.`}</div></div>`
      : "";
    const list = (title, arr, tone) => `<div class="box"><div class="box-h"><b>${title}</b></div>${arr.length ? `<ul class="rlist">${arr.map((u, i) => `<li><span class="r-n">${i + 1}</span>
        <div class="r-u"><b>${esc(u.name)}</b><span>${esc(u.main)} · ${int(u.bets)} apostas · RTP ${pct(u.rtp)}</span></div>
        <span class="r-v ${tone === "red" ? "v-red" : "v-green"}">${money(u.net)}</span>
        <button type="button" class="r-go" data-open-user="${u.userId}">ver ›</button></li>`).join("")}</ul>` : CA.empty("Sem jogadores", "")}</div>`;
    return kpis + alertBox + filters + `<div class="g2">${list("Maiores ganhadores (risco p/ casa)", d.winners, "red")}${list("Maiores perdedores", d.losers, "green")}</div>`;
  }
  function wireOverview(d) {
    const root = CA.view();
    const p = $("[data-provider]", root); if (p) p.onchange = () => { risk.provider = p.value; risk.game = ""; loadRisk(); };
    const g = $("[data-game]", root); if (g) g.onchange = () => { risk.game = g.value; loadRisk(); };
  }

  function riskResults(d) {
    if (!d.items.length) return `<div class="op-table">${CA.empty("Sem resultados", "Nenhum jogador movimentou no período.")}</div>`;
    const sortBtn = (key, label) => `<button type="button" class="th-sort" data-sort="${key}">${label}${risk.sort === key ? (risk.dir === "desc" ? " ↓" : " ↑") : ""}</button>`;
    const rows = d.items.map((u) => `<tr class="click" data-open-user="${u.userId}">
      <td>${CA.userCell({ id: u.userId, name: u.name, email: u.email }, { open: false })}</td>
      <td class="num">${int(u.bets)}</td><td class="num">${money(u.turnover)}</td><td class="num">${money(u.payout)}</td>
      <td class="num ${u.net >= 0 ? "v-red" : "v-green"}"><b>${money(u.net)}</b></td>
      <td class="num">${pct(u.rtp)}</td><td class="muted">${esc(u.main)}</td></tr>`).join("");
    const tbl = `<div class="op-table"><div class="tscroll"><table><thead><tr><th>Jogador</th><th class="num">Apostas</th><th class="num">${sortBtn("turnover", "Turnover")}</th><th class="num">Payout</th><th class="num">${sortBtn("net", "Resultado")}</th><th class="num">RTP</th><th>Principal</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    setTimeout(() => $$("[data-sort]", CA.view()).forEach((b) => (b.onclick = () => { const k = b.dataset.sort; if (risk.sort === k) risk.dir = risk.dir === "desc" ? "asc" : "desc"; else { risk.sort = k; risk.dir = "desc"; } risk.page = 1; loadRisk(); })), 0);
    return tbl + (d.total > d.size ? CA.pager(d.total, d.page, d.size) : "");
  }

  function riskScores(d) {
    if (!d.items.length) return `<div class="op-table">${CA.empty("Sem scores", "Nenhum jogador com atividade no período.")}</div>`;
    const lvlTone = (l) => (l === "Alto" ? "red" : l === "Médio" ? "orange" : "green");
    const rows = d.items.map((u) => `<tr class="click" data-open-user="${u.userId}">
      <td>${CA.userCell({ id: u.userId, name: u.name, email: u.email }, { open: false })}</td>
      <td><b style="font-size:16px">${Math.round(u.risk.score)}</b></td>
      <td>${CA.badge(u.risk.level, lvlTone(u.risk.level))}</td>
      <td class="num">${money(u.turnover)}</td>
      <td class="num ${u.net >= 0 ? "v-red" : "v-green"}">${money(u.net)}</td></tr>`).join("");
    return `<div class="op-table"><div class="tscroll"><table><thead><tr><th>Jogador</th><th>Score</th><th>Nível</th><th class="num">Turnover</th><th class="num">Resultado</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  function configAlert(cfg) {
    const bg = CA.modal({
      title: "Configurar alerta de risco",
      body: `<p class="op-note" style="margin:0 0 10px">Avisa quando um jogador ganha acima do valor no período. Deixe em branco para desligar.</p>
             ${CA.field("Ganho acima de (R$)", CA.num("bigWinAmount", { value: cfg && cfg.bigWinAmount != null ? cfg.bigWinAmount : "", min: "0" }))}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Salvar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const v = $("[data-f=bigWinAmount]", bg).value;
      try { await CA.api("/admin/ops/risk/alerts", { method: "PUT", body: JSON.stringify({ bigWinAmount: v === "" ? null : Number(v) }) }); CA.closeModal(); CA.toast("Alerta salvo"); loadRisk(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }

  /* ═════════════ Bloqueios e Autoexclusões ═════════════ */
  const bk = { type: "all", action: "all", q: "", page: 1, size: 50, ...CA.defaultRange() };

  async function loadBlocks() {
    const seq = CA.bumpSeq();
    let d; try { d = await CA.api(`/admin/ops/restrictions${CA.qs(bk)}`); } catch (e) { if (seq === CA.seq()) CA.render(CA.opHead({ title: "Bloqueios e Autoexclusões", icon: ICON.ban }) + CA.empty("Não foi possível carregar", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    const k = d.kpis;
    const html = CA.opHead({
      title: "Bloqueios e Autoexclusões", sub: "Restrições aplicadas pela equipe e autoexclusões dos jogadores.", icon: ICON.ban,
      actions: `<button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    })
      + `<div class="kgrid">
        ${CA.kpi({ label: "Restrições no período", value: int(k.total), icon: ICON.ban, tone: "purple" })}
        ${CA.kpi({ label: "Autoexclusões", value: int(k.selfExclusions), sub: k.selfChanged ? int(k.selfChanged) + " alteradas" : "pelos jogadores", icon: ICON.shield, tone: "orange" })}
        ${CA.kpi({ label: "Bloqueios manuais", value: int(k.manualBlocks), sub: "pela equipe", icon: ICON.lock, tone: "red" })}
        ${CA.kpi({ label: "Suspensões", value: int(k.suspensions), sub: k.suspensionsChanged ? int(k.suspensionsChanged) + " alteradas" : "temporárias", icon: ICON.warn, tone: "gray" })}
      </div>`
      + `<div class="op-toolbar">
        <div class="op-search">${ICON.search}<input placeholder="Buscar por nome ou e-mail" value="${esc(bk.q)}" data-q /></div>
        <select data-type>${[["all", "Todos os tipos"], ["SELF_EXCLUSION", "Autoexclusão"], ["MANUAL_BLOCK", "Bloqueio manual"], ["SUSPENSION", "Suspensão"]].map(([v, l]) => `<option value="${v}" ${bk.type === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select data-action>${[["all", "Qualquer situação"], ["active", "Em vigor"], ["changed", "Alteradas"], ["revoked", "Retiradas"], ["expired", "Expiradas"]].map(([v, l]) => `<option value="${v}" ${bk.action === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${CA.rangeBtn(bk)}
      </div>`
      + blocksTable(d)
      + (d.total > d.size ? CA.pager(d.total, d.page, d.size) : "");
    CA.render(html);
    const root = CA.view();
    $("[data-reload]", root).onclick = loadBlocks;
    const q = $("[data-q]", root); let qt; q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { bk.q = q.value.trim(); bk.page = 1; loadBlocks(); }, 350); };
    $("[data-type]", root).onchange = (e) => { bk.type = e.target.value; bk.page = 1; loadBlocks(); };
    $("[data-action]", root).onchange = (e) => { bk.action = e.target.value; bk.page = 1; loadBlocks(); };
    CA.wireRange(root, bk, () => { bk.page = 1; loadBlocks(); });
    CA.wirePager(root, (p) => { bk.page = p; loadBlocks(); }, (sz) => { bk.size = sz; bk.page = 1; loadBlocks(); });
  }
  function blocksTable(d) {
    if (!d.items.length) return `<div class="op-table">${CA.empty("Nenhuma restrição", "Ajuste os filtros ou o período.")}</div>`;
    const stTone = (s) => (s === "Retirada" ? "green" : s === "Expirada" ? "gray" : "red");
    const kindTone = (k) => (k === "SELF_EXCLUSION" ? "orange" : k === "MANUAL_BLOCK" ? "red" : "gray");
    const rows = d.items.map((r) => `<tr class="click" data-open-user="${r.user.id}">
      <td>${CA.userCell(r.user, { open: false })}</td>
      <td>${CA.badge(r.kindPt, kindTone(r.kind))}</td>
      <td><div class="badge-stack">${CA.badge(r.status, stTone(r.status))}${r.changed ? CA.badge("alterada", "blue") : ""}</div></td>
      <td class="muted" style="max-width:220px">${esc(r.reason)}</td>
      <td class="muted">${esc(r.author)}</td>
      <td><div class="dt"><b>${CA.fdt(r.createdAt)}</b>${r.revokedAt ? `<span>retirada ${CA.fdt(r.revokedAt)}</span>` : r.endsAt ? `<span>até ${CA.fdate(r.endsAt)}</span>` : "<span>sem prazo</span>"}</div></td></tr>`).join("");
    return `<div class="op-table"><div class="tscroll"><table><thead><tr><th>Jogador</th><th>Tipo</th><th>Situação</th><th>Motivo</th><th>Aplicada por</th><th>Quando</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  /* ═════════════ Ajustes de saldo ═════════════ */
  const aj = { direction: "all", q: "", page: 1, size: 25, ...CA.defaultRange() };

  async function loadAdjustments() {
    const seq = CA.bumpSeq();
    let d; try { d = await CA.api(`/admin/ops/adjustments${CA.qs(aj)}`); } catch (e) { if (seq === CA.seq()) CA.render(CA.opHead({ title: "Ajustes de saldo", icon: ICON.scale }) + CA.empty("Não foi possível carregar", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    const k = d.kpis;
    const html = CA.opHead({
      title: "Ajustes de saldo", sub: "Créditos e débitos manuais feitos pela equipe nas carteiras.", icon: ICON.scale,
      actions: `<button type="button" class="op-btn green" data-new>${ICON.plus}Novo ajuste</button><button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    })
      + `<div class="kgrid">
        ${CA.kpi({ label: "Lançamentos", value: int(k.count), icon: ICON.scale, tone: "purple" })}
        ${CA.kpi({ label: "Creditado", value: money(k.added), sub: "entradas manuais", icon: ICON.arrowDown, tone: "green" })}
        ${CA.kpi({ label: "Debitado", value: money(k.subtracted), sub: "saídas manuais", icon: ICON.arrowUp, tone: "orange" })}
        ${CA.kpi({ label: "Saldo líquido", value: money(k.net), icon: ICON.coins, tone: k.net >= 0 ? "green" : "red", vclass: k.net >= 0 ? "v-green" : "v-red" })}
      </div>`
      + `<div class="op-toolbar">
        <div class="op-search">${ICON.search}<input placeholder="Buscar por jogador, e-mail ou ID" value="${esc(aj.q)}" data-q /></div>
        <select data-dir>${[["all", "Créditos e débitos"], ["credit", "Só créditos"], ["debit", "Só débitos"]].map(([v, l]) => `<option value="${v}" ${aj.direction === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${CA.rangeBtn(aj)}
      </div>`
      + adjTable(d)
      + (d.total > d.size ? CA.pager(d.total, d.page, d.size) : "");
    CA.render(html);
    const root = CA.view();
    $("[data-reload]", root).onclick = loadAdjustments;
    $("[data-new]", root).onclick = newAdjustment;
    const q = $("[data-q]", root); let qt; q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { aj.q = q.value.trim(); aj.page = 1; loadAdjustments(); }, 350); };
    $("[data-dir]", root).onchange = (e) => { aj.direction = e.target.value; aj.page = 1; loadAdjustments(); };
    CA.wireRange(root, aj, () => { aj.page = 1; loadAdjustments(); });
    CA.wirePager(root, (p) => { aj.page = p; loadAdjustments(); }, (sz) => { aj.size = sz; aj.page = 1; loadAdjustments(); });
  }
  function adjTable(d) {
    if (!d.items.length) return `<div class="op-table">${CA.empty("Nenhum ajuste", "Nenhum lançamento manual no período.")}</div>`;
    const rows = d.items.map((a) => `<tr class="click" data-open-user="${a.user.id}">
      <td>${CA.userCell(a.user, { open: false })}</td>
      <td class="num ${a.amount >= 0 ? "v-green" : "v-red"}"><b>${a.amount >= 0 ? "+" : ""}${money(a.amount)}</b></td>
      <td class="num">${money(a.balanceAfter)}</td>
      <td class="muted" style="max-width:240px">${esc(a.reason)}</td>
      <td class="muted">${esc(a.admin)}</td>
      <td>${CA.fdt(a.at)}</td></tr>`).join("");
    return `<div class="op-table"><div class="tscroll"><table><thead><tr><th>Jogador</th><th class="num">Valor</th><th class="num">Saldo após</th><th>Motivo</th><th>Responsável</th><th>Data</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  // Novo ajuste: busca o jogador por e-mail/nome, depois valor + motivo.
  function newAdjustment() {
    const bg = CA.modal({
      title: "Novo ajuste de saldo",
      body: `${CA.field("Jogador", `<input data-f="search" placeholder="Digite nome, e-mail ou ID e escolha" autocomplete="off" />`)}
             <div data-results style="margin:6px 0 4px"></div>
             <div data-picked hidden>
               <div class="mini" style="margin:8px 0"><span class="box-ic" style="--tone:var(--green);--tone-bg:rgba(34,197,94,.15)">${ICON.person}</span><div><span>Selecionado</span><b data-picked-name></b></div></div>
               ${CA.field("Valor (R$) — negativo para debitar", CA.num("amount", { value: "", step: "0.01", min: "-1000000", ph: "ex.: 50 ou -50" }))}
               ${CA.field("Motivo", CA.area("reason", { ph: "Fica no histórico e na auditoria." }))}
             </div>`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes disabled>Aplicar ajuste</button>`,
    });
    let picked = null;
    const results = $("[data-results]", bg), pickedBox = $("[data-picked]", bg), yes = $("[data-yes]", bg);
    const search = $("[data-f=search]", bg);
    let t;
    search.oninput = () => {
      clearTimeout(t); const term = search.value.trim();
      if (term.length < 2) { results.innerHTML = ""; return; }
      t = setTimeout(async () => {
        try {
          const d = await CA.api(`/admin/ops/users${CA.qs({ q: term, size: 6 })}`);
          results.innerHTML = d.items.length ? d.items.map((u) => `<button type="button" class="sn-item" data-pick="${u.id}" data-name="${esc(u.name)} · ${esc(u.email)}" style="width:100%;border:1px solid var(--line-2);margin-bottom:4px">${CA.avatar(u.name)}<span>${esc(u.name)} · <span class="muted">${esc(u.email)}</span></span></button>`).join("") : `<p class="op-note">Nenhum jogador encontrado.</p>`;
          $$("[data-pick]", results).forEach((b) => (b.onclick = () => { picked = b.dataset.pick; $("[data-picked-name]", bg).textContent = b.dataset.name; pickedBox.hidden = false; results.innerHTML = ""; search.value = b.dataset.name; yes.disabled = false; }));
        } catch (e) { results.innerHTML = `<p class="op-note">${esc(e.message)}</p>`; }
      }, 300);
    };
    $("[data-no]", bg).onclick = CA.closeModal;
    yes.onclick = async () => {
      if (!picked) return;
      const f = CA.readForm(bg), amount = Number(f.amount);
      if (!amount) { $("[data-msg]", bg).textContent = "Informe um valor diferente de zero."; return; }
      if (!f.reason || f.reason.trim().length < 3) { $("[data-msg]", bg).textContent = "Explique o motivo."; return; }
      try { await CA.api(`/admin/users/${picked}/adjust`, { method: "POST", body: JSON.stringify({ amount, reason: f.reason.trim() }) }); CA.closeModal(); CA.toast("Ajuste aplicado"); loadAdjustments(); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }

  CA.registerViews({ ranking: loadRanking, risk: loadRisk, blocks: loadBlocks, adjustments: loadAdjustments });
})();
