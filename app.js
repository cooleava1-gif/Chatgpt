/* ====== 基金看板 GitHub 版 ====== */

const $ = (id) => document.getElementById(id);

const STORE_KEY = "fund_board_holdings_v2";
let HOLDINGS = [];
let LIVE = [];
let HIST = null;
let CHART = null;
let TIMER = null;

function logDebug(msg) {
  const el = $("debug");
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  el.textContent = `[${t}] ${msg}\n` + el.textContent;
}

function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => (t.style.display = "none"), 3200);
}

function money(x) {
  if (x == null || !isFinite(x)) return "--";
  return Number(x).toFixed(2);
}

function pct(x) {
  if (x == null || !isFinite(x)) return "--";
  return (x * 100).toFixed(2) + "%";
}

function cls(x) {
  if (x == null || !isFinite(x)) return "";
  return x >= 0 ? "good" : "bad";
}

function todayCN() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function daysHeld(buyDate) {
  const b = new Date(buyDate + "T00:00:00");
  const t = new Date(todayCN() + "T00:00:00");
  const d = Math.floor((t - b) / 86400000);
  return Math.max(0, d + 1);
}

/* ====== JSONP/脚本加载（关键：避免并发冲突） ====== */
let SCRIPT_QUEUE = Promise.resolve();

function enqueue(fn) {
  SCRIPT_QUEUE = SCRIPT_QUEUE.then(fn).catch((e) => {
    logDebug("QUEUE_ERR: " + (e?.message || e));
  });
  return SCRIPT_QUEUE;
}

function loadScript(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;

    const timer = setTimeout(() => {
      s.remove();
      reject(new Error("timeout"));
    }, timeoutMs);

    s.onload = () => {
      clearTimeout(timer);
      s.remove();
      resolve(true);
    };
    s.onerror = () => {
      clearTimeout(timer);
      s.remove();
      reject(new Error("load failed"));
    };

    document.head.appendChild(s);
  });
}

/* ====== 缓存 ====== */
const RT_CACHE = new Map();   // 60s
const HIS_CACHE = new Map();  // hours

function cacheGet(map, key, ttlMs) {
  const o = map.get(key);
  if (!o) return null;
  if (Date.now() - o.ts > ttlMs) return null;
  return o.data;
}
function cachePut(map, key, data) {
  map.set(key, { ts: Date.now(), data });
  return data;
}

/* ====== 数据源 1：天天基金 fundgz（实时估值/净值，JSONP） ====== */
async function fetchFundGz(code) {
  return enqueue(async () => {
    const cacheKey = "gz:" + code;
    const cached = cacheGet(RT_CACHE, cacheKey, 60 * 1000);
    if (cached) return cached;

    const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    const prev = window.jsonpgz;

    return await new Promise(async (resolve, reject) => {
      let done = false;
      window.jsonpgz = (obj) => {
        done = true;
        window.jsonpgz = prev;
        cachePut(RT_CACHE, cacheKey, obj);
        resolve(obj);
      };

      try {
        await loadScript(url, 8000);
        setTimeout(() => {
          if (!done) {
            window.jsonpgz = prev;
            reject(new Error("fundgz no callback"));
          }
        }, 0);
      } catch (e) {
        window.jsonpgz = prev;
        reject(new Error("fundgz 403/404"));
      }
    });
  });
}

/* ====== 数据源 2：东方财富 pingzhongdata（历史净值，脚本变量） ====== */
async function fetchPingZhong(code) {
  return enqueue(async () => {
    const cacheKey = "pzd:" + code;
    const cached = cacheGet(HIS_CACHE, cacheKey, 6 * 60 * 60 * 1000);
    if (cached) return cached;

    const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
    await loadScript(url, 12000);

    const name = window.fS_name || code;
    const arr = window.Data_netWorthTrend || [];

    const series = arr
      .map((o) => {
        const x = Number(o?.x);
        const y = Number(o?.y);
        if (!isFinite(x) || !isFinite(y)) return null;
        const d = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(x));
        return { date: d, nav: y };
      })
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));

    // 清理全局变量，避免污染
    try { delete window.Data_netWorthTrend; } catch {}
    try { delete window.fS_name; } catch {}

    const out = { name, series };
    cachePut(HIS_CACHE, cacheKey, out);
    return out;
  });
}

/* ====== 数据源 3：新浪行情（场内实时价，脚本 var） ====== */
function inferExchange(code6) {
  // 经验规则：5/6/9 开头偏 sh，其余默认 sz；161226 -> sz
  const c = String(code6);
  if (c.startsWith("5") || c.startsWith("6") || c.startsWith("9")) return "sh";
  return "sz";
}

async function fetchSina(symbol) {
  return enqueue(async () => {
    symbol = symbol.toLowerCase();
    const cacheKey = "sina:" + symbol;
    const cached = cacheGet(RT_CACHE, cacheKey, 60 * 1000);
    if (cached) return cached;

    const url = `https://hq.sinajs.cn/list=${symbol}&_=${Date.now()}`;
    await loadScript(url, 8000);

    const v = window["hq_str_" + symbol];
    if (!v) throw new Error("sina empty");

    const f = String(v).split(",");
    const name = f[0];
    const preclose = Number(f[2]);
    const price = Number(f[3]);
    const pctChg =
      isFinite(preclose) && isFinite(price) && preclose !== 0
        ? (price - preclose) / preclose
        : null;

    const out = { name, price: isFinite(price) ? price : null, pct: pctChg };
    cachePut(RT_CACHE, cacheKey, out);
    return out;
  });
}

/* ====== 买入确认/起息：从净值序列对齐交易日 ====== */
function calcConfirmAndEarning(dates, buyDate) {
  const confirm = dates.find((d) => d >= buyDate) || dates[dates.length - 1] || buyDate;
  const idx = dates.indexOf(confirm);
  const earning = idx >= 0 && idx + 1 < dates.length ? dates[idx + 1] : confirm;
  return { confirmDate: confirm, earningStartDate: earning };
}

function sliceFromConfirm(series, confirmDate, n = 7) {
  const out = [];
  for (const x of series) {
    if (x.date >= confirmDate) {
      out.push(x);
      if (out.length >= n) break;
    }
  }
  return out;
}

/* ====== 存储 ====== */
function loadHoldings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    HOLDINGS = raw ? JSON.parse(raw) : [];
  } catch {
    HOLDINGS = [];
  }
}

function saveHoldings() {
  localStorage.setItem(STORE_KEY, JSON.stringify(HOLDINGS));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ====== 成本推算（基金/LOF 默认用确认日净值；场内默认用当前价） ====== */
async function inferCostFor(type, code, buyDate, lofBasis) {
  if (type === "fund") {
    const pzd = await fetchPingZhong(code);
    const dates = pzd.series.map((x) => x.date);
    const { confirmDate } = calcConfirmAndEarning(dates, buyDate);
    const hit = pzd.series.find((x) => x.date === confirmDate);
    if (hit?.nav) return hit.nav;
    const gz = await fetchFundGz(code);
    const v = Number(gz.gsz) || Number(gz.dwjz);
    if (isFinite(v) && v > 0) return v;
    throw new Error("无法推算成本（缺净值/估值）");
  }

  if (type === "lof") {
    // LOF：成本口径可选 nav 或 场内价
    if (lofBasis === "mkt") {
      const sym = code.length === 8 && (code.startsWith("sh") || code.startsWith("sz"))
        ? code
        : (inferExchange(code) + code);
      const q = await fetchSina(sym);
      if (q?.price) return q.price;
      throw new Error("无法推算 LOF 场内成本");
    } else {
      const pzd = await fetchPingZhong(code);
      const dates = pzd.series.map((x) => x.date);
      const { confirmDate } = calcConfirmAndEarning(dates, buyDate);
      const hit = pzd.series.find((x) => x.date === confirmDate);
      if (hit?.nav) return hit.nav;
      const gz = await fetchFundGz(code);
      const v = Number(gz.gsz) || Number(gz.dwjz);
      if (isFinite(v) && v > 0) return v;
      throw new Error("无法推算 LOF 净值成本");
    }
  }

  // sec
  const sym = code.length === 8 && (code.startsWith("sh") || code.startsWith("sz"))
    ? code
    : (inferExchange(code) + code);
  const q = await fetchSina(sym);
  if (q?.price) return q.price;
  throw new Error("无法推算场内成本");
}

/* ====== 主刷新 ====== */
async function refreshAll(forceHistory = true) {
  $("btnRefresh").disabled = true;
  $("btnRefresh").innerHTML = `<span class="spin"></span> 刷新中…`;

  try {
    $("cnDate").textContent = "沪市日期：" + todayCN();
    LIVE = [];

    let totalCost = 0;
    let totalValue = 0;

    for (const h of HOLDINGS) {
      totalCost += Number(h.amount || 0);

      const buyDate = h.buyDate || todayCN();
      let name = h.code;
      let nav = null;
      let mkt = null;
      let premium = null;

      let confirmDate = "";
      let earningStartDate = "";

      // 1) 先拿历史净值（用于确认/起息 + 7日曲线）
      if (h.type === "fund" || h.type === "lof") {
        try {
          const pzd = await fetchPingZhong(h.code);
          name = pzd.name || name;

          const dates = pzd.series.map((x) => x.date);
          const ce = calcConfirmAndEarning(dates, buyDate);
          confirmDate = ce.confirmDate;
          earningStartDate = ce.earningStartDate;
        } catch (e) {
          logDebug(`PZD_FAIL ${h.code}: ${e?.message || e}`);
          confirmDate = buyDate;
          earningStartDate = buyDate;
        }

        // 2) 再拿实时估值/净值
        try {
          const gz = await fetchFundGz(h.code);
          const gsz = Number(gz.gsz);
          const dwjz = Number(gz.dwjz);
          nav = (isFinite(gsz) && gsz > 0) ? gsz : (isFinite(dwjz) ? dwjz : null);
          if (gz?.name) name = gz.name;
        } catch (e) {
          logDebug(`GZ_FAIL ${h.code}: ${e?.message || e}`);
        }
      }

      // 3) LOF 额外拿场内价
      if (h.type === "lof") {
        const sym = h.symbol || (inferExchange(h.code) + h.code);
        try {
          const q = await fetchSina(sym);
          mkt = q?.price ?? null;
          if (q?.name) name = q.name;
        } catch (e) {
          logDebug(`SINA_FAIL ${sym}: ${e?.message || e}`);
        }
        if (nav != null && mkt != null && nav !== 0) premium = (mkt - nav) / nav;
      }

      // 4) 场内
      if (h.type === "sec") {
        const sym = h.symbol || (inferExchange(h.code) + h.code);
        try {
          const q = await fetchSina(sym);
          mkt = q?.price ?? null;
          if (q?.name) name = q.name;
        } catch (e) {
          logDebug(`SINA_FAIL ${sym}: ${e?.message || e}`);
        }
      }

      // 5) 计算份额/市值/盈亏
      const amount = Number(h.amount || 0);
      const cost = Number(h.cost || 0);
      const shares = Number(h.shares || 0);

      // 起息逻辑：未到起息日 -> 盈亏=0 市值=投入
      const eligible = earningStartDate ? (todayCN() >= earningStartDate) : true;

      // 当前计价口径：
      // fund: 用 nav（估值/净值）
      // lof: 用 mkt（场内价）更贴近你“算上溢价”的需求；mkt 缺失时退化为 nav
      // sec: 用 mkt
      let curPrice = null;
      if (h.type === "fund") curPrice = nav;
      if (h.type === "lof") curPrice = (mkt != null ? mkt : nav);
      if (h.type === "sec") curPrice = mkt;

      const value = eligible
        ? (curPrice != null ? (shares * curPrice) : null)
        : amount;

      const profit = eligible
        ? (value != null ? (value - amount) : null)
        : 0;

      const profitRate = eligible
        ? (amount > 0 && profit != null ? (profit / amount) : null)
        : 0;

      if (value != null && isFinite(value)) totalValue += value;

      LIVE.push({
        ...h,
        name,
        nav,
        mkt,
        premium,
        confirmDate,
        earningStartDate,
        daysHeld: daysHeld(buyDate),
        value,
        profit,
        profitRate,
      });
    }

    // 占比
    for (const it of LIVE) {
      it.weight = (it.value != null && isFinite(it.value) && totalValue > 0)
        ? it.value / totalValue
        : null;
    }

    const totalProfit = totalValue - totalCost;
    const totalPR = totalCost > 0 ? totalProfit / totalCost : null;

    $("kCost").textContent = money(totalCost);
    $("kValue").textContent = money(totalValue);
    $("kProfit").textContent = money(totalProfit);
    $("kProfit").className = "v " + cls(totalProfit);
    $("kPR").textContent = pct(totalPR);
    $("kPR").className = "v " + cls(totalPR);

    $("hint").textContent = LIVE.length ? `共 ${LIVE.length} 条持仓` : "还没持仓，先加一条~";

    renderTable();
    buildChartTarget();

    if (forceHistory) {
      HIST = await buildHistoryForChart();
      drawChart();
    }

    $("jsStatus").textContent = "JS：就绪";
  } catch (e) {
    toast("刷新失败：" + (e?.message || e));
    logDebug("REFRESH_ERR: " + (e?.message || e));
  } finally {
    $("btnRefresh").disabled = false;
    $("btnRefresh").textContent = "手动刷新";
  }
}

/* ====== 表格渲染 ====== */
function typeName(t) {
  if (t === "fund") return "基金";
  if (t === "lof") return "LOF";
  return "场内";
}

function renderTable() {
  const tb = $("tb").querySelector("tbody");
  tb.innerHTML = "";

  for (const it of LIVE) {
    const w = it.weight == null ? null : it.weight;
    const wPct = w == null ? "--" : (w * 100).toFixed(1) + "%";
    const wBar = w == null
      ? `<div class="wbar"><div style="width:0%"></div></div>`
      : `<div class="wbar"><div style="width:${Math.min(100, Math.max(0, w * 100))}%"></div></div>`;

    const priceShow = it.nav != null ? money(it.nav) : "--";
    const mktShow = it.mkt != null ? money(it.mkt) : "--";
    const premShow = it.premium != null ? pct(it.premium) : "--";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="namecol">
        <div>${it.name || ""}</div>
        <div class="tiny">${it.type === "sec" ? (it.symbol || it.code) : it.code}</div>
      </td>
      <td>${typeName(it.type)}</td>
      <td>${wBar}<div class="tiny">${wPct}</div></td>
      <td>${it.daysHeld != null ? (it.daysHeld + "天") : "--"}</td>
      <td><input id="bd_${it.id}" type="date" class="cell small" value="${it.buyDate || todayCN()}"></td>
      <td class="tiny">${it.confirmDate || "--"} / ${it.earningStartDate || "--"}</td>
      <td><input id="am_${it.id}" class="cell" value="${Number(it.amount || 0).toFixed(2)}"></td>
      <td><input id="ct_${it.id}" class="cell small" value="${Number(it.cost || 0).toFixed(6)}"></td>
      <td>${Number(it.shares || 0).toFixed(4)}</td>
      <td>${priceShow}</td>
      <td>${mktShow}</td>
      <td class="${cls(it.premium)}">${premShow}</td>
      <td>${money(it.value)}</td>
      <td class="${cls(it.profit)}">${money(it.profit)}</td>
      <td class="${cls(it.profitRate)}">${pct(it.profitRate)}</td>
      <td>
        <button type="button" class="btn-mini pri" data-act="save" data-id="${it.id}">保存</button>
        <button type="button" class="btn-mini danger" data-act="del" data-id="${it.id}">删除</button>
      </td>
    `;
    tb.appendChild(tr);
  }
}

/* ====== 新增/保存/删除 ====== */
async function addHolding() {
  const btn = $("btnAdd");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> 新增中…`;

  try {
    const type = $("type").value;
    let code = $("code").value.trim();
    const buyDate = $("buyDate").value || todayCN();
    const amount = Number($("amount").value);
    const costStr = $("cost").value.trim();
    const lofBasis = $("lofBasis").value;

    if (!code) return toast("代码不能为空");
    if (!(amount > 0)) return toast("投入金额要 > 0");

    // 统一 code 处理
    if (type === "sec") {
      // 股票/ETF: 允许 600xxx 或 sh600xxx
      if (/^\d{6}$/.test(code)) {
        code = code;
      } else if (/^(sh|sz)\d{6}$/i.test(code)) {
        // ok
      } else {
        return toast("场内代码格式：600000 或 sh600000 / sz000001");
      }
    } else {
      // fund/lof 必须 6 位
      if (!/^\d{6}$/.test(code)) return toast("基金/LOF 代码应为6位数字");
    }

    let cost = costStr ? Number(costStr) : null;
    if (costStr && !(cost > 0)) return toast("成本单价需为正数，或留空自动推算");

    if (!(cost > 0)) {
      cost = await inferCostFor(type, code, buyDate, lofBasis);
    }

    const shares = amount / cost;

    const item = {
      id: uid(),
      type,
      code: type === "sec" ? (code.length === 6 ? code : code.slice(2)) : code,
      symbol: null,
      buyDate,
      amount,
      cost,
      shares,
      lofBasis: type === "lof" ? lofBasis : null,
    };

    if (type === "sec") {
      const sym = code.length === 8 ? code.toLowerCase() : (inferExchange(code) + code);
      item.symbol = sym;
    }
    if (type === "lof") {
      item.symbol = inferExchange(code) + code; // 默认推断交易所
    }

    HOLDINGS.push(item);
    saveHoldings();

    $("code").value = "";
    $("amount").value = "";
    $("cost").value = "";

    toast("新增成功");
    await refreshAll(true);
  } catch (e) {
    toast("新增失败：" + (e?.message || e));
    logDebug("ADD_ERR: " + (e?.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = "新增";
  }
}

async function saveHolding(id, btn) {
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> 保存…`;

  try {
    const h = HOLDINGS.find((x) => x.id === id);
    if (!h) return toast("找不到持仓");

    const buyDate = $("bd_" + id).value || todayCN();
    const amount = Number($("am_" + id).value);
    const costStr = String($("ct_" + id).value || "").trim();
    let cost = costStr ? Number(costStr) : null;

    if (!(amount > 0)) return toast("投入金额要 > 0");
    if (costStr && !(cost > 0)) return toast("成本单价需为正数，或留空让系统推算");

    if (!(cost > 0)) {
      cost = await inferCostFor(h.type, h.type === "sec" ? (h.symbol || h.code) : h.code, buyDate, h.lofBasis);
    }

    h.buyDate = buyDate;
    h.amount = amount;
    h.cost = cost;
    h.shares = amount / cost;

    saveHoldings();
    toast("已保存");
    await refreshAll(true);
  } catch (e) {
    toast("保存失败：" + (e?.message || e));
    logDebug("SAVE_ERR: " + (e?.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

async function delHolding(id, btn) {
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> 删除…`;

  try {
    HOLDINGS = HOLDINGS.filter((x) => x.id !== id);
    saveHoldings();
    toast("已删除");
    await refreshAll(true);
  } catch (e) {
    toast("删除失败：" + (e?.message || e));
    logDebug("DEL_ERR: " + (e?.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = "删除";
  }
}

/* ====== 7日曲线（修复：从确认日开始取 7 个交易日） ====== */
function buildChartTarget() {
  const sel = $("chartTarget");
  const cur = sel.value;
  sel.innerHTML = "";

  const o0 = document.createElement("option");
  o0.value = "__none__";
  o0.textContent = "请选择一条持仓";
  sel.appendChild(o0);

  LIVE.forEach((it) => {
    const o = document.createElement("option");
    o.value = it.id;
    o.textContent = `${it.name || it.code}（${typeName(it.type)}）`;
    sel.appendChild(o);
  });

  if (cur) sel.value = cur;
}

async function buildHistoryForChart() {
  const per = {};

  for (const it of LIVE) {
    if (it.type === "fund" || it.type === "lof") {
      try {
        const pzd = await fetchPingZhong(it.code);
        const dates = pzd.series.map((x) => x.date);

        const ce = calcConfirmAndEarning(dates, it.buyDate || todayCN());
        const seg = sliceFromConfirm(pzd.series, ce.confirmDate, 7);

        // 以确认日净值计算“起点”
        const nav0 = seg[0]?.nav;
        const shares = Number(it.shares || 0);
        const amt = Number(it.amount || 0);

        const labels = seg.map((x) => x.date);
        const navs = seg.map((x) => x.nav);

        const pctArr = navs.map((v) => (nav0 && v != null) ? ((v - nav0) / nav0) : null);
        const valArr = navs.map((v, idx) => {
          if (!(shares > 0) || v == null) return null;
          // 确认日（idx=0）盈亏=0；后续按净值变化计算
          const value = shares * v;
          return value - amt;
        });

        per[it.id] = {
          labels,
          pct: pctArr,
          val: valArr,
          note: it.type === "lof" ? "LOF 曲线按净值（场内价曲线需额外K线源）" : "",
        };
      } catch (e) {
        per[it.id] = { labels: [], pct: [], val: [], note: "历史净值不可用" };
        logDebug(`CHART_PZD_FAIL ${it.code}: ${e?.message || e}`);
      }
    } else {
      // 场内：仅展示当日（避免误导）
      const d = todayCN();
      per[it.id] = { labels: [d], pct: [0], val: [0], note: "场内7日K线需额外数据源" };
    }
  }

  return { per };
}

function drawChart() {
  const target = $("chartTarget").value;
  const mode = $("chartMode").value;
  const status = $("chartStatus");
  const hint = $("chartHint");

  if (!target || target === "__none__") {
    status.textContent = "曲线状态：未选择";
    hint.textContent = "选一条持仓，就会按买入确认日开始计算 7 个交易日曲线。";
    if (CHART) CHART.destroy();
    return;
  }

  const s = HIST?.per?.[target];
  if (!s || !s.labels?.length) {
    status.textContent = "曲线状态：无数据";
    hint.textContent = s?.note || "暂无";
    if (CHART) CHART.destroy();
    return;
  }

  const labels = s.labels;
  const data = mode === "pct" ? s.pct : s.val;

  status.textContent = `曲线状态：${labels.length} 点`;
  hint.textContent = s.note || "";

  const ctx = $("c1").getContext("2d");
  if (CHART) CHART.destroy();
  CHART = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ data, tension: 0.25, spanGaps: true }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => mode === "pct" ? (" " + pct(c.raw)) : (" " + money(c.raw)),
          },
        },
      },
      scales: {
        y: { grid: { color: "rgba(255,255,255,.06)" } },
        x: { grid: { color: "rgba(255,255,255,.04)" } },
      },
    },
  });
}

/* ====== 定时刷新 ====== */
function setupTimer() {
  if (TIMER) clearInterval(TIMER);
  if (!$("auto").checked) return;
  const ms = Number($("interval").value || "60000");
  TIMER = setInterval(() => refreshAll(false), ms);
}

/* ====== 事件绑定（修复按钮无效的核心） ====== */
function bindUI() {
  $("btnRefresh").addEventListener("click", () => refreshAll(true));
  $("btnAdd").addEventListener("click", addHolding);

  $("tb").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    const act = b.dataset.act;
    if (act === "save") saveHolding(id, b);
    if (act === "del") delHolding(id, b);
  });

  $("chartTarget").addEventListener("change", drawChart);
  $("chartMode").addEventListener("change", drawChart);

  $("auto").addEventListener("change", setupTimer);
  $("interval").addEventListener("change", setupTimer);

  $("type").addEventListener("change", () => {
    const t = $("type").value;
    $("lofBasis").style.display = (t === "lof") ? "inline-block" : "none";
  });

  // 初始隐藏
  $("lofBasis").style.display = ($("type").value === "lof") ? "inline-block" : "none";
}

/* ====== 捕获全局错误，避免“加载中卡死” ====== */
window.addEventListener("error", (e) => {
  toast("JS错误：" + (e.message || "unknown"));
  logDebug("JS_ERROR: " + (e.message || "unknown"));
});
window.addEventListener("unhandledrejection", (e) => {
  toast("Promise错误：" + (e.reason?.message || String(e.reason)));
  logDebug("PROMISE_ERROR: " + (e.reason?.message || String(e.reason)));
});

/* ====== 启动 ====== */
document.addEventListener("DOMContentLoaded", async () => {
  $("buyDate").value = todayCN();
  $("cnDate").textContent = "沪市日期：" + todayCN();
  $("jsStatus").textContent = "JS：启动中…";

  loadHoldings();
  bindUI();

  await refreshAll(true);
  setupTimer();

  $("jsStatus").textContent = "JS：就绪";
});
