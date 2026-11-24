/* ══════════════ Fidelidade — Nível VIP e Coleções ══════════════
   Usa os utilitários do script principal via window.CA. O jogador vê isso no menu do site (Nível VIP e Coleções). */
(function () {
  "use strict";
  const CA = window.CA;
  const esc = CA.escA;
  const money = CA.money;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  // "1.000" e "1.000,50" (jeito brasileiro) ou "10.5": vira número; vazio ou texto vira NaN
  const num = (v) => {
    let t = String(v ?? "").trim().replace(/[R$\s]/g, "");
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
    else if (!/^\d+\.\d{1,2}$/.test(t)) t = t.replace(/\./g, "");
    const n = Number(t);
    return t !== "" && Number.isFinite(n) ? n : NaN;
  };
  const val = (n) => (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const when = (v) => (v.updatedAt ? `Última alteração: ${esc(CA.fdt ? CA.fdt(v.updatedAt) : v.updatedAt)}${v.updatedByEmail ? " por " + esc(v.updatedByEmail) : ""}` : "Usando o padrão.");
  const say = (id, text, ok = true) => { const m = $(id); if (m) { m.style.color = ok ? "var(--accent)" : "#f85149"; m.textContent = text; } };
  const head = (title, sub) => `<div class="dsh"><div class="dsh-head"><div><h1>${title}</h1><p>${sub}</p></div></div><div id="ly_body"><p class="hint">Carregando…</p></div></div>`;

  /* ─────────────── Nível VIP ─────────────── */
  let vip = null;
  async function showVip() {
    const my = CA.bumpSeq();
    CA.view().innerHTML = head("Nível VIP", "O jogador sobe de nível pelo total apostado (cassino + esportes). Ao chegar num nível com bônus, ele resgata o valor uma vez no menu do site.");
    try { vip = await CA.api("/admin/vip"); } catch (e) { if (my === CA.seq()) $("#ly_body").innerHTML = `<div class="int-warn">${esc(e.message)}</div>`; return; }
    if (my === CA.seq()) renderVip();
  }
  function vipRow(l, i) {
    return `<tr data-i="${i}">
      <td><input type="color" data-f="color" value="${esc(l.color)}" aria-label="Cor do nível" /></td>
      <td><input data-f="name" value="${esc(l.name)}" maxlength="24" aria-label="Nome do nível" /></td>
      <td><input data-f="minWagered" value="${val(l.minWagered)}" inputmode="decimal" aria-label="Total apostado para chegar" /></td>
      <td><input data-f="reward" value="${val(l.reward)}" inputmode="decimal" aria-label="Bônus ao chegar" /></td>
      <td><input data-f="perks" value="${esc(l.perks || "")}" maxlength="200" placeholder="opcional" aria-label="Benefícios" /></td>
      <td><button type="button" class="btn2 ghost" data-rm="${i}" aria-label="Remover nível">✕</button></td></tr>`;
  }
  function renderVip(flash) {
    const v = vip;
    const paid = v.claims.reduce((s, c) => s + c.total, 0), n = v.claims.reduce((s, c) => s + c.count, 0);
    $("#ly_body").innerHTML = `
      <div class="tcard in-card">
        <div class="in-status"><span class="tag ${v.enabled ? "on" : "off"}">${v.enabled ? "ligado" : "desligado"}</span><span>${when(v)}</span></div>
        <label class="ly-check"><input type="checkbox" id="vp_on"${v.enabled ? " checked" : ""} /> Programa VIP ligado (desligado, o site mostra "pausado" e ninguém resgata)</label>
        <div class="ly-scroll"><table class="ly-table"><thead><tr><th>Cor</th><th>Nível</th><th>Total apostado (R$)</th><th>Bônus ao chegar (R$)</th><th>Benefícios</th><th></th></tr></thead>
          <tbody id="vp_rows">${v.levels.map(vipRow).join("")}</tbody></table></div>
        <div class="in-help">O nível mais baixo costuma começar em R$ 0. Bônus R$ 0 = nível sem bônus. Os níveis são ordenados pelo total apostado ao salvar.</div>
        <div class="msg2" id="vp_msg" role="status"></div>
        <div class="in-actions">
          <button class="primary" id="vp_save">Salvar níveis</button>
          <button class="btn2 gray" id="vp_add">Adicionar nível</button>
          <span class="ly-stat">Bônus de nível já resgatados: <b>${n}</b> · <b>${money(paid)}</b></span>
        </div>
      </div>
      ${v.claims.length ? `<div class="dsh-sec"><h2>Resgates por nível</h2></div><div class="tcard in-card"><div class="ly-chips">${v.claims.map((c) => `<span class="tag-s">${esc(c.level)}: ${c.count} · ${money(c.total)}</span>`).join(" ")}</div></div>` : ""}`;
    if (flash) say("#vp_msg", flash.text, flash.ok !== false);
    $("#vp_add").onclick = () => {
      const levels = readVip(false);
      const last = levels[levels.length - 1];
      levels.push({ name: `Nível ${levels.length + 1}`, minWagered: last ? last.minWagered * 2 || 1000 : 0, reward: 0, color: "#8f9aab", perks: "" });
      vip = { ...vip, levels };
      renderVip();
    };
    $$("#vp_rows [data-rm]").forEach((b) => (b.onclick = () => {
      const levels = readVip(false).filter((_, i) => i !== Number(b.dataset.rm));
      vip = { ...vip, levels };
      renderVip();
    }));
    $("#vp_save").onclick = saveVip;
  }
  function readVip(strict = true) {
    return $$("#vp_rows tr").map((tr) => {
      const g = (f) => $(`[data-f="${f}"]`, tr).value;
      const minWagered = num(g("minWagered")), reward = num(g("reward"));
      if (strict && (!Number.isFinite(minWagered) || !Number.isFinite(reward))) throw new Error(`Confira os valores do nível "${g("name")}"`);
      return { name: g("name").trim(), minWagered: Number.isFinite(minWagered) ? minWagered : 0, reward: Number.isFinite(reward) ? reward : 0, color: g("color"), perks: g("perks").trim() };
    });
  }
  async function saveVip() {
    let levels;
    try { levels = readVip(); } catch (e) { return say("#vp_msg", e.message, false); }
    say("#vp_msg", "Salvando…");
    try {
      vip = await CA.api("/admin/vip", { method: "PUT", body: JSON.stringify({ enabled: $("#vp_on").checked, levels }) });
      renderVip({ text: "Níveis salvos ✓ — o site já mostra assim." });
    } catch (e) { say("#vp_msg", e.message, false); }
  }

  /* ─────────────── Coleções ─────────────── */
  let col = null, providers = [], editing = null; // editing = { id|null, name, description, reward, active, sortOrder, cards: [{gameId,name,imageUrl,provider}] }
  async function showCollections() {
    const my = CA.bumpSeq();
    editing = null;
    CA.view().innerHTML = head("Coleções", "Álbuns de cartas em que cada carta é um jogo. O jogador ganha um pacote a cada valor apostado, abre e recebe cartas; completou o álbum, resgata o prêmio uma vez.");
    try {
      [col, providers] = await Promise.all([CA.api("/admin/collections"), providers.length ? providers : CA.api("/admin/providers")]);
    } catch (e) { if (my === CA.seq()) $("#ly_body").innerHTML = `<div class="int-warn">${esc(e.message)}</div>`; return; }
    if (my === CA.seq()) renderCollections();
  }
  const thumb = (c) => `<span class="ly-th${c.imageUrl ? "" : " none"}" title="${esc(c.name)}">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="" loading="lazy">` : esc((c.name || "?").slice(0, 2).toUpperCase())}</span>`;
  function renderCollections(flash) {
    const st = col.settings;
    const list = col.collections.length ? col.collections.map((c) => `
      <div class="tcard in-card ly-col">
        <div class="ly-col-top"><b>${esc(c.name)}</b>
          <span class="tag ${c.active ? "on" : "off"}">${c.active ? "aberta" : "fechada"}</span>
          <span class="ly-stat">${c.cards.length} cartas · prêmio ${money(c.reward)} · ${c.claims.count} resgates (${money(c.claims.total)})</span>
          <span class="ly-sp"></span>
          <button class="btn2 gray" data-edit="${esc(c.id)}">Editar</button>
          <button class="btn2 red" data-del="${esc(c.id)}">Excluir</button></div>
        ${c.description ? `<div class="in-help">${esc(c.description)}</div>` : ""}
        <div class="ly-ths">${c.cards.slice(0, 14).map(thumb).join("")}${c.cards.length > 14 ? `<span class="ly-more">+${c.cards.length - 14}</span>` : ""}</div>
      </div>`).join("") : '<div class="tcard in-card"><p class="hint">Nenhuma coleção ainda. Crie a primeira: escolha um provedor e as cartas saem dos jogos dele.</p></div>';
    $("#ly_body").innerHTML = `
      <div class="dsh-sec"><h2>Pacotes</h2></div>
      <div class="tcard in-card">
        <div class="in-status"><span class="tag ${st.enabled ? "on" : "off"}">${st.enabled ? "ligadas" : "desligadas"}</span><span>${when(st)}</span></div>
        <div class="in-grid">
          <div class="full"><label class="ly-check"><input type="checkbox" id="cs_on"${st.enabled ? " checked" : ""} /> Coleções ligadas (desligadas, o site mostra "pausadas" e ninguém abre pacote)</label></div>
          <div><label class="lbl" for="cs_every">A cada quanto apostado o jogador ganha 1 pacote (R$)</label><input id="cs_every" value="${val(st.packEvery)}" inputmode="decimal" /></div>
          <div><label class="lbl" for="cs_per">Cartas por pacote</label><input id="cs_per" type="number" min="1" max="10" value="${st.cardsPerPack}" /></div>
        </div>
        <div class="msg2" id="cs_msg" role="status"></div>
        <div class="in-actions"><button class="primary" id="cs_save">Salvar pacotes</button></div>
      </div>
      <div class="dsh-sec ly-sec"><h2>Coleções</h2><button class="primary" id="cl_new">Nova coleção</button></div>
      <div id="cl_editor"></div>
      <div class="msg2" id="cl_msg" role="status"></div>
      ${list}`;
    if (flash) say("#cl_msg", flash.text, flash.ok !== false);
    $("#cs_save").onclick = saveSettings;
    $("#cl_new").onclick = () => { editing = { id: null, name: "", description: "", reward: 20, active: true, sortOrder: col.collections.length, cards: [] }; renderEditor(); };
    $$("#ly_body [data-edit]").forEach((b) => (b.onclick = () => {
      const c = col.collections.find((x) => x.id === b.dataset.edit);
      editing = { id: c.id, name: c.name, description: c.description, reward: c.reward, active: c.active, sortOrder: c.sortOrder, cards: c.cards.map((x) => ({ ...x })) };
      renderEditor();
    }));
    $$("#ly_body [data-del]").forEach((b) => (b.onclick = async () => {
      const c = col.collections.find((x) => x.id === b.dataset.del);
      if (!confirm(`Excluir a coleção "${c.name}"? As cartas que os jogadores já têm dela somem junto.`)) return;
      try { col = await CA.api(`/admin/collections/${encodeURIComponent(c.id)}`, { method: "DELETE" }); renderCollections({ text: "Coleção excluída." }); }
      catch (e) { say("#cl_msg", e.message, false); }
    }));
  }
  async function saveSettings() {
    const packEvery = num($("#cs_every").value), cardsPerPack = Number($("#cs_per").value);
    if (!Number.isFinite(packEvery) || packEvery < 1) return say("#cs_msg", "Informe um valor de pelo menos R$ 1 por pacote", false);
    say("#cs_msg", "Salvando…");
    try {
      col = await CA.api("/admin/collections/settings", { method: "PUT", body: JSON.stringify({ enabled: $("#cs_on").checked, packEvery, cardsPerPack }) });
      renderCollections();
      say("#cs_msg", "Salvo ✓");
    } catch (e) { say("#cs_msg", e.message, false); }
  }
  function renderEditor(flash) {
    const e = editing, box = $("#cl_editor");
    if (!e) { box.innerHTML = ""; return; }
    const provOpts = providers.filter((p) => p.games > 0).map((p) => `<option value="${esc(p.slug)}">${esc(p.name)} (${p.games})</option>`).join("");
    box.innerHTML = `<div class="tcard in-card ly-editor">
      <h3>${e.id ? "Editar coleção" : "Nova coleção"}</h3>
      <div class="in-grid">
        <div><label class="lbl" for="ce_name">Nome</label><input id="ce_name" maxlength="60" value="${esc(e.name)}" placeholder="ex.: Lendas da PG Soft" /></div>
        <div><label class="lbl" for="ce_reward">Prêmio ao completar (R$)</label><input id="ce_reward" value="${val(e.reward)}" inputmode="decimal" /></div>
        <div class="full"><label class="lbl" for="ce_desc">Descrição (opcional)</label><input id="ce_desc" maxlength="200" value="${esc(e.description)}" /></div>
        <div><label class="lbl" for="ce_order">Ordem no site (menor = primeiro)</label><input id="ce_order" type="number" min="0" max="9999" value="${e.sortOrder}" /></div>
        <div><label class="ly-check ly-check-pad"><input type="checkbox" id="ce_active"${e.active ? " checked" : ""} /> Aberta no site</label></div>
      </div>
      <div class="ly-cards-h"><b>Cartas (${e.cards.length})</b><span class="in-help">Cada carta é um jogo. Clique numa carta para tirá-la.</span></div>
      <div class="ly-cards" id="ce_cards">${e.cards.length ? e.cards.map((c, i) => `<button type="button" class="ly-card" data-rmcard="${i}" title="Tirar ${esc(c.name)}">${thumb(c)}<span>${esc(c.name)}</span></button>`).join("") : '<span class="hint">Nenhuma carta ainda — use as opções abaixo.</span>'}</div>
      <div class="ly-add">
        <div><label class="lbl" for="ce_prov">Preencher com jogos de um provedor</label>
          <div class="ly-inline"><select id="ce_prov">${provOpts}</select><input id="ce_count" type="number" min="1" max="60" value="9" aria-label="Quantas cartas" /><button class="btn2 gray" id="ce_fill">Adicionar</button></div></div>
        <div><label class="lbl" for="ce_q">Ou busque um jogo pelo nome</label>
          <div class="ly-inline"><input id="ce_q" placeholder="ex.: Fortune Tiger" /><button class="btn2 gray" id="ce_search">Buscar</button></div>
          <div class="ly-results" id="ce_results"></div></div>
      </div>
      <div class="msg2" id="ce_msg" role="status"></div>
      <div class="in-actions"><button class="primary" id="ce_save">${e.id ? "Salvar coleção" : "Criar coleção"}</button><button class="btn2 gray" id="ce_cancel">Cancelar</button></div>
    </div>`;
    if (flash) say("#ce_msg", flash.text, flash.ok !== false);
    const keep = () => { e.name = $("#ce_name").value; e.description = $("#ce_desc").value; e.reward = num($("#ce_reward").value); e.sortOrder = Number($("#ce_order").value) || 0; e.active = $("#ce_active").checked; };
    const addCards = (games) => {
      keep();
      const have = new Set(e.cards.map((c) => c.gameId));
      const fresh = games.filter((g) => !have.has(g.id)).map((g) => ({ gameId: g.id, name: g.name, imageUrl: g.imageUrl, provider: g.provider }));
      e.cards.push(...fresh);
      renderEditor({ text: fresh.length ? `${fresh.length} carta(s) adicionada(s).` : "Esses jogos já estão na coleção." });
    };
    $$("#ce_cards [data-rmcard]").forEach((b) => (b.onclick = () => { keep(); e.cards.splice(Number(b.dataset.rmcard), 1); renderEditor(); }));
    $("#ce_fill").onclick = async () => {
      try { addCards(await CA.api("/admin/collections/autofill", { method: "POST", body: JSON.stringify({ providerSlug: $("#ce_prov").value, count: Math.min(60, Math.max(1, Number($("#ce_count").value) || 9)) }) })); }
      catch (err) { say("#ce_msg", err.message, false); }
    };
    const search = async () => {
      const q = $("#ce_q").value.trim();
      if (q.length < 2) return say("#ce_msg", "Digite pelo menos 2 letras", false);
      try {
        const games = await CA.api(`/admin/collections/games?q=${encodeURIComponent(q)}`);
        $("#ce_results").innerHTML = games.length ? games.map((g, i) => `<button type="button" class="ly-res" data-pick="${i}">${thumb(g)}<span>${esc(g.name)}<small>${esc(g.provider)}${g.active ? "" : " · fora do site"}</small></span><b>+</b></button>`).join("") : '<span class="hint">Nada encontrado.</span>';
        $$("#ce_results [data-pick]").forEach((b) => (b.onclick = () => addCards([games[Number(b.dataset.pick)]])));
      } catch (err) { say("#ce_msg", err.message, false); }
    };
    $("#ce_search").onclick = search;
    $("#ce_q").onkeydown = (ev) => { if (ev.key === "Enter") search(); };
    $("#ce_cancel").onclick = () => { editing = null; renderEditor(); };
    $("#ce_save").onclick = async () => {
      keep();
      if (!e.name.trim()) return say("#ce_msg", "Dê um nome à coleção", false);
      if (!Number.isFinite(e.reward) || e.reward < 0) return say("#ce_msg", "Confira o prêmio", false);
      if (!e.cards.length) return say("#ce_msg", "Escolha pelo menos uma carta", false);
      if (e.id && !confirm("Salvar? Cartas tiradas da coleção somem também do álbum dos jogadores.")) return;
      say("#ce_msg", "Salvando…");
      const body = { name: e.name.trim(), description: e.description.trim(), reward: e.reward, active: e.active, sortOrder: e.sortOrder, gameIds: e.cards.map((c) => c.gameId) };
      try {
        col = await CA.api(e.id ? `/admin/collections/${encodeURIComponent(e.id)}` : "/admin/collections", { method: e.id ? "PUT" : "POST", body: JSON.stringify(body) });
        const created = !e.id;
        editing = null;
        renderCollections({ text: created ? "Coleção criada ✓ — já aparece no site." : "Coleção salva ✓" });
      } catch (err) { say("#ce_msg", err.message, false); }
    };
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  CA.registerViews({ vip: () => showVip(), collections: () => showCollections() });
})();
