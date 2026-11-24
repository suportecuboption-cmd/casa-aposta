/* ══════════════ Incentivos — campanhas de bônus com rollover nos jogos escolhidos ══════════════
   Campanhas (criar, editar, conceder) e Jogadores (incentivos concedidos, rollover, extrato do bônus).
   Usa os utilitários do script principal via window.CA. A ficha do jogador (aba Bônus) reaproveita a tabela daqui. */
(function () {
  "use strict";
  const CA = window.CA, esc = CA.escA, money = CA.money, int = CA.int, ICON = CA.ICON;
  const $ = CA.$, $$ = CA.$$;
  // "1.000" e "1.000,50" (jeito brasileiro) ou "10.5": vira número; vazio = null; texto = NaN
  const num = (v) => {
    let t = String(v ?? "").trim().replace(/[R$%×x\s]/gi, "");
    if (t === "") return null;
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
    else if (!/^\d+\.\d{1,2}$/.test(t)) t = t.replace(/\./g, "");
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  // valor para o campo: número do banco vira "1.000,5"; o que o admin digitou (texto) volta igual; vazio fica vazio
  const val = (n) => (n == null || n === "" ? "" : typeof n === "string" ? n : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
  const GIFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="8" width="17" height="4.2" rx="1"/><path d="M5.2 12.2V19a1.5 1.5 0 001.5 1.5h10.6a1.5 1.5 0 001.5-1.5v-6.8M12 8v12.5"/><path d="M12 8H8.6a2.3 2.3 0 110-4.6C11 3.4 12 8 12 8zM12 8h3.4a2.3 2.3 0 100-4.6C13 3.4 12 8 12 8z"/></svg>';

  const TRIGGER = {
    DEPOSIT: ["No depósito", "O jogador escolhe o bônus ao depositar; o bônus entra quando o PIX cai."],
    CLAIM: ["Resgate pelo jogador", "Aparece em Incentivos no site e o jogador ativa com um toque."],
    MANUAL: ["Só a equipe concede", "Não aparece no site. A equipe concede aqui ou na ficha do jogador."],
  };
  const WINDOW = { OPEN: ["No ar", "green"], SCHEDULED: ["Agendada", "blue"], ENDED: ["Encerrada", "gray"], PAUSED: ["Desligada", "gray"] };
  const STATUS = { ACTIVE: ["Em andamento", "blue"], COMPLETED: ["Cumprido", "green"], EXPIRED: ["Expirou", "gray"], CANCELLED: ["Cancelado", "orange"], LOST: ["Bônus esgotado", "red"] };
  const LEDGER = { GRANT: "Bônus recebido", BET: "Aposta", WIN: "Prêmio", REFUND: "Estorno", CONVERT: "Virou saldo real", FORFEIT: "Retirado" };

  const bonusText = (c) => (c.trigger === "DEPOSIT" ? `${val(c.bonusPercent)}% do depósito${c.maxBonus ? ` até ${money(c.maxBonus)}` : ""}` : money(c.bonusFixed));
  const rolloverText = (c) => `${val(c.rolloverTimes)}× ${c.rolloverBase === "DEPOSIT_BONUS" ? "depósito + bônus" : "o bônus"}`;
  const thumb = (g) => `<span class="ly-th${g.imageUrl ? "" : " none"}" title="${esc(g.name)}">${g.imageUrl ? `<img src="${esc(g.imageUrl)}" alt="" loading="lazy">` : esc((g.name || "?").slice(0, 2).toUpperCase())}</span>`;
  const say = (el, text, ok = true) => { if (el) { el.style.color = ok ? "var(--accent)" : "#f85149"; el.textContent = text; } };
  const localInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /* ═════════════ Campanhas ═════════════ */
  let view = null, providers = [], editing = null;

  async function showCampaigns(arg) {
    const seq = CA.bumpSeq();
    editing = null;
    try {
      [view, providers] = await Promise.all([CA.api("/admin/incentives"), providers.length ? providers : CA.api("/admin/providers")]);
    } catch (e) {
      if (seq === CA.seq()) CA.render(CA.opHead({ title: "Incentivos", icon: GIFT }) + CA.empty("Não foi possível carregar", e.message, ICON.warn));
      return;
    }
    if (seq !== CA.seq()) return;
    renderCampaigns();
    if (arg === "new" && CA.isAdmin()) openEditor(null);
    else if (arg && arg !== "new") openEditor(arg);
  }

  function renderCampaigns(flash) {
    const s = view.summary;
    const list = view.campaigns.length ? view.campaigns.map(campaignCard).join("")
      : `<div class="op-table">${CA.empty("Nenhuma campanha ainda", "Crie a primeira: escolha o bônus, o rollover e os jogos em que ele vale.", GIFT)}</div>`;
    CA.render(CA.opHead({
      title: "Incentivos", sub: "Campanhas de bônus com rollover: o bônus só pode ser apostado nos jogos escolhidos e vira saldo real quando o jogador cumpre o rollover.", icon: GIFT,
      actions: `${CA.isAdmin() ? `<button type="button" class="op-btn green" data-new>${ICON.plus}Nova campanha</button>` : ""}<button type="button" class="op-btn" data-go="incentive-grants">${ICON.person}Jogadores</button><button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    })
      + `<div class="kgrid">
        ${CA.kpi({ label: "Incentivos em andamento", value: int(s.active), sub: "jogadores cumprindo rollover", icon: GIFT, tone: "purple" })}
        ${CA.kpi({ label: "Bônus em aberto", value: money(s.outstanding), sub: "saldo de bônus dos jogadores (fica em Bloqueado)", icon: ICON.lock, tone: "orange" })}
        ${CA.kpi({ label: "Concedido em 30 dias", value: money(s.granted30), sub: `${int(s.granted30N)} incentivos`, icon: ICON.arrowDown, tone: "green" })}
        ${CA.kpi({ label: "Virou saldo real (30 dias)", value: money(s.converted30), sub: `retirado ${money(s.forfeited30)} · custo do bônus`, icon: ICON.coins, tone: "green", vclass: s.converted30 ? "v-green" : "" })}
      </div>
      <div class="ic-how">
        <div><b>Saldo separado</b>O bônus fica num saldo de bônus. Dinheiro real é usado primeiro; o bônus cobre só o que faltar.</div>
        <div><b>Só nos jogos da campanha</b>O saldo de bônus só pode ser apostado nos jogos escolhidos. Nos outros jogos, só o real.</div>
        <div><b>Rollover</b>Toda aposta nos jogos da campanha soma. Enquanto não cumprir, o saque fica travado (o jogador pode cancelar o incentivo).</div>
        <div><b>Cumpriu</b>O saldo de bônus vira saldo real (até o teto, se houver). Venceu o prazo ou zerou o bônus, ele é retirado.</div>
      </div>
      <div id="ic_editor"></div>
      <div class="msg2" id="ic_msg" role="status"></div>
      ${list}`);
    const root = CA.view();
    if (flash) say($("#ic_msg", root), flash.text, flash.ok !== false);
    $("[data-reload]", root).onclick = () => showCampaigns();
    const nb = $("[data-new]", root); if (nb) nb.onclick = () => openEditor(null);
    $$("[data-edit]", root).forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
    $$("[data-grant]", root).forEach((b) => (b.onclick = () => grantDialog({ campaignId: b.dataset.grant, onDone: () => showCampaigns() })));
    $$("[data-players]", root).forEach((b) => (b.onclick = () => { gs.campaignId = b.dataset.players; gs.status = "all"; gs.page = 1; CA.goView("incentive-grants"); }));
    $$("[data-del]", root).forEach((b) => (b.onclick = async () => {
      const c = view.campaigns.find((x) => x.id === b.dataset.del);
      const yes = await CA.confirm({ title: "Excluir campanha", message: `Excluir "${c.name}"? Só dá para excluir campanha que nunca foi usada; as usadas ficam no histórico (desligue-as).`, confirmLabel: "Excluir", danger: true });
      if (!yes) return;
      try { await CA.api(`/admin/incentives/campaigns/${encodeURIComponent(c.id)}`, { method: "DELETE" }); view = await CA.api("/admin/incentives"); renderCampaigns({ text: "Campanha excluída." }); }
      catch (e) { say($("#ic_msg"), e.message, false); }
    }));
  }

  function campaignCard(c) {
    const [wl, wt] = WINDOW[c.window] || [c.window, "gray"];
    const bonusSub = c.trigger === "DEPOSIT"
      ? [c.minDeposit ? `depósito mín. ${money(c.minDeposit)}` : "qualquer depósito", c.firstDepositOnly ? "só no 1º depósito" : ""].filter(Boolean).join(" · ")
      : c.trigger === "CLAIM" ? (c.requireDeposit ? "só para quem já depositou" : "o jogador ativa no site") : "concedido pela equipe";
    const rollSub = [`prazo ${c.validDays} ${c.validDays === 1 ? "dia" : "dias"}`, c.maxBet ? `aposta máx. ${money(c.maxBet)}` : "", c.maxConversion ? `teto ${money(c.maxConversion)}` : ""].filter(Boolean).join(" · ");
    const period = c.startsAt || c.endsAt ? `${c.startsAt ? CA.fdt(c.startsAt) : "já"} → ${c.endsAt ? CA.fdt(c.endsAt) : "sem fim"}` : "sem período";
    const st = c.stats;
    return `<div class="tcard in-card ic-camp">
      <div class="ic-top"><b class="nm">${esc(c.name)}</b>${CA.badge(wl, wt)}<span class="tag-s">${esc(TRIGGER[c.trigger][0])}</span>${c.maxPerPlayer > 1 ? `<span class="tag-s">até ${c.maxPerPlayer}× por jogador</span>` : ""}
        <span class="ly-sp"></span>
        ${CA.isFinance() ? `<button type="button" class="op-btn sm" data-grant="${esc(c.id)}">${ICON.plus}Conceder</button>` : ""}
        ${CA.isAdmin() ? `<button type="button" class="op-btn sm" data-edit="${esc(c.id)}">${ICON.edit}Editar</button><button type="button" class="op-btn sm red" data-del="${esc(c.id)}">${ICON.trash}Excluir</button>` : ""}</div>
      <div class="ic-facts">
        <div><small>Bônus</small><b>${esc(bonusText(c))}</b><span>${esc(bonusSub)}</span></div>
        <div><small>Rollover</small><b>${esc(rolloverText(c))}</b><span>${esc(rollSub)}</span></div>
        <div><small>Jogos</small><b>${int(c.gamesTotal)} ${c.gamesTotal === 1 ? "jogo" : "jogos"}</b><span class="${c.gamesOnSite < c.gamesTotal ? "ic-warn" : ""}">${c.gamesOnSite === c.gamesTotal ? "todos aparecem no site" : `${int(c.gamesOnSite)} aparecem no site`}</span></div>
        <div><small>Período</small><b>${esc(period)}</b><span>ordem ${c.sortOrder} no site</span></div>
      </div>
      ${c.games.length ? `<div class="ly-ths">${c.games.map(thumb).join("")}${c.gamesTotal > c.games.length ? `<span class="ly-more">+${int(c.gamesTotal - c.games.length)}</span>` : ""}</div>` : ""}
      ${c.description ? `<div class="in-help">${esc(c.description)}</div>` : ""}
      <div class="ic-stats"><span><b>${int(st.grants)}</b> concedidos</span><span><b>${int(st.active)}</b> em andamento</span><span><b>${int(st.completed)}</b> cumpridos</span><span><b>${int(st.expired + st.cancelled + st.lost)}</b> sem cumprir</span><span>bônus <b>${money(st.bonus)}</b></span><span>virou saldo real <b>${money(st.converted)}</b></span>
        ${st.grants ? `<button type="button" class="ic-link" data-players="${esc(c.id)}">Ver jogadores ›</button>` : ""}</div>
    </div>`;
  }

  async function openEditor(id) {
    if (!CA.isAdmin()) return;
    if (!id) {
      editing = { id: null, name: "", description: "", trigger: "DEPOSIT", active: true, startsAt: null, endsAt: null, bonusPercent: 100, bonusFixed: 10, maxBonus: 200, minDeposit: 20,
        firstDepositOnly: false, requireDeposit: false, rolloverTimes: 20, rolloverBase: "BONUS", maxBet: null, maxConversion: null, validDays: 7, maxPerPlayer: 1, sortOrder: view.campaigns.length, games: [], grants: 0 };
      return renderEditor();
    }
    try { editing = await CA.api(`/admin/incentives/campaigns/${encodeURIComponent(id)}`); renderEditor(); }
    catch (e) { say($("#ic_msg"), e.message, false); }
  }

  function exampleText(e) {
    const t = Number(num(e.rolloverTimes)) || 0;
    if (e.trigger === "DEPOSIT") {
      const pct = Number(num(e.bonusPercent)) || 0, cap = num(e.maxBonus), min = Number(num(e.minDeposit)) || 0;
      const dep = Math.max(100, min);
      let bonus = Math.floor(dep * pct) / 100; if (cap != null && Number.isFinite(cap)) bonus = Math.min(bonus, cap);
      const target = (bonus + (e.rolloverBase === "DEPOSIT_BONUS" ? dep : 0)) * t;
      return `Exemplo: depósito de ${money(dep)} → bônus de ${money(bonus)} → apostar ${money(target)} nos jogos da campanha em até ${e.validDays || "?"} dias para o bônus virar saldo real.`;
    }
    const bonus = Number(num(e.bonusFixed)) || 0;
    return `Exemplo: bônus de ${money(bonus)} → apostar ${money(bonus * t)} nos jogos da campanha em até ${e.validDays || "?"} dias para o bônus virar saldo real.`;
  }

  function renderEditor(flash) {
    const e = editing, box = $("#ic_editor");
    if (!box) return;
    if (!e) { box.innerHTML = ""; return; }
    const dep = e.trigger === "DEPOSIT";
    const enabled = new Set(view.enabledWallets || []);
    const provs = providers.filter((p) => p.games > 0);
    const on = provs.filter((p) => enabled.has(p.wallet || "")), off = provs.filter((p) => !enabled.has(p.wallet || ""));
    const opt = (p) => `<option value="${esc(p.slug)}">${esc(p.name)} (${p.games})</option>`;
    const provOpts = `${on.length ? `<optgroup label="No site">${on.map(opt).join("")}</optgroup>` : ""}${off.length ? `<optgroup label="Fora do site (carteira não habilitada)">${off.map(opt).join("")}</optgroup>` : ""}`;
    const offCount = e.games.filter((g) => !g.active).length;
    const field = (id, label, value, help = "", attrs = "") => `<div><label class="lbl" for="${id}">${label}</label><input id="${id}" value="${esc(value)}" ${attrs} />${help ? `<div class="in-help">${help}</div>` : ""}</div>`;
    box.innerHTML = `<div class="tcard in-card ly-editor ic-editor">
      <h3>${e.id ? "Editar campanha" : "Nova campanha"}</h3>
      ${e.grants ? `<div class="int-warn" style="margin-bottom:12px">Esta campanha já foi usada ${int(e.grants)} ${e.grants === 1 ? "vez" : "vezes"}. Mudanças nos jogos valem na hora também para quem está cumprindo; valor, rollover, aposta máxima, teto e prazo de quem já recebeu ficam como estavam.</div>` : ""}
      <div class="in-grid">
        <div class="full">${`<label class="lbl" for="ie_name">Nome da campanha</label><input id="ie_name" maxlength="60" value="${esc(e.name)}" placeholder="ex.: Boas-vindas 100% no primeiro depósito" />`}</div>
      </div>
      <div class="ic-sec">Como o jogador recebe</div>
      <div class="ic-trig" role="radiogroup" aria-label="Como o jogador recebe">${Object.entries(TRIGGER).map(([k, [l, d]]) => `<label class="${e.trigger === k ? "on" : ""}"><input type="radio" name="ie_trig" value="${k}"${e.trigger === k ? " checked" : ""} /> <b>${esc(l)}</b><span>${esc(d)}</span></label>`).join("")}</div>
      <div class="ic-sec">Bônus</div>
      <div class="in-grid">
        ${dep ? field("ie_pct", "% sobre o depósito", val(e.bonusPercent), "100 = dobra o depósito.", 'inputmode="decimal"')
              + field("ie_max", "Bônus máximo (R$)", val(e.maxBonus), "Vazio = sem teto.", 'inputmode="decimal"')
              + field("ie_min", "Depósito mínimo (R$)", val(e.minDeposit), "Vazio = qualquer depósito.", 'inputmode="decimal"')
              + `<div><label class="ly-check ly-check-pad"><input type="checkbox" id="ie_first"${e.firstDepositOnly ? " checked" : ""} /> Só no primeiro depósito da conta</label></div>`
            : field("ie_fixed", "Valor do bônus (R$)", val(e.bonusFixed), e.trigger === "MANUAL" ? "Valor sugerido; a equipe pode mudar ao conceder." : "", 'inputmode="decimal"')
              + (e.trigger === "CLAIM" ? `<div><label class="ly-check ly-check-pad"><input type="checkbox" id="ie_reqdep"${e.requireDeposit ? " checked" : ""} /> Só para quem já fez um depósito</label></div>` : "<div></div>")}
      </div>
      <div class="ic-sec">Rollover</div>
      <div class="in-grid ic-g3">
        ${field("ie_times", "Rollover (vezes)", val(e.rolloverTimes), "Quantas vezes apostar a base nos jogos da campanha.", 'inputmode="decimal"')}
        <div><label class="lbl" for="ie_base">Sobre</label><select id="ie_base"${dep ? "" : " disabled"}><option value="BONUS"${e.rolloverBase !== "DEPOSIT_BONUS" ? " selected" : ""}>o bônus</option><option value="DEPOSIT_BONUS"${e.rolloverBase === "DEPOSIT_BONUS" ? " selected" : ""}>o depósito + o bônus</option></select>${dep ? "" : '<div class="in-help">Depósito + bônus só em campanha de depósito.</div>'}</div>
        ${field("ie_days", "Prazo para cumprir (dias)", e.validDays, "Contado de quando o jogador recebe.", 'inputmode="numeric"')}
        ${field("ie_maxbet", "Aposta máxima que conta (R$)", val(e.maxBet), "Aposta acima disso não soma. Vazio = todas somam.", 'inputmode="decimal"')}
        ${field("ie_conv", "Teto de conversão (R$)", val(e.maxConversion), "Máximo que vira saldo real. Vazio = tudo.", 'inputmode="decimal"')}
        ${field("ie_per", "Vezes por jogador", e.maxPerPlayer, "", 'inputmode="numeric"')}
      </div>
      <div class="ic-example" id="ie_example">${esc(exampleText(e))}</div>
      <div class="ic-sec">Jogos da campanha <span class="ic-count">${int(e.games.length)} ${e.games.length === 1 ? "jogo" : "jogos"}${offCount ? ` · ${int(offCount)} fora do site` : ""}</span></div>
      <div class="in-help" style="margin:-2px 0 8px">Só nestes jogos o bônus pode ser apostado e só as apostas neles contam para o rollover. Clique num jogo para tirá-lo.</div>
      <div class="ic-games" id="ie_games">${e.games.length ? e.games.map((g, i) => `<button type="button" class="ic-chip${g.active ? "" : " off"}" data-rm="${i}" title="Tirar ${esc(g.name)}${g.active ? "" : " (fora do site)"}">${thumb(g)}<span>${esc(g.name)}</span><small>${esc(g.provider)}</small></button>`).join("") : '<span class="hint" style="margin:0">Nenhum jogo ainda. Use as opções abaixo.</span>'}</div>
      <div class="ly-add">
        <div><label class="lbl" for="ie_prov">Todos os jogos de um provedor</label>
          <div class="ly-inline"><select id="ie_prov">${provOpts}</select><button type="button" class="btn2 gray" id="ie_fill">Adicionar</button></div></div>
        <div><label class="lbl" for="ie_q">Ou busque um jogo pelo nome</label>
          <div class="ly-inline"><input id="ie_q" placeholder="ex.: Fortune Tiger" /><button type="button" class="btn2 gray" id="ie_search">Buscar</button></div>
          <div class="ly-results" id="ie_results"></div></div>
      </div>
      ${e.games.length ? '<div style="margin-top:8px"><button type="button" class="btn2 ghost" id="ie_clear">Tirar todos os jogos</button></div>' : ""}
      <div class="ic-sec">Site</div>
      <div class="in-grid ic-g3">
        <div><label class="lbl" for="ie_start">Começa em (opcional)</label><input id="ie_start" type="datetime-local" value="${esc(localInput(e.startsAt))}" /></div>
        <div><label class="lbl" for="ie_end">Termina em (opcional)</label><input id="ie_end" type="datetime-local" value="${esc(localInput(e.endsAt))}" /></div>
        ${field("ie_order", "Ordem no site (menor = primeiro)", e.sortOrder, "", 'inputmode="numeric"')}
        <div class="full"><label class="lbl" for="ie_desc">Regras para o jogador (opcional)</label><textarea id="ie_desc" rows="3" maxlength="600" placeholder="O site já mostra bônus, rollover, prazo e jogos. Use para algo a mais.">${esc(e.description)}</textarea></div>
        <div class="full"><label class="ly-check"><input type="checkbox" id="ie_active"${e.active ? " checked" : ""} /> Campanha ligada (desligada, ninguém novo recebe; quem já recebeu continua)</label></div>
      </div>
      <div class="msg2" id="ie_msg" role="status"></div>
      <div class="in-actions"><button type="button" class="primary" id="ie_save">${e.id ? "Salvar campanha" : "Criar campanha"}</button><button type="button" class="btn2 gray" id="ie_cancel">Cancelar</button></div>
    </div>`;
    if (flash) say($("#ie_msg"), flash.text, flash.ok !== false);
    const keep = () => {
      const g = (id) => { const el = $("#" + id); return el ? el.value : undefined; };
      e.name = g("ie_name"); e.description = g("ie_desc");
      if (dep) { e.bonusPercent = g("ie_pct"); e.maxBonus = g("ie_max"); e.minDeposit = g("ie_min"); e.firstDepositOnly = $("#ie_first").checked; }
      else { e.bonusFixed = g("ie_fixed"); if ($("#ie_reqdep")) e.requireDeposit = $("#ie_reqdep").checked; }
      e.rolloverTimes = g("ie_times"); e.rolloverBase = dep ? g("ie_base") : "BONUS"; e.validDays = g("ie_days"); e.maxBet = g("ie_maxbet"); e.maxConversion = g("ie_conv");
      e.maxPerPlayer = g("ie_per"); e.sortOrder = g("ie_order"); e.active = $("#ie_active").checked;
      const s = g("ie_start"), en = g("ie_end");
      e.startsAt = s ? new Date(s).toISOString() : null; e.endsAt = en ? new Date(en).toISOString() : null;
    };
    $$("input[name=ie_trig]", box).forEach((r) => (r.onchange = () => { keep(); e.trigger = r.value; if (e.trigger !== "DEPOSIT") e.rolloverBase = "BONUS"; renderEditor(); }));
    box.oninput = (ev) => { if (ev.target.matches("input, select")) { keep(); const ex = $("#ie_example"); if (ex) ex.textContent = exampleText(e); } };
    $$("#ie_games [data-rm]", box).forEach((b) => (b.onclick = () => { keep(); e.games.splice(Number(b.dataset.rm), 1); renderEditor(); }));
    const add = (games) => {
      keep();
      const have = new Set(e.games.map((g) => g.id));
      const fresh = games.filter((g) => !have.has(g.id));
      e.games.push(...fresh);
      const off = fresh.filter((g) => !g.active).length;
      renderEditor({ text: fresh.length ? `${int(fresh.length)} jogo(s) adicionado(s)${off ? ` — ${int(off)} fora do site` : ""}.` : "Esses jogos já estão na campanha.", ok: !off });
    };
    $("#ie_fill").onclick = async () => {
      try { add(await CA.api("/admin/incentives/autofill", { method: "POST", body: JSON.stringify({ providerSlug: $("#ie_prov").value }) })); }
      catch (err) { say($("#ie_msg"), err.message, false); }
    };
    const search = async () => {
      const q = $("#ie_q").value.trim();
      if (q.length < 2) return say($("#ie_msg"), "Digite pelo menos 2 letras", false);
      try {
        const games = await CA.api(`/admin/incentives/games${CA.qs({ q })}`);
        $("#ie_results").innerHTML = games.length ? games.map((g, i) => `<button type="button" class="ly-res" data-pick="${i}">${thumb(g)}<span>${esc(g.name)}<small>${esc(g.provider)}${g.active ? "" : " · fora do site"}</small></span><b>+</b></button>`).join("") : '<span class="hint">Nada encontrado.</span>';
        $$("#ie_results [data-pick]").forEach((b) => (b.onclick = () => add([games[Number(b.dataset.pick)]])));
      } catch (err) { say($("#ie_msg"), err.message, false); }
    };
    $("#ie_search").onclick = search;
    $("#ie_q").onkeydown = (ev) => { if (ev.key === "Enter") search(); };
    const clear = $("#ie_clear"); if (clear) clear.onclick = () => { keep(); e.games = []; renderEditor(); };
    $("#ie_cancel").onclick = () => { editing = null; if (location.hash !== "#/incentives") history.replaceState(null, "", "#/incentives"); renderEditor(); };
    $("#ie_save").onclick = () => save();
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function save() {
    const e = editing, msg = $("#ie_msg");
    const g = (id) => { const el = $("#" + id); return el ? el.value : ""; };
    const dep = e.trigger === "DEPOSIT";
    const amounts = { rolloverTimes: num(g("ie_times")), maxBet: num(g("ie_maxbet")), maxConversion: num(g("ie_conv")) };
    if (dep) Object.assign(amounts, { bonusPercent: num(g("ie_pct")), maxBonus: num(g("ie_max")), minDeposit: num(g("ie_min")) });
    else amounts.bonusFixed = num(g("ie_fixed"));
    const bad = Object.entries(amounts).find(([, v]) => Number.isNaN(v));
    if (bad) return say(msg, "Confira os valores: use só números (ex.: 1.000,50).", false);
    if (!g("ie_name").trim()) return say(msg, "Dê um nome à campanha", false);
    if (!e.games.length) return say(msg, "Escolha pelo menos um jogo", false);
    const start = g("ie_start"), end = g("ie_end");
    const body = {
      name: g("ie_name").trim(), description: g("ie_desc").trim(), trigger: e.trigger, active: $("#ie_active").checked,
      startsAt: start ? new Date(start).toISOString() : null, endsAt: end ? new Date(end).toISOString() : null,
      bonusPercent: dep ? amounts.bonusPercent : null, maxBonus: dep ? amounts.maxBonus : null, minDeposit: dep ? amounts.minDeposit : null,
      firstDepositOnly: dep && $("#ie_first").checked, bonusFixed: dep ? null : amounts.bonusFixed,
      requireDeposit: e.trigger === "CLAIM" && !!$("#ie_reqdep") && $("#ie_reqdep").checked,
      rolloverTimes: amounts.rolloverTimes, rolloverBase: dep ? g("ie_base") : "BONUS", maxBet: amounts.maxBet, maxConversion: amounts.maxConversion,
      validDays: Number(g("ie_days")) || 0, maxPerPlayer: Number(g("ie_per")) || 1, sortOrder: Number(g("ie_order")) || 0,
      gameIds: e.games.map((x) => x.id),
    };
    say(msg, "Salvando…");
    try {
      await CA.api(e.id ? `/admin/incentives/campaigns/${encodeURIComponent(e.id)}` : "/admin/incentives/campaigns", { method: e.id ? "PUT" : "POST", body: JSON.stringify(body) });
      const created = !e.id;
      editing = null;
      if (location.hash !== "#/incentives") history.replaceState(null, "", "#/incentives"); // recarregar não reabre o editor
      view = await CA.api("/admin/incentives");
      renderCampaigns({ text: created ? (body.active ? "Campanha criada ✓ — já vale no site." : "Campanha criada ✓ (desligada: ligue quando quiser pôr no ar).") : "Campanha salva ✓" });
    } catch (err) { say(msg, err.message, false); }
  }

  /* ── Conceder incentivo (campanha + jogador + valor) ── */
  async function grantDialog({ campaignId = "", user = null, onDone } = {}) {
    let camps = view?.campaigns;
    if (!camps) { try { camps = (await CA.api("/admin/incentives")).campaigns; } catch (e) { return CA.toast(e.message, "err"); } }
    if (!camps.length) return CA.toast("Crie uma campanha antes de conceder.", "err");
    const first = camps.find((c) => c.id === campaignId) || camps[0];
    const bg = CA.modal({
      title: "Conceder incentivo",
      body: `${CA.field("Campanha", `<select data-f="campaign">${camps.map((c) => `<option value="${esc(c.id)}"${c.id === first.id ? " selected" : ""}>${esc(c.name)}${c.window === "OPEN" ? "" : ` (${WINDOW[c.window][0].toLowerCase()})`}</option>`).join("")}</select>`)}
        <div class="op-note" data-camp-info style="margin:6px 0 0"></div>
        ${user ? `<div class="mini" style="margin:12px 0 0"><span class="box-ic" style="--tone:var(--green);--tone-bg:rgba(34,197,94,.15)">${ICON.person}</span><div><span>Jogador</span><b>${esc(user.label)}</b></div></div>`
          : `${CA.field("Jogador", `<input data-f="search" placeholder="Digite nome, e-mail ou ID e escolha" autocomplete="off" />`)}<div data-results style="margin:6px 0 4px"></div>
             <div data-picked hidden><div class="mini" style="margin:8px 0"><span class="box-ic" style="--tone:var(--green);--tone-bg:rgba(34,197,94,.15)">${ICON.person}</span><div><span>Selecionado</span><b data-picked-name></b></div></div></div>`}
        ${CA.field("Valor do bônus (R$)", CA.num("amount", { value: "", step: "0.01", min: "0.01", ph: "ex.: 20" }))}
        ${CA.field("Observação (fica no histórico)", CA.area("note", { ph: "ex.: compensação pelo atendimento" }))}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes${user ? "" : " disabled"}>Conceder</button>`,
    });
    let picked = user ? user.id : null;
    const yes = $("[data-yes]", bg), amount = $("[data-f=amount]", bg), sel = $("[data-f=campaign]", bg);
    const info = () => {
      const c = camps.find((x) => x.id === sel.value);
      $("[data-camp-info]", bg).textContent = `Rollover ${rolloverText(c)} · prazo ${c.validDays} dias · ${int(c.gamesOnSite)} jogos no site${c.trigger === "DEPOSIT" ? " · concessão manual: rollover sobre o bônus" : ""}`;
      if (c.bonusFixed) amount.value = c.bonusFixed; else if (!amount.value) amount.value = "";
    };
    sel.onchange = info; info();
    if (!user) {
      const results = $("[data-results]", bg), search = $("[data-f=search]", bg);
      let t;
      search.oninput = () => {
        clearTimeout(t); const term = search.value.trim();
        if (term.length < 2) { results.innerHTML = ""; return; }
        t = setTimeout(async () => {
          try {
            const d = await CA.api(`/admin/ops/users${CA.qs({ q: term, size: 6 })}`);
            results.innerHTML = d.items.length ? d.items.map((u) => `<button type="button" class="sn-item" data-pick="${u.id}" data-name="${esc(u.name)} · ${esc(u.email)}" style="width:100%;border:1px solid var(--line-2);margin-bottom:4px">${CA.avatar(u.name)}<span>${esc(u.name)} · <span class="muted">${esc(u.email)}</span></span></button>`).join("") : `<p class="op-note">Nenhum jogador encontrado.</p>`;
            $$("[data-pick]", results).forEach((b) => (b.onclick = () => { picked = b.dataset.pick; $("[data-picked-name]", bg).textContent = b.dataset.name; $("[data-picked]", bg).hidden = false; results.innerHTML = ""; search.value = b.dataset.name; yes.disabled = false; }));
          } catch (e) { results.innerHTML = `<p class="op-note">${esc(e.message)}</p>`; }
        }, 300);
      };
    }
    $("[data-no]", bg).onclick = () => CA.closeModal();
    yes.onclick = async () => {
      const m = $("[data-msg]", bg);
      const a = Number(amount.value);
      if (!picked) { m.textContent = "Escolha o jogador"; return; }
      if (!(a > 0)) { m.textContent = "Informe o valor do bônus"; return; }
      yes.disabled = true; m.textContent = "Concedendo…";
      try {
        const r = await CA.api("/admin/incentives/grants", { method: "POST", body: JSON.stringify({ campaignId: sel.value, user: picked, amount: a, note: $("[data-f=note]", bg).value.trim() }) });
        CA.closeModal();
        CA.toast(`Incentivo de ${money(r.bonus)} concedido · rollover ${money(r.rolloverTarget)}`);
        if (onDone) onDone();
      } catch (e) { m.textContent = e.message; yes.disabled = false; }
    };
  }

  /* ═════════════ Jogadores (incentivos concedidos) ═════════════ */
  const gs = { status: "all", campaignId: "", q: "", page: 1, size: 25 };
  let campList = null;

  async function showGrants(arg) {
    const seq = CA.bumpSeq();
    if (arg) { gs.campaignId = arg; gs.page = 1; }
    let d;
    try {
      [d, campList] = await Promise.all([CA.api(`/admin/incentives/grants${CA.qs(gs)}`), campList || CA.api("/admin/incentives").then((v) => v.campaigns)]);
    } catch (e) {
      if (seq === CA.seq()) CA.render(CA.opHead({ title: "Incentivos dos jogadores", icon: GIFT }) + CA.empty("Não foi possível carregar", e.message, ICON.warn));
      return;
    }
    if (seq !== CA.seq()) return;
    const c = d.counts, totalAll = Object.values(c).reduce((a, b) => a + b, 0);
    const statusOpts = [["all", `Todas as situações (${int(totalAll)})`], ...Object.entries(STATUS).map(([k, [l]]) => [k, `${l} (${int(c[k] || 0)})`])];
    CA.render(CA.opHead({
      title: "Incentivos dos jogadores", sub: "Quem recebeu bônus, quanto já apostou do rollover e o que virou saldo real.", icon: GIFT,
      actions: `${CA.isFinance() ? `<button type="button" class="op-btn green" data-grant>${ICON.plus}Conceder incentivo</button>` : ""}<button type="button" class="op-btn" data-go="incentives">${GIFT}Campanhas</button><button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    })
      + `<div class="kgrid">
        ${CA.kpi({ label: "Em andamento", value: int(c.ACTIVE), sub: "cumprindo rollover", icon: GIFT, tone: "purple" })}
        ${CA.kpi({ label: "Cumpridos", value: int(c.COMPLETED), sub: "bônus virou saldo real", icon: ICON.check, tone: "green" })}
        ${CA.kpi({ label: "Expirados ou esgotados", value: int((c.EXPIRED || 0) + (c.LOST || 0)), sub: "sem cumprir no prazo ou bônus zerado", icon: ICON.warn, tone: "gray" })}
        ${CA.kpi({ label: "Cancelados", value: int(c.CANCELLED), sub: "pelo jogador ou pela equipe", icon: ICON.x, tone: "orange" })}
      </div>
      <div class="op-toolbar ic-toolbar">
        <div class="op-search">${ICON.search}<input placeholder="Buscar jogador por nome, e-mail, CPF ou ID" value="${esc(gs.q)}" data-q /></div>
        <select data-status>${statusOpts.map(([v, l]) => `<option value="${v}"${gs.status === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <select data-camp><option value="">Todas as campanhas</option>${campList.map((x) => `<option value="${esc(x.id)}"${gs.campaignId === x.id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      </div>`
      + incentivesTable(d, { showUser: true })
      + (d.total > d.size ? CA.pager(d.total, d.page, d.size) : ""));
    const root = CA.view();
    $("[data-reload]", root).onclick = () => { campList = null; showGrants(); };
    const gb = $("[data-grant]", root); if (gb) gb.onclick = () => grantDialog({ campaignId: gs.campaignId, onDone: () => showGrants() });
    const q = $("[data-q]", root); let qt; q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { gs.q = q.value.trim(); gs.page = 1; showGrants(); }, 350); };
    $("[data-status]", root).onchange = (e) => { gs.status = e.target.value; gs.page = 1; showGrants(); };
    $("[data-camp]", root).onchange = (e) => { gs.campaignId = e.target.value; gs.page = 1; showGrants(); };
    CA.wirePager(root, (p) => { gs.page = p; showGrants(); }, (sz) => { gs.size = sz; gs.page = 1; showGrants(); });
    wireIncentivesTable(root, () => showGrants());
  }

  function incentivesTable(d, { showUser = true } = {}) {
    if (!d.rows.length) return `<div class="op-table">${CA.empty("Nenhum incentivo", showUser ? "Ajuste os filtros, ou conceda um incentivo." : "Este jogador ainda não recebeu incentivos.", GIFT)}</div>`;
    const rows = d.rows.map((r) => {
      const [sl, st] = STATUS[r.status] || [r.status, "gray"];
      const pctTxt = Math.floor(r.progress * 100) + "%"; // para baixo, igual ao site: 100% só quando cumpriu
      const result = r.status === "ACTIVE" ? `<b>${money(r.bonusBalance)}</b><span>saldo de bônus</span>`
        : r.status === "COMPLETED" ? `<b class="v-green">+${money(r.converted || 0)}</b><span>virou saldo real${r.forfeited ? ` · retirado ${money(r.forfeited)}` : ""}</span>`
        : `<b>${money(r.forfeited || 0)}</b><span>retirado</span>`;
      return `<tr>
        ${showUser ? `<td><span class="click-cell" data-open-user="${esc(r.user.id)}">${CA.userCell({ id: r.user.id, name: r.user.name || r.user.email, email: r.user.email }, { open: false })}</span></td>` : ""}
        <td class="camp"><b>${esc(r.campaign.name)}</b><div class="muted" style="font-size:11.5px">${esc(TRIGGER[r.campaign.trigger] ? TRIGGER[r.campaign.trigger][0] : "")}${r.grantedBy ? ` · por ${esc(r.grantedBy)}` : ""}</div></td>
        <td class="num"><b>${money(r.bonusAmount)}</b>${r.depositAmount ? `<div class="muted" style="font-size:11.5px">depósito ${money(r.depositAmount)}</div>` : ""}</td>
        <td><div class="ic-roll"><b>${money(r.rolloverDone)} de ${money(r.rolloverTarget)}</b><div class="ic-bar" role="progressbar" aria-valuenow="${Math.floor(r.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pctTxt}"></i></div><span>${pctTxt}${r.maxBet ? ` · aposta máx. ${money(r.maxBet)}` : ""}</span></div></td>
        <td>${CA.badge(sl, st)}<div class="dt ic-res">${result}</div>${r.note ? `<div class="muted" style="font-size:11px;max-width:180px">${esc(r.note)}</div>` : ""}</td>
        <td><div class="dt"><b>${CA.fdt(r.grantedAt)}</b><span>${r.status === "ACTIVE" ? `vence ${CA.fdt(r.expiresAt)}` : r.endedAt ? `encerrado ${CA.fdt(r.endedAt)}` : ""}</span></div></td>
        <td><div class="row-actions"><button type="button" class="op-btn sm" data-ledger="${esc(r.id)}">Extrato</button>${r.status === "ACTIVE" && CA.isFinance() ? `<button type="button" class="op-btn sm red" data-cancel="${esc(r.id)}">Cancelar</button>` : ""}</div></td>
      </tr>`;
    }).join("");
    return `<div class="op-table ic-tbl"><div class="tscroll"><table><thead><tr>${showUser ? "<th>Jogador</th>" : ""}<th>Campanha</th><th class="num">Bônus</th><th>Rollover</th><th>Situação</th><th>Recebido</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  function wireIncentivesTable(root, reload) {
    $$("[data-ledger]", root).forEach((b) => (b.onclick = () => ledgerModal(b.dataset.ledger)));
    $$("[data-cancel]", root).forEach((b) => (b.onclick = () => cancelGrant(b.dataset.cancel, reload)));
  }

  async function cancelGrant(id, reload) {
    const bg = CA.modal({
      title: "Cancelar incentivo",
      body: `<p style="margin:0 0 10px;color:#c9cdd4;font-size:13.5px;line-height:1.5">O saldo de bônus que sobrou é retirado e o saque do jogador fica liberado. Não dá para desfazer.</p>${CA.field("Motivo (fica no histórico e na auditoria)", CA.area("note", { ph: "ex.: pedido do jogador" }))}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Voltar</button><button type="button" class="op-btn red" data-yes>Cancelar incentivo</button>`,
    });
    $("[data-no]", bg).onclick = () => CA.closeModal();
    $("[data-yes]", bg).onclick = async () => {
      const m = $("[data-msg]", bg);
      m.textContent = "Cancelando…";
      try {
        const r = await CA.api(`/admin/incentives/grants/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ note: $("[data-f=note]", bg).value.trim() }) });
        CA.closeModal();
        CA.toast(`Incentivo cancelado · ${money(r.forfeited)} de bônus retirado`);
        if (reload) reload();
      } catch (e) { m.textContent = e.message; }
    };
  }

  async function ledgerModal(id) {
    let d;
    try { d = await CA.api(`/admin/incentives/grants/${encodeURIComponent(id)}`); } catch (e) { return CA.toast(e.message, "err"); }
    const rows = d.rows.length ? d.rows.map((t) => `<tr>
        <td>${CA.fdt(t.at)}</td><td>${esc(LEDGER[t.type] || t.type)}</td><td class="muted">${esc(t.game || "—")}</td>
        <td class="num">${t.stake != null ? money(t.stake) : "—"}</td>
        <td class="num ${t.amount > 0 ? "v-green" : t.amount < 0 ? "v-red" : ""}">${t.amount > 0 ? "+" : ""}${money(t.amount)}</td>
        <td class="num">${t.rollover ? (t.rollover > 0 ? "+" : "") + money(t.rollover) : "—"}</td>
        <td class="num">${money(t.bonusAfter)}</td></tr>`).join("")
      : `<tr><td colspan="7">${CA.empty("Sem lançamentos", "")}</td></tr>`;
    const bg = CA.modal({
      title: `Extrato do bônus — ${d.campaign}`, wide: true,
      body: `<p class="op-note" style="margin:0 0 10px">${esc(d.user.name || d.user.email)} · ${esc((STATUS[d.status] || [d.status])[0])}. Aposta = aposta inteira da rodada (real + bônus); Bônus = o que entrou ou saiu do saldo de bônus; Rollover = quanto somou.</p>
        <div class="op-table" style="margin:0"><div class="tscroll" style="max-height:60vh;overflow:auto"><table><thead><tr><th>Data</th><th>Lançamento</th><th>Jogo</th><th class="num">Aposta</th><th class="num">Bônus</th><th class="num">Rollover</th><th class="num">Saldo de bônus</th></tr></thead><tbody>${rows}</tbody></table></div></div>`,
    });
    bg.querySelector(".op-modal").classList.add("ic-ledger"); // mais larga: data e jogo numa linha só
  }

  // a ficha do jogador (aba Bônus) usa a mesma tabela e o mesmo "Conceder"
  CA.incentivesTable = incentivesTable;
  CA.wireIncentivesTable = wireIncentivesTable;
  CA.grantIncentive = grantDialog;
  CA.registerViews({ incentives: (arg) => showCampaigns(arg), "incentive-grants": (arg) => showGrants(arg) });
})();
