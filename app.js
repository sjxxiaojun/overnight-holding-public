const fmtPct = (value) => `${(value * 100).toFixed(1)}%`;
const num = (value, digits = 2) => Number(value || 0).toFixed(digits);

function byId(id) {
  return document.getElementById(id);
}

function historyEntries(history) {
  return Object.entries(history || {})
    .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, record]) => ({ date, ...record }));
}

function latestVerified(entries) {
  return [...entries].reverse().find((record) => typeof record.win_rate === "number") || null;
}

function modeFor(winRate, pickCount) {
  if (typeof winRate === "number" && winRate < 0.5) return "稳健防守";
  if (typeof winRate === "number" && winRate >= 0.7) return "激进进攻";
  return pickCount >= 3 ? "激进进攻" : "稳健防守";
}

function resultLabel(pick, recordVerified) {
  if (pick.reached_target === true) return "是";
  if (pick.reached_target === false) return "否";
  return recordVerified ? "汇总已验证" : "待验证";
}

function renderPicks(picks) {
  const list = byId("stockList");
  if (!picks.length) {
    list.innerHTML = `<div class="empty">今日没有满足严格条件的标的，建议空仓。</div>`;
    return;
  }
  list.innerHTML = picks.map((pick) => {
    const range = pick.trigger_range || `${pick.trigger_low} - ${pick.trigger_high}`;
    return `
      <article class="stock-card">
        <header class="stock-head">
          <div>
            <h2>${pick.name}</h2>
            <span class="stock-code">${pick.symkey}</span>
          </div>
          <div class="stock-score">${pick.score ?? "--"}</div>
        </header>
        <div class="stock-fields">
          <div class="field"><span>信号价</span><strong>${num(pick.buy_price)}</strong></div>
          <div class="field"><span>触发区间</span><strong>${range}</strong></div>
        </div>
        <p class="plan">${pick.plan || ""}</p>
        <footer class="stock-footer">
          <span class="chip">仓位 ${pick.position || "8%"}</span>
          <span class="chip danger">止损 ${num(pick.stop_loss)}</span>
          <span class="chip cold">止盈 ${num(pick.take_profit)}</span>
        </footer>
      </article>`;
  }).join("");
}

function renderAvoid(items) {
  byId("avoidList").innerHTML = items.length ? items.map((item) => `
    <article class="avoid-card">
      <strong>${item.name}</strong>
      <span class="chip">${item.symkey}</span>
      <p>${item.reason}</p>
    </article>
  `).join("") : `<div class="empty">暂无避险名单。</div>`;
}

function renderParams(params) {
  byId("paramList").innerHTML = `
    <div><dt>最小成交额</dt><dd>${num((params.min_turnover || 0) / 100000000, 2)} 亿</dd></div>
    <div><dt>MA10 偏离</dt><dd>${num((params.max_dist_ma10 || 0) * 100, 1)}%</dd></div>
    <div><dt>最大振幅</dt><dd>${num((params.max_amplitude || 0) * 100, 1)}%</dd></div>
    <div><dt>5 日跌幅阈值</dt><dd>${num((params.min_drop_5d || 0) * 100, 1)}%</dd></div>
  `;
}

function renderBars(verified) {
  byId("bars").innerHTML = verified.length ? verified.slice(-15).map((record) => {
    const pct = Math.round(record.win_rate * 100);
    return `
      <div class="bar">
        <span>${pct}%</span>
        <i style="height:${Math.max(pct, 4)}%"></i>
        <b>${record.date.slice(5)}</b>
      </div>`;
  }).join("") : `<div class="empty">暂无已验证数据。</div>`;
}

function renderHistory(entries) {
  byId("historyList").innerHTML = [...entries].reverse().map((record) => {
    const verified = typeof record.win_rate === "number";
    const mode = modeFor(record.win_rate, (record.picks || []).length);
    const aggregateOnly = verified && !(record.picks || []).some((pick) => pick.reached_target != null);
    const rows = (record.picks || []).map((pick) => `
      <div class="history-row">
        <span><b>${pick.name}</b><small class="muted">${pick.symkey}</small></span>
        <span>${num(pick.buy_price)}</span>
        <span>${pick.today_high || "--"}</span>
        <span>${pick.price_change_str || "--"}</span>
        <span>${resultLabel(pick, verified)}</span>
      </div>
    `).join("");
    return `
      <article class="history-card">
        <div class="history-head">
          <strong>${record.date}</strong>
          <span class="${mode === "稳健防守" ? "cold" : "hot"}">${mode}</span>
          <span>${verified ? fmtPct(record.win_rate) : "待验证"}</span>
        </div>
        ${aggregateOnly ? `<p class="aggregate-note">本地快照已保存汇总胜率，未保存逐票最高价明细。</p>` : ""}
        ${rows}
      </article>`;
  }).join("");
}

async function main() {
  const [state, meta] = await Promise.all([
    fetch("./data/state.json").then((response) => response.json()),
    fetch("./data/meta.json").then((response) => response.json()).catch(() => ({})),
  ]);
  const entries = historyEntries(state.history);
  const latest = entries[entries.length - 1] || null;
  const verified = entries.filter((record) => typeof record.win_rate === "number");
  const lastVerified = latestVerified(entries);
  const displayWinRate = latest?.win_rate ?? lastVerified?.win_rate;
  const mode = modeFor(displayWinRate, (latest?.picks || []).length);
  const avg = verified.length
    ? verified.reduce((sum, record) => sum + record.win_rate, 0) / verified.length
    : 0;

  byId("syncTime").textContent = meta.generatedAt ? `同步于 ${meta.generatedAt}` : "本地快照";
  byId("latestDate").textContent = latest?.date || "--";
  byId("mode").textContent = mode;
  byId("mode").className = mode === "稳健防守" ? "cold" : "hot";
  byId("winRate").textContent = typeof displayWinRate === "number" ? fmtPct(displayWinRate) : "待验证";
  byId("todayNote").textContent = lastVerified
    ? `最近一次验证：${lastVerified.date}，胜率 ${fmtPct(lastVerified.win_rate)}。`
    : "暂无验证数据。";
  byId("totalDays").textContent = String(entries.length);
  byId("verifiedDays").textContent = String(verified.length);
  byId("avgRate").textContent = fmtPct(avg);

  renderPicks(latest?.picks || []);
  renderAvoid(latest?.avoid_buys || []);
  renderParams(state.params || {});
  renderBars(verified);
  renderHistory(entries);
}

main().catch((error) => {
  document.body.innerHTML = `<main class="shell"><div class="empty">页面载入失败：${error.message}</div></main>`;
});
