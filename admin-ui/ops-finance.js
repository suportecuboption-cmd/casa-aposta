/* ══════════════ Operação — Faturas (demonstrativo mensal de custo do agregador) ══════════════ */
(function () {
  "use strict";
  const CA = window.CA, esc = CA.escA, money = CA.money, int = CA.int, ICON = CA.ICON;
  const $ = CA.$, $$ = CA.$$;
  const pct = (v) => (v == null ? "—" : v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + "%");
  const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const monthLabel = (m) => { const [y, mm] = m.split("-"); return `${MES[+mm - 1]} ${y}`; };
  const STATUS_TONE = { "Pago": "green", "Em aberto": "red", "Sem custo": "gray", "Pagamento parcial": "orange", "Parcial · pagamento parcial": "orange", "Parcial publicado": "blue" };
  const stBadge = (s) => CA.badge(s, STATUS_TONE[s] || "gray");

  let months = null, current = null, selected = null, openWeek = null;

  async function load(month) {
    const seq = CA.bumpSeq();
    let list;
    try { list = await CA.api("/admin/ops/invoices"); } catch (e) { if (seq === CA.seq()) CA.render(CA.opHead({ title: "Faturas", icon: ICON.invoice }) + CA.empty("Não foi possível carregar", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    months = list.months; current = list.current;
    selected = month || (months[0] && months[0].month);
    if (!selected) { CA.render(CA.opHead({ title: "Faturas", icon: ICON.invoice }) + CA.empty("Sem faturas", "Ainda não há movimento de jogo para gerar faturas.")); return; }
    let det;
    try { det = await CA.api(`/admin/ops/invoices/${selected}`); } catch (e) { CA.render(CA.opHead({ title: "Faturas", icon: ICON.invoice }) + CA.empty("Não foi possível abrir a fatura", e.message, ICON.warn)); return; }
    if (seq !== CA.seq()) return;
    paint(det);
  }

  function paint(det) {
    const head = CA.opHead({
      title: "Faturas", sub: "Demonstrativo mensal do custo cobrado pelo agregador sobre o GGR.", icon: ICON.invoice,
      actions: `${CA.isAdmin() ? `<button type="button" class="op-btn" data-params>${ICON.edit}Parâmetros de custo</button>` : ""}<button type="button" class="op-btn" data-reload>${ICON.refresh}Atualizar</button>`,
    });
    const monthsList = `<div class="inv-months"><h4>Competências</h4>${months.map((m) => `<button type="button" class="inv-m ${m.month === selected ? "on" : ""}" data-month="${m.month}">
        <div class="m-top"><b>${monthLabel(m.month)}${m.month === current ? " · atual" : ""}</b>${stBadge(m.status)}</div>
        <div class="m-row"><span>Custo</span><b>${money(m.total)}</b>${m.missingPct ? `<span class="warn-ic" title="Há provedor sem % definido">${ICON.warn}</span>` : ""}</div>
        <div class="m-due"><span>A pagar</span><b class="${m.due > 0 ? "v-red" : "v-green"}">${money(m.due)}</b></div>
      </button>`).join("")}</div>`;
    CA.render(head + `<div class="inv-wrap">${monthsList}<div class="inv-doc">${doc(det)}</div></div>`);
    const root = CA.view();
    $("[data-reload]", root).onclick = () => load(selected);
    const pb = $("[data-params]", root); if (pb) pb.onclick = () => editParams(det.params, det.providers);
    $$("[data-month]", root).forEach((b) => (b.onclick = () => { selected = b.dataset.month; openWeek = null; load(selected); }));
    wireDoc(det);
  }

  function doc(d) {
    const missing = d.missingPct ? `<div class="alert-banner warn" style="margin-bottom:14px"><div style="display:flex;gap:12px;align-items:center"><div class="ab-ic" style="background:rgba(245,158,11,.15);color:#f59e0b">${ICON.warn}</div><div><b>Provedor sem % de custo</b> — defina o percentual em "Parâmetros de custo" para calcular o valor.</div></div></div>` : "";
    const meta = `<div class="inv-top">
        <div class="inv-meta">
          <div class="g">
            <div><span>Competência</span><b>${monthLabel(d.month)}</b></div>
            <div><span>Status</span><b>${stBadge(d.status)}</b></div>
            <div><span>Período</span><b>${CA.dmy(d.period.from)} – ${CA.dmy(d.period.to)}</b></div>
            <div><span>GGR do mês</span><b class="${d.totalGgr >= 0 ? "v-green" : "v-red"}">${money(d.totalGgr)}</b></div>
          </div>
          <div class="parties">Emissor <b style="color:var(--text)">${esc(d.issuer)}</b> · Tomador <b style="color:var(--text)">${esc(d.taker)}</b></div>
        </div>
        <div class="inv-due"><span class="inv-cap">Total a pagar</span><b class="${d.due > 0 ? "v-red" : "v-green"}">${money(d.due)}</b>
          <span>custo ${money(d.totalCost)} · pago ${money(d.paid)}</span>${d.usd.due != null ? `<span>US$ ${d.usd.due.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>` : ""}</div>
      </div>`;
    const provs = `<div class="inv-sec"><span>Custo por provedor</span></div>
      <div class="fin-tbl">
        ${d.providers.length ? d.providers.map((p, i) => `<div class="fin-row ${i % 2 ? "alt" : ""}">
          <div><b>${esc(p.name)}</b>${p.negative ? ` ${CA.badge("GGR negativo", "gray")}` : ""}</div>
          <div class="r"><b>${p.cost == null ? "—" : money(p.cost)}</b><small>GGR ${money(p.ggr)} · ${p.pct == null ? "sem %" : pct(p.pct)}</small></div>
        </div>`).join("") : `<div class="fin-row"><div class="muted">Sem atividade neste mês.</div></div>`}
        <div class="fin-row total"><div>Total do mês</div><div class="r">${money(d.totalCost)}</div></div>
      </div>`;
    const weeks = `<div class="inv-sec"><span>Por semana</span></div>
      <div class="fin-tbl">${d.weeks.map((w) => `<button type="button" class="week-row" data-week="${w.n}">
          <div><b>Semana ${w.n}</b><small>${CA.dmy(w.from)} – ${CA.dmy(w.to)}</small></div>
          <div class="r"><b class="${w.cost < 0 ? "v-red" : ""}">${money(w.cost)}</b></div>
        </button>
        <div class="week-days" data-week-days="${w.n}" ${openWeek === w.n ? "" : "hidden"}>${w.days.map((dd) => `<div><span>${CA.dmy(dd.day)}</span><span class="${dd.cost < 0 ? "v-red" : ""}">${money(dd.cost)}</span></div>`).join("")}</div>`).join("")}
      </div>`;
    const pays = `<div class="inv-sec"><span>Pagamentos</span>${CA.isFinance() ? `<button type="button" class="op-btn sm green" data-addpay>${ICON.plus}Registrar pagamento</button>` : ""}</div>
      ${d.payments.length ? `<div class="fin-tbl">${d.payments.map((p) => `<div class="fin-row"><div><b>${money(p.amount)}</b><small>${CA.fdate(p.paidAt)}${p.note ? " · " + esc(p.note) : ""}</small></div>
        <div class="r">${CA.isAdmin() ? `<button type="button" class="icon-btn" title="Remover" data-delpay="${p.id}">${ICON.trash}</button>` : ""}</div></div>`).join("")}</div>`
        : `<div class="dashed">Nenhum pagamento registrado nesta competência.</div>`}`;
    return missing + meta + provs + weeks + pays;
  }

  function wireDoc(d) {
    const root = CA.view();
    $$("[data-week]", root).forEach((b) => (b.onclick = () => {
      const n = +b.dataset.week; openWeek = openWeek === n ? null : n;
      $$("[data-week-days]", root).forEach((el) => (el.hidden = +el.dataset.weekDays !== openWeek));
    }));
    const ap = $("[data-addpay]", root); if (ap) ap.onclick = () => addPayment(d);
    $$("[data-delpay]", root).forEach((b) => (b.onclick = async () => {
      if (await CA.confirm({ title: "Remover pagamento", message: "Remover este pagamento da competência?", danger: true, confirmLabel: "Remover" })) {
        await CA.call(`/admin/ops/invoices/payments/${b.dataset.delpay}`, { method: "DELETE" }); CA.toast("Pagamento removido"); load(selected);
      }
    }));
  }

  function addPayment(d) {
    const bg = CA.modal({
      title: `Registrar pagamento · ${monthLabel(d.month)}`,
      body: `<p class="op-note" style="margin:0 0 10px">A pagar nesta competência: <b style="color:var(--text)">${money(d.due)}</b>.</p>
             ${CA.field("Valor pago (R$)", CA.num("amount", { value: d.due > 0 ? d.due : "", min: "0" }))}
             ${CA.field("Data do pagamento", `<input type="date" data-f="paidAt" value="${CA.todaySP()}" />`)}
             ${CA.field("Observação (opcional)", `<input data-f="note" placeholder="ex.: PIX agregador" />`)}`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Registrar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const f = CA.readForm(bg), amount = Number(f.amount);
      if (!(amount > 0)) { $("[data-msg]", bg).textContent = "Informe um valor maior que zero."; return; }
      try { await CA.api(`/admin/ops/invoices/${d.month}/payments`, { method: "POST", body: JSON.stringify({ amount, paidAt: f.paidAt, note: f.note || undefined }) }); CA.closeModal(); CA.toast("Pagamento registrado"); load(selected); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }

  // Parâmetros de custo: emissor, % padrão e % por provedor (os provedores do mês vêm pré-listados).
  function editParams(params, providers) {
    const known = new Set(Object.keys(params.providers || {}));
    (providers || []).forEach((p) => known.add(p.name));
    const provRows = [...known].sort().map((name) => `<div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <span style="flex:1;font-size:13px">${esc(name)}</span>
        <input type="number" min="0" max="100" step="0.01" data-prov="${esc(name)}" value="${params.providers && params.providers[name] != null ? params.providers[name] : ""}" placeholder="padrão" style="width:110px;margin:0" /> <span class="muted">%</span>
      </div>`).join("");
    const bg = CA.modal({
      title: "Parâmetros de custo da fatura", wide: true,
      body: `${CA.field("Emissor (agregador)", `<input data-f="issuer" value="${esc(params.issuer || "PlayFivers")}" />`)}
             ${CA.field("% padrão (quando o provedor não tem % próprio)", `<input type="number" min="0" max="100" step="0.01" data-f="defaultPct" value="${params.defaultPct != null ? params.defaultPct : ""}" placeholder="ex.: 12" />`)}
             <div class="sec-cap">% por provedor</div>
             ${provRows || `<p class="op-note">Nenhum provedor com atividade ainda.</p>`}
             <p class="op-note" style="margin-top:10px">Deixe um provedor em branco para usar o % padrão. O custo é calculado só sobre GGR positivo.</p>`,
      footer: `<span class="msg" data-msg></span><button type="button" class="op-btn" data-no>Cancelar</button><button type="button" class="op-btn green" data-yes>Salvar</button>`,
    });
    $("[data-no]", bg).onclick = CA.closeModal;
    $("[data-yes]", bg).onclick = async () => {
      const issuer = $("[data-f=issuer]", bg).value.trim();
      const dp = $("[data-f=defaultPct]", bg).value;
      const prov = {};
      $$("[data-prov]", bg).forEach((el) => { if (el.value !== "") prov[el.dataset.prov] = Number(el.value); });
      if (issuer.length < 2) { $("[data-msg]", bg).textContent = "Informe o emissor."; return; }
      try { await CA.api("/admin/ops/invoices/params", { method: "PUT", body: JSON.stringify({ issuer, defaultPct: dp === "" ? null : Number(dp), providers: prov }) }); CA.closeModal(); CA.toast("Parâmetros salvos"); load(selected); }
      catch (e) { $("[data-msg]", bg).textContent = e.message; }
    };
  }

  CA.registerViews({ invoices: () => load(selected) });
})();
