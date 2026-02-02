(() => {
  "use strict";

  const LS_KEY = "fund_board_positions_v4";
  const $ = (id) => document.getElementById(id);

  const elStatus = $("jsStatus");
  const elCnDate = $("cnDate");
  const elDebug = $("debugBox");
  const elTbody = $("posTbody");

  const elSumInvest = $("sumInvest");
  const elSumValue = $("sumValue");
  const elSumPnl = $("sumPnl");
  const elSumRoi = $("sumRoi");

  const elCurveHint = $("curveHint");

  const form = $("addForm");
  const fCode = $("fCode");
  const fKind = $("fKind");
  const fBuyDate = $("fBuyDate");
  const fInvest = $("fInvest");
  const fCostBasis = $("fCostBasis");
  const fUnitCost = $("fUnitCost");

  const rowCostBasis = $("rowCostBasis");
  const rowUnitCost = $("rowUnitCost");

  let timer = null;
  let refreshIntervalSec = 60;

  let chartRate = null;
  let chartPnl = null;

  // ========= small utils =========
  const log = (msg) => {
    const t = new Date().toLocaleString();
    elDebug.textContent = `[${t}] ${msg}\n` + elDebug.textContent;
  };

  const money = (x) => {
    if (!isFinite(x)) return "--";
    return Number(x).toFixed(2);
  };

  const pct = (x) => {
    if (!isFinite(x)) return "--";
    return (x * 100).toFixed(2) + "%";
  };

  const safeNum = (x) => {
    const n = Number(x);
    return isFinite(n) ? n : NaN;
  };

  const ymd = (d) => {
    const dt = (d instanceof Date) ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const da = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  };

  const daysBetween = (a, b) => {
    const A = new Date(a + "T00:00:00");
    const B = new Date(b + "T00:00:00");
    return Math.max(0, Math.round((B - A) / 86400000));
  };

  const kindLabel = (k) => k === "fund" ? "基金" : (k === "lof" ? "LOF" : "场内");

  function loadPositions() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function savePositions(list) {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  }

  // ========= JSONP / Script loader =========
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      // 关键：一些站会校验 referer；不给 referer 反而更稳一点
      s.referrerPolicy = "no-referrer";
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error("script load failed: " + url));
      document.head.appendChild(s);
      // 保留：有些返回会写全局变量，立刻删 script 不影响变量
      setTimeout(() => { try { s.remove(); } catch {} }, 1500);
    });
  }

  function jsonp(url, cbParam = "cb", timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const cbName = "__cb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const timerId = setTimeout(() => {
        cleanup();
        reject(new Error("jsonp timeout"));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timerId);
        try { delete window[cbName]; } catch {}
        try { script.remove(); } catch {}
      }

      window[cbName] = (data) => {
        cleanup();
        resolve(data);
      };

      const sep = url.includes("?") ? "&" : "?";
      const full = url + sep + `${cbParam}=${cbName}` + `&rt=${Date.now()}`;

      const script = document.createElement("script");
      script.src = full;
      script.async = true;
      script.referrerPolicy = "no-referrer";
      script.onerror = () => {
        cleanup();
        reject(new Error("jsonp load error"));
      };
      document.head.appendChild(script);
    });
  }

  // ========= Data sources (sequential to avoid races) =========
  let queue = Promise.resolve();

  function enqueue(task) {
    queue = queue.then(task).catch((e) => {
      log("队列任务失败：" + (e?.message || e));
    });
    return queue;
  }

  // fundgz：返回固定 jsonpgz(...)，只能串行“接球”
  function getFundGZ(code) {
    return enqueue(() => new Promise(async (resolve, reject) => {
      let done = false;
      const old = window.jsonpgz;

      const timerId = setTimeout(() => {
        if (!done) {
          cleanup();
          reject(new Error("fundgz timeout"));
        }
      }, 8000);

      function cleanup() {
        done = true;
        clearTimeout(timerId);
        if (old) window.jsonpgz = old;
        else try { delete window.jsonpgz; } catch {}
      }

      window.jsonpgz = (obj) => {
        cleanup();
        resolve(obj);
      };

      const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
      try {
        await loadScript(url);
      } catch (e) {
        cleanup();
        reject(e);
      }
    }));
  }

  // pingzhongdata：会写全局变量，串行读完就走
  function getPingZhongData(code) {
    return enqueue(() => new Promise(async (resolve, reject) => {
      const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
      try {
        await loadScript(url);

        const name = window.fS_name || "";
        const trend = Array.isArray(window.Data_netWorthTrend) ? window.Data_netWorthTrend : [];
        // trend item: {x: timestamp(ms), y: netWorth, equityReturn, unitMoney}
        resolve({ name, trend });
      } catch (e) {
        reject(e);
      }
    }));
  }

  function inferSZSH(code) {
    // 简化：6/5/9开头多数沪；其余深（包含 16xxxxx LOF）
    if (/^[569]/.test(code)) return "sh";
    return "sz";
  }

  // sina 行情（脚本写 var hq_str_xxx="..."）
  async function getSinaQuote(code, forced = null) {
    const ex = forced || inferSZSH(code);
    const symbol = `${ex}${code}`;
    const url = `https://hq.sinajs.cn/list=${symbol}&_=${Date.now()}`;

    await enqueue(() => loadScript(url));

    const key = `hq_str_${symbol}`;
    const raw = window[key];
    if (!raw || typeof raw !== "string" || raw.length < 5) {
      throw new Error(`Sina行情为空：${symbol}`);
    }

    const arr = raw.split(",");
    const name = arr[0] || "";
    const preclose = safeNum(arr[2]);
    const price = safeNum(arr[3]);
    const date = arr[arr.length - 3] || "";
    const time = arr[arr.length - 2] || "";
    return { name, price, preclose, time: (date && time) ? `${date} ${time}` : "" };
  }

  // 东财 push2 作为备胎（JSONP）
  async function getEMQuote(code, forcedSecid = null) {
    const ex = inferSZSH(code);
    const secid = forcedSecid || ((ex === "sh") ? `1.${code}` : `0.${code}`);
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f43,f58,f170,f60`;
    const data = await jsonp(url, "cb", 8000);
    // data like: { rc:0, data:{ f43: 12345, f58:"名称", f170: 1.23, f60: 1700000000 } }
    if (!data || !data.data) throw new Error("EM行情为空");
    const priceRaw = safeNum(data.data.f43);
    const price = isFinite(priceRaw) ? priceRaw / 100 : NaN;
    const name = data.data.f58 || "";
    return { name, price, time: "" };
  }

  function trendToMap(trend) {
    // map: "YYYY-MM-DD" -> nav
    const m = new Map();
    for (const it of trend) {
      const d = ymd(new Date(it.x));
      const v = safeNum(it.y);
      if (isFinite(v)) m.set(d, v);
    }
    return m;
  }

  function sortedDatesFromMap(map) {
    return Array.from(map.keys()).sort();
  }

  function getConfirmAndInterest(buyDate, dateList) {
    // dateList sorted asc
    if (!buyDate || !dateList.length) return { confirm: "", interest: "" };
    const bd = buyDate;
    let confirm = "";
    for (const d of dateList) {
      if (d >= bd) { confirm = d; break; }
    }
    if (!confirm) confirm = dateList[dateList.length - 1];

    const idx = dateList.indexOf(confirm);
    const interest = (idx >= 0 && idx + 1 < dateList.length) ? dateList[idx + 1] : confirm;
    return { confirm, interest };
  }

  function getPriceOnOrBefore(map, sortedDates, d) {
    // 找 <= d 的最后一个价格（用于曲线补齐）
    if (map.has(d)) return map.get(d);
    // 二分
    let l = 0, r = sortedDates.length - 1, ans = -1;
    while (l <= r) {
      const mid = (l + r) >> 1;
      if (sortedDates[mid] <= d) { ans = mid; l = mid + 1; }
      else r = mid - 1;
    }
    if (ans >= 0) return map.get(sortedDates[ans]);
    return NaN;
  }

  // ========= Fetch & Compute per holding =========
  async function fetchFundOrLOF(pos) {
    const code = String(pos.code).trim();
    const kind = pos.kind;

    // 1) 净值：优先 fundgz（有估值），失败再 pingzhongdata（有历史净值）
    let gz = null;
    let pz = null;

    try { gz = await getFundGZ(code); } catch (e) { log(`fundgz失败 ${code}：${e.message}`); }
    try { pz = await getPingZhongData(code); } catch (e) { log(`pingzhongdata失败 ${code}：${e.message}`); }

    const name = (gz?.name) || (pz?.name) || pos.name || "";
    const trendMap = pz?.trend ? trendToMap(pz.trend) : new Map();
    const dateList = sortedDatesFromMap(trendMap);

    // 最新净值（以 pingzhongdata 最后一天为准）
    let lastNavDate = "";
    let lastNav = NaN;
    if (dateList.length) {
      lastNavDate = dateList[dateList.length - 1];
      lastNav = trendMap.get(lastNavDate);
    } else if (gz?.dwjz) {
      lastNav = safeNum(gz.dwjz);
      lastNavDate = gz.jzrq || "";
    }

    // 估值（实时）：fundgz.gsz
    const estNav = safeNum(gz?.gsz);
    const estTime = gz?.gztime || "";
    const navToShow = isFinite(estNav) ? estNav : lastNav;

    // 2) 场内价：仅 LOF/场内需要
    let mkt = NaN;
    let mktTime = "";
    if (kind === "lof" || kind === "market") {
      try {
        const q = await getSinaQuote(code);
        mkt = q.price;
        mktTime = q.time || "";
      } catch (e1) {
        log(`Sina失败 ${code}：${e1.message}，尝试东财push2…`);
        try {
          const q2 = await getEMQuote(code);
          mkt = q2.price;
        } catch (e2) {
          log(`push2也失败 ${code}：${e2.message}`);
        }
      }
    }

    // 3) 确认/起息（按净值交易日序列）
    const { confirm, interest } = getConfirmAndInterest(pos.buyDate, dateList);

    // 4) 自动推算份额（仅“成本按净值”+ 有确认日净值）
    let unitCost = safeNum(pos.unitCost);
    let shares = safeNum(pos.shares);

    const invested = safeNum(pos.invested);

    const costBasis = pos.costBasis || "nav";
    if (!isFinite(unitCost)) {
      // 用户没填成本单价：只有 nav 口径我们才敢自动算
      if (costBasis === "nav" && confirm && trendMap.has(confirm)) {
        unitCost = safeNum(trendMap.get(confirm));
      }
    }

    if (!isFinite(shares) && isFinite(invested) && isFinite(unitCost) && unitCost > 0) {
      shares = invested / unitCost;
    }

    // 5) 市值口径
    // - 基金：用估值/净值
    // - LOF：默认用场内价估值（能体现溢价）；若场内价拿不到才退回净值
    // - 场内：用场内价
    let valuationPrice = NaN;
    if (kind === "fund") {
      valuationPrice = navToShow;
    } else if (kind === "lof") {
      valuationPrice = isFinite(mkt) ? mkt : navToShow;
    } else {
      valuationPrice = mkt;
    }

    const value = (isFinite(shares) && isFinite(valuationPrice)) ? shares * valuationPrice : NaN;
    const pnl = (isFinite(value) && isFinite(invested)) ? (value - invested) : NaN;
    const roi = (isFinite(pnl) && isFinite(invested) && invested > 0) ? (pnl / invested) : NaN;

    // 6) 溢价（仅 LOF）
    const premium = (kind === "lof" && isFinite(mkt) && isFinite(navToShow) && navToShow > 0)
      ? (mkt / navToShow - 1)
      : NaN;

    return {
      name,
      nav: navToShow,
      navDate: (isFinite(estNav) ? (gz?.jzrq || lastNavDate) : lastNavDate),
      estTime,
      mkt,
      mktTime,
      premium,
      confirm,
      interest,
      unitCost,
      shares,
      invested,
      value,
      pnl,
      roi,
      trendMap,
      dateList
    };
  }

  // ========= render =========
  function render(list, computedMap) {
    if (!list.length) {
      elTbody.innerHTML = `<tr><td colspan="16" class="muted">暂无持仓。先在上面新增一个 (ง •̀_•́)ง</td></tr>`;
      return;
    }

    // totals
    let sumInvest = 0, sumValue = 0;
    for (const p of list) {
      const c = computedMap.get(p.id);
      if (!c) continue;
      if (isFinite(c.invested)) sumInvest += c.invested;
      if (isFinite(c.value)) sumValue += c.value;
    }
    const sumPnl = sumValue - sumInvest;
    const sumRoi = sumInvest > 0 ? sumPnl / sumInvest : NaN;

    elSumInvest.textContent = money(sumInvest);
    elSumValue.textContent = money(sumValue);
    elSumPnl.textContent = money(sumPnl);
    elSumPnl.className = "v " + (sumPnl >= 0 ? "good" : "bad");
    elSumRoi.textContent = pct(sumRoi);
    elSumRoi.className = "v " + (sumRoi >= 0 ? "good" : "bad");

    // rows
    const rows = [];
    for (const p of list) {
      const c = computedMap.get(p.id);
      const name = (c?.name || p.name || "").trim();
      const title = name ? `${name} / ${p.code}` : String(p.code);

      const ratio = (isFinite(c?.value) && sumValue > 0) ? (c.value / sumValue) : NaN;
      const holdDays = (c?.interest) ? daysBetween(c.interest, ymd(new Date())) : daysBetween(p.buyDate, ymd(new Date()));

      const navTxt = isFinite(c?.nav) ? money(c.nav) : "--";
      const mktTxt = (p.kind !== "fund" && isFinite(c?.mkt)) ? money(c.mkt) : "--";
      const premTxt = (p.kind === "lof" && isFinite(c?.premium)) ? (c.premium * 100).toFixed(2) + "%" : "--";

      const pnlTxt = isFinite(c?.pnl) ? money(c.pnl) : "--";
      const roiTxt = isFinite(c?.roi) ? pct(c.roi) : "--";

      const pnlCls = isFinite(c?.pnl) ? (c.pnl >= 0 ? "good" : "bad") : "";
      const roiCls = isFinite(c?.roi) ? (c.roi >= 0 ? "good" : "bad") : "";

      rows.push(`
        <tr>
          <td>${escapeHtml(title)}</td>
          <td>${kindLabel(p.kind)}</td>
          <td class="num">${isFinite(ratio) ? pct(ratio) : "--"}</td>
          <td class="num">${holdDays}</td>
          <td>${p.buyDate || "--"}</td>
          <td>${c?.confirm || "--"} / ${c?.interest || "--"}</td>
          <td class="num">${money(c?.invested)}</td>
          <td class="num">${isFinite(c?.unitCost) ? Number(c.unitCost).toFixed(4) : "--"}</td>
          <td class="num">${isFinite(c?.shares) ? Number(c.shares).toFixed(4) : "--"}</td>
          <td class="num">${navTxt}</td>
          <td class="num">${mktTxt}</td>
          <td class="num">${premTxt}</td>
          <td class="num">${money(c?.value)}</td>
          <td class="num ${pnlCls}">${pnlTxt}</td>
          <td class="num ${roiCls}">${roiTxt}</td>
          <td>
            <button class="btn small ghost" data-act="recalc" data-id="${p.id}" type="button">重算成本</button>
            <button class="btn small" data-act="del" data-id="${p.id}" type="button">删除</button>
          </td>
        </tr>
      `);
    }
    elTbody.innerHTML = rows.join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // ========= 7-day curve =========
  function buildCurve(list, computedMap) {
    // 取全体日期 union 的最后 7 个交易日
    const allDates = new Set();
    for (const p of list) {
      const c = computedMap.get(p.id);
      if (!c?.dateList?.length) continue;
      for (const d of c.dateList) allDates.add(d);
    }
    const dates = Array.from(allDates).sort();
    const last7 = dates.slice(-7);
    if (last7.length < 2) return null;

    const values = [];
    for (const d of last7) {
      let total = 0;
      for (const p of list) {
        const c = computedMap.get(p.id);
        if (!c) continue;
        const start = c.interest || p.buyDate;
        if (!start || d < start) continue;

        if (!isFinite(c.shares) || c.shares <= 0) continue;

        if (!c.trendMap || !c.dateList?.length) continue;

        const nav = getPriceOnOrBefore(c.trendMap, c.dateList, d);
        if (!isFinite(nav)) continue;

        // LOF 曲线：用“净值 * 当前(场内价/净值)” 近似，把溢价影响带进去
        let px = nav;
        if (p.kind === "lof" && isFinite(c.mkt) && isFinite(c.nav) && c.nav > 0) {
          const premRatio = c.mkt / c.nav;
          px = nav * premRatio;
        }

        total += c.shares * px;
      }
      values.push(total);
    }

    const base = values[0];
    if (!isFinite(base) || base <= 0) return null;

    const rate = values.map(v => (v / base - 1) * 100);
    const pnl = values.map(v => (v - base));

    return { labels: last7, rate, pnl };
  }

  function drawCharts(curve) {
    if (!window.Chart) {
      elCurveHint.textContent = "曲线状态：Chart.js 未加载";
      return;
    }
    if (!curve) {
      elCurveHint.textContent = "曲线状态：数据不足（至少需要 2 个交易日净值）";
      if (chartRate) chartRate.destroy();
      if (chartPnl) chartPnl.destroy();
      chartRate = chartPnl = null;
      return;
    }
    elCurveHint.textContent = "曲线状态：OK（按交易日净值序列，LOF 含溢价近似）";

    const ctx1 = $("chartRate");
    const ctx2 = $("chartPnl");

    if (chartRate) chartRate.destroy();
    if (chartPnl) chartPnl.destroy();

    chartRate = new Chart(ctx1, {
      type: "line",
      data: {
        labels: curve.labels,
        datasets: [{ label: "涨跌幅(%)", data: curve.rate, tension: 0.25 }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { ticks: { callback: (v) => v + "%" } }
        }
      }
    });

    chartPnl = new Chart(ctx2, {
      type: "line",
      data: {
        labels: curve.labels,
        datasets: [{ label: "盈亏(元)", data: curve.pnl, tension: 0.25 }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } }
      }
    });
  }

  // ========= main refresh =========
  async function refreshAll() {
    elStatus.textContent = "JS：刷新中…";
    const list = loadPositions();

    const computedMap = new Map();

    // 沪市日期：用今天日期先占位（不强依赖）
    elCnDate.textContent = ymd(new Date());

    for (const p of list) {
      try {
        const c = await fetchFundOrLOF(p);
        computedMap.set(p.id, c);

        // 如果自动算出了成本/份额，回写保存（让盈亏稳定，不每次漂）
        let changed = false;
        if (!isFinite(safeNum(p.unitCost)) && isFinite(c.unitCost)) { p.unitCost = c.unitCost; changed = true; }
        if (!isFinite(safeNum(p.shares)) && isFinite(c.shares)) { p.shares = c.shares; changed = true; }
        if (!p.name && c.name) { p.name = c.name; changed = true; }
        if (!p.confirm && c.confirm) { p.confirm = c.confirm; changed = true; }
        if (!p.interest && c.interest) { p.interest = c.interest; changed = true; }
        if (changed) savePositions(list);

      } catch (e) {
        log(`刷新失败 ${p.code}：${e.message}`);
      }
    }

    render(list, computedMap);
    drawCharts(buildCurve(list, computedMap));

    elStatus.textContent = "JS：已就绪";
  }

  function startTimer(sec) {
    refreshIntervalSec = sec;
    if (timer) clearInterval(timer);
    timer = setInterval(refreshAll, sec * 1000);
    log(`自动刷新间隔：${sec}s`);
  }

  // ========= events (fix: buttons clickable) =========
  function bindEvents() {
    // interval buttons
    document.querySelectorAll("[data-interval]").forEach(btn => {
      btn.addEventListener("click", () => startTimer(Number(btn.dataset.interval)));
    });

    $("btnRefresh").addEventListener("click", refreshAll);

    $("btnClear").addEventListener("click", () => {
      fCode.value = "";
      fInvest.value = "";
      fUnitCost.value = "";
      fCode.focus();
    });

    fKind.addEventListener("change", () => {
      const k = fKind.value;
      // fund：不需要成本口径；lof/market：显示
      if (k === "fund") {
        rowCostBasis.style.display = "none";
      } else {
        rowCostBasis.style.display = "";
      }
      rowUnitCost.style.display = "";
    });

    // submit add
    form.addEventListener("submit", (ev) => {
      ev.preventDefault(); // 关键：不让页面刷新
      const code = String(fCode.value || "").trim();
      const kind = fKind.value;
      const buyDate = fBuyDate.value;
      const invested = safeNum(fInvest.value);
      const unitCost = safeNum(fUnitCost.value);
      const costBasis = fCostBasis.value;

      if (!/^\d{6}$/.test(code)) {
        alert("代码必须是6位数字");
        return;
      }
      if (!buyDate) {
        alert("请选买入日");
        return;
      }
      if (!isFinite(invested) || invested <= 0) {
        alert("投入必须 > 0");
        return;
      }

      const list = loadPositions();
      const id = "p_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);

      list.unshift({
        id,
        code,
        name: "",
        kind,
        buyDate,
        invested,
        costBasis: (kind === "fund") ? "nav" : costBasis,
        unitCost: isFinite(unitCost) ? unitCost : null,
        shares: null,
        confirm: "",
        interest: ""
      });

      savePositions(list);
      refreshAll();
    });

    // table actions (event delegation)
    elTbody.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;

      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const list = loadPositions();
      const idx = list.findIndex(x => x.id === id);
      if (idx < 0) return;

      if (act === "del") {
        if (!confirm("确定删除这条持仓？")) return;
        list.splice(idx, 1);
        savePositions(list);
        refreshAll();
      }

      if (act === "recalc") {
        // 清空份额/成本，让它按确认日净值重新推
        list[idx].unitCost = null;
        list[idx].shares = null;
        list[idx].confirm = "";
        list[idx].interest = "";
        savePositions(list);
        refreshAll();
      }
    });
  }

  // ========= init =========
  function init() {
    elStatus.textContent = "JS：初始化…";
    elDebug.textContent = "--";

    // 默认把买入日填今天
    fBuyDate.value = ymd(new Date());

    // 默认显示
    rowCostBasis.style.display = "none";

    bindEvents();
    startTimer(60);
    refreshAll().finally(() => {
      elStatus.textContent = "JS：已就绪";
      log("初始化完成");
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
