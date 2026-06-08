import { readFile, writeFile } from "node:fs/promises";

const BASE_URL = "https://market.ft.tech";
const HEADERS = {
  "X-Client-Name": "ft-claw",
  "Content-Type": "application/json",
};

const STATE_PATH = new URL("../data/state.json", import.meta.url);
const META_PATH = new URL("../data/meta.json", import.meta.url);

const DEFAULT_PARAMS = {
  min_turnover: 300000000,
  max_dist_ma10: 0.12,
  max_amplitude: 0.15,
  min_drop_5d: -0.15,
};

const MAINLINE_KEYWORDS = ["富联", "旭创", "澜起", "兆易", "阳光电源", "芯片", "半导体", "光通信", "光模块", "服务器", "储能"];
const AVOID_KEYWORDS = ["卫星", "航天", "军工", "光", "芯", "科技", "通信", "半导体", "智能", "阳光", "富联", "旭创", "澜起", "兆易", "电子", "芯原", "光迅"];

function safeNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function marketDateFromCandle(candle) {
  return new Date(candle.otm + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function historyDates(state) {
  return Object.keys(state.history || {})
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort((a, b) => a.localeCompare(b));
}

async function safeApiCall(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        headers: HEADERS,
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
    } catch {
      // Retry below.
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 700 + attempt * 300));
  }
  return null;
}

function fetchOhlc(symkey, limit = 60) {
  return safeApiCall(`${BASE_URL}/app/api/v2/stocks/${symkey}/ohlcs?span=DAY1&limit=${limit}`);
}

async function fetchLatestTradingDate() {
  const data = await fetchOhlc("601138.XSHG", 2);
  const candles = data?.ohlcs ?? [];
  if (!candles.length) return null;
  return marketDateFromCandle(candles[candles.length - 1]);
}

function previousRecordWithPicks(state, targetDate) {
  const dates = historyDates(state).reverse();
  for (const date of dates) {
    const record = state.history[date];
    if (date < targetDate && Array.isArray(record?.picks) && record.picks.length > 0) {
      return { date, record };
    }
  }
  return null;
}

async function verifyPreviousPicks(state, targetDate) {
  const previous = previousRecordWithPicks(state, targetDate);
  if (!previous) {
    return { verified: false, previousDate: null, total: 0, wins: 0, message: "没有可验证的前一日持仓数据。" };
  }

  const hasDetails = previous.record.picks.every((pick) => pick.reached_target != null && pick.today_high);
  if (previous.record.verified_on === targetDate && hasDetails) {
    const wins = previous.record.picks.filter((pick) => pick.reached_target).length;
    return {
      verified: true,
      previousDate: previous.date,
      total: previous.record.picks.length,
      wins,
      winRate: safeNumber(previous.record.win_rate),
      message: `${previous.date} 已在 ${targetDate} 验证过。`,
    };
  }

  let wins = 0;
  let total = 0;
  const verifiedPicks = [];

  for (const pick of previous.record.picks) {
    const nextPick = { ...pick };
    const buyPrice = safeNumber(pick.buy_price);
    const data = await fetchOhlc(pick.symkey, 20);
    const candle = (data?.ohlcs ?? []).find((item) => marketDateFromCandle(item) === targetDate);
    if (candle && buyPrice > 0) {
      total += 1;
      const profit = (candle.h - buyPrice) / buyPrice;
      const passed = profit >= 0.02;
      if (passed) wins += 1;
      nextPick.today_high = candle.h.toFixed(2);
      nextPick.price_change = round2(profit * 100);
      nextPick.price_change_str = `${profit >= 0 ? "+" : ""}${(profit * 100).toFixed(2)}%`;
      nextPick.reached_target = passed;
    }
    verifiedPicks.push(nextPick);
  }

  if (total > 0) {
    previous.record.picks = verifiedPicks;
    previous.record.win_rate = wins / total;
    previous.record.verified_on = targetDate;
  }

  return {
    verified: total > 0,
    previousDate: previous.date,
    total,
    wins,
    winRate: total > 0 ? wins / total : 0,
    message: total > 0 ? `验证完毕：${total} 只标的，${wins} 只达到 >2% 次日冲高。` : `${targetDate} 未找到可用于验证的行情数据。`,
  };
}

function optimizeParams(state) {
  const dates = historyDates(state);
  state.params = { ...DEFAULT_PARAMS, ...(state.params || {}) };
  if (!dates.length) return { modeSignal: "保持", params: state.params, previousDate: null };

  const lastDate = dates[dates.length - 1];
  const lastWinRate = state.history[lastDate]?.win_rate;
  if (typeof lastWinRate !== "number" || !Number.isFinite(lastWinRate)) {
    return { modeSignal: "保持", params: state.params, previousDate: null };
  }

  let modeSignal = "保持";
  if (lastWinRate < 0.5) {
    modeSignal = "收紧";
    state.params.min_turnover = Math.min(800000000, Math.round(state.params.min_turnover * 1.2));
    state.params.max_dist_ma10 = Math.max(0.01, state.params.max_dist_ma10 * 0.8);
    state.params.max_amplitude = Math.max(0.06, state.params.max_amplitude * 0.9);
    state.params.min_drop_5d = Math.max(-0.08, state.params.min_drop_5d * 0.8);
  } else if (lastWinRate >= 0.7) {
    modeSignal = "放宽";
    state.params.min_turnover = Math.max(200000000, Math.round(state.params.min_turnover * 0.9));
    state.params.max_dist_ma10 = Math.min(0.08, state.params.max_dist_ma10 * 1.1);
    state.params.max_amplitude = Math.min(0.15, state.params.max_amplitude * 1.1);
    state.params.min_drop_5d = Math.min(-0.15, state.params.min_drop_5d * 1.1);
  }

  return { modeSignal, params: state.params, previousDate: lastDate, winRate: lastWinRate };
}

function generateStockPlan(name, isChuangye) {
  if (name.includes("工业富联")) return "次日冲高优先兑现；弱开09:45不收复买入价退出";
  if (name.includes("澜起")) return "只做10日线附近修复，不追；弱开不收复退出";
  if (name.includes("兆易")) return "半导体强势但涨幅已大，必须区间内低吸";
  if (name.includes("中际")) return "光模块核心票回踩修复，高波动只试仓";
  if (name.includes("阳光")) return "储能/新能源方向放量修复，次日不强就按规则退出";
  if (isChuangye) return "高波动标的，注意10日线附近低吸试仓，次日弱开按规则退出";
  return "主板标的，次日冲高优先兑现；弱开跌破买入价分批退出";
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const chunk = items.slice(index, index + concurrency);
    const results = await Promise.all(chunk.map(mapper));
    output.push(...results.filter(Boolean));
  }
  return output;
}

function pickAvoidList(filteredStocks) {
  const avoidList = [];

  let feiDao = null;
  for (const stock of filteredStocks) {
    if (stock.change_rate <= -0.06 && stock.change_rate < 0.19 && AVOID_KEYWORDS.some((keyword) => stock.name.includes(keyword))) {
      if (!feiDao || stock.drop_5d < feiDao.drop_5d) feiDao = stock;
    }
  }
  if (!feiDao) {
    for (const stock of filteredStocks) {
      if (stock.change_rate <= -0.06 && stock.change_rate < 0.19) {
        if (!feiDao || stock.drop_5d < feiDao.drop_5d) feiDao = stock;
      }
    }
  }
  if (feiDao) avoidList.push(feiDao);

  let fenQi = null;
  for (const stock of filteredStocks) {
    const isLimitUp = Math.abs(stock.change_rate - 0.1) < 0.01 || Math.abs(stock.change_rate - 0.2) < 0.01;
    if (!avoidList.includes(stock) && stock.change_rate >= 0.08 && stock.change_rate < 0.19 && !isLimitUp && AVOID_KEYWORDS.some((keyword) => stock.name.includes(keyword))) {
      if (!fenQi || stock.change_rate > fenQi.change_rate) fenQi = stock;
    }
  }
  if (!fenQi) {
    for (const stock of filteredStocks) {
      const isLimitUp = Math.abs(stock.change_rate - 0.1) < 0.01 || Math.abs(stock.change_rate - 0.2) < 0.01;
      if (!avoidList.includes(stock) && stock.change_rate >= 0.08 && stock.change_rate < 0.19 && !isLimitUp) {
        if (!fenQi || stock.change_rate > fenQi.change_rate) fenQi = stock;
      }
    }
  }
  if (fenQi) avoidList.push(fenQi);

  let pianGao = null;
  for (const stock of filteredStocks) {
    if (!avoidList.includes(stock) && stock.change_rate < 0.19 && AVOID_KEYWORDS.some((keyword) => stock.name.includes(keyword)) && stock.dist_ma10 > 0.1) {
      if (!pianGao || stock.dist_ma10 > pianGao.dist_ma10) pianGao = stock;
    }
  }
  if (!pianGao) {
    for (const stock of filteredStocks) {
      if (!avoidList.includes(stock) && stock.change_rate < 0.19) {
        if (!pianGao || stock.dist_ma10 > pianGao.dist_ma10) pianGao = stock;
      }
    }
  }
  if (pianGao) avoidList.push(pianGao);

  for (const stock of filteredStocks) {
    if (avoidList.length >= 3) break;
    if (!avoidList.includes(stock) && stock.change_rate < 0.19) avoidList.push(stock);
  }

  return avoidList.slice(0, 3).map((stock) => ({
    symkey: stock.symkey,
    name: stock.name,
    reason: stock.reason,
  }));
}

async function scanToday(targetDate, params) {
  const quotes = await safeApiCall(`${BASE_URL}/app/api/v2/stocks?order_by=turnover%20desc&page_no=1&page_size=150`);
  if (!quotes?.stocks) throw new Error("无法获取股票列表");

  const candidates = quotes.stocks.filter((stock) => !stock.name.toUpperCase().includes("ST") && !stock.name.includes("退"));
  const stockDataList = await mapWithConcurrency(candidates, 30, async (stock) => {
    const ohlcData = await fetchOhlc(stock.symkey, 60);
    if (!ohlcData?.ohlcs || ohlcData.ohlcs.length < 10) return null;
    return { stock, ohlcData };
  });

  const scoredStocks = [];
  const filteredStocks = [];

  for (const { stock, ohlcData } of stockDataList) {
    const ohlcs = ohlcData.ohlcs ?? [];
    const ma10 = ohlcData.ma10 ?? [];
    const ma20 = ohlcData.ma20 ?? [];
    const todayIdx = ohlcs.findIndex((candle) => marketDateFromCandle(candle) === targetDate);
    if (todayIdx < 1 || todayIdx >= ma10.length) continue;

    const today = ohlcs[todayIdx];
    const yesterday = ohlcs[todayIdx - 1];
    const changeRate = (today.c - yesterday.c) / yesterday.c;
    const amplitude = (today.h - today.l) / yesterday.c;
    const close5dAgo = ohlcs[Math.max(0, todayIdx - 5)].c;
    const drop5d = (today.c - close5dAgo) / close5dAgo;
    const ma10Value = ma10[todayIdx]?.p ?? null;
    const ma20Value = ma20[todayIdx]?.p ?? null;
    const distMa10 = ma10Value ? Math.abs(today.c - ma10Value) / ma10Value : 0;
    const isLimitDown = Math.abs(changeRate - -0.1) < 0.01 || Math.abs(changeRate - -0.2) < 0.01;
    const isLimitUp = Math.abs(changeRate - 0.1) < 0.01 || Math.abs(changeRate - 0.2) < 0.01;

    let isFiltered = false;
    let reason = "";
    if (changeRate < -0.02 || changeRate > 0.035) {
      isFiltered = true;
      if (changeRate < -0.02) {
        reason = `跌幅约${(changeRate * 100).toFixed(1)}%${isLimitDown ? "且跌停" : ""}，5日跌幅约${(drop5d * 100).toFixed(1)}%，属于高位急跌，不适合尾盘接飞刀`;
      } else {
        reason = `涨幅约${(changeRate * 100).toFixed(1)}%${isLimitUp ? "且涨停" : ""}、振幅约${(amplitude * 100).toFixed(1)}%，强但不是低吸点，次日容易分歧`;
      }
    }

    if (!isFiltered && ma10Value != null) {
      if (amplitude > params.max_amplitude) {
        isFiltered = true;
        reason = `振幅约${(amplitude * 100).toFixed(1)}%（超限），盘中波动剧烈，次日易分歧`;
      } else if (distMa10 > params.max_dist_ma10) {
        isFiltered = true;
        reason = `涨幅约${(changeRate * 100).toFixed(1)}%、振幅约${(amplitude * 100).toFixed(1)}%，虽主线没问题，但尾盘偏离10日线约${(distMa10 * 100).toFixed(1)}%，位置偏高`;
      }
    }

    if (isFiltered) {
      filteredStocks.push({
        symkey: stock.symkey,
        name: stock.name,
        reason,
        change_rate: changeRate,
        amplitude,
        dist_ma10: distMa10,
        drop_5d: drop5d,
      });
      continue;
    }

    if (ma10Value == null || ma20Value == null) continue;

    let score = 0;
    if (ma10Value > ma20Value) score += 30;
    if (today.c > today.o) score += 20;
    const body = Math.abs(today.c - today.o) / (today.h - today.l + 1e-6);
    if (body < 0.4) score += 20;
    if (MAINLINE_KEYWORDS.some((keyword) => stock.name.includes(keyword))) score += 30;

    if (score > 30) {
      scoredStocks.push({
        symkey: stock.symkey,
        name: stock.name,
        score,
        buy_price: today.c,
      });
    }
  }

  scoredStocks.sort((a, b) => b.score - a.score);
  const picks = scoredStocks.slice(0, 5).map((pick) => {
    const triggerLow = round2(pick.buy_price * 0.99);
    const triggerHigh = round2(pick.buy_price * 1.005);
    const buyPrice = round2(pick.buy_price);
    const isChuangye = pick.symkey.startsWith("300") || pick.symkey.startsWith("688");
    return {
      ...pick,
      buy_price: buyPrice,
      trigger_low: triggerLow,
      trigger_high: triggerHigh,
      trigger_range: `${triggerLow} - ${triggerHigh}`,
      stop_loss: round2(pick.buy_price * 0.972),
      take_profit: round2(pick.buy_price * 1.027),
      position: "8%",
      plan: generateStockPlan(pick.name, isChuangye),
    };
  });

  return {
    picks,
    avoid_buys: pickAvoidList(filteredStocks),
    candidateCount: candidates.length,
    filteredCount: filteredStocks.length,
  };
}

async function main() {
  const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  state.params = { ...DEFAULT_PARAMS, ...(state.params || {}) };
  state.history = state.history || {};

  const targetDate = process.env.TARGET_DATE || (await fetchLatestTradingDate());
  if (!targetDate) throw new Error("无法识别最新交易日");

  const verification = await verifyPreviousPicks(state, targetDate);
  const optimization = optimizeParams(state);
  const existingToday = state.history[targetDate];
  const forceScan = process.env.FORCE_SCAN === "1";
  let scan = null;

  if (forceScan || !Array.isArray(existingToday?.picks) || existingToday.picks.length === 0) {
    scan = await scanToday(targetDate, optimization.params);
    state.history[targetDate] = {
      picks: scan.picks,
      avoid_buys: scan.avoid_buys,
    };
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    source: "github-actions",
    targetDate,
    verification,
    optimization,
    scan: scan
      ? {
          picks: scan.picks.map((pick) => `${pick.name}(${pick.symkey})`),
          avoidCount: scan.avoid_buys.length,
          candidateCount: scan.candidateCount,
          filteredCount: scan.filteredCount,
        }
      : { skipped: true, reason: "目标交易日已有持仓快照" },
  };

  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
