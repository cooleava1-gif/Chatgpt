/* app.js — GitHub Pages 版基金看板（v5）
 * 目标：按钮可用、161226等LOF识别、7日曲线正确、失败不“拖死全站”
 * 依赖：纯原生JS，无任何外部库
 */
(() => {
  "use strict";

  const VERSION = "appjs_v5_2026-02-02";

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const must = (id) => {
    const el = $(id);
    if (!el) throw new Error(`Missing element id: #${id}`);
    return el;
  };

  // ---------- Debug logger (显示在页面右下角) ----------
  const logLines = [];
  function safeJSON(x) { try { return JSON.stringify(x); } catch { return String(x); } }
  function log(msg, obj) {
    const t = new Date().toLocaleString();
    logLines.push(`[${t}] ${msg}${obj ? " " + safeJSON(obj) : ""}`);
    if (logLines.length > 250) logLines.shift();
    const dbg = $("dbg");
    if (dbg) dbg.textContent = logLines.join("\n");
  }

  function setStatus(ok, text) {
    const el = $("status");
    if (!el) return;
    el.textContent = text;
    el.style.borderColor = ok ? "rgba(54,211,153,.6)" : "rgba(251,113,133,.6)";
    el.style.color = ok ? "#bfffe5" : "#ffd1d9";
  }

  // 捕获所有报错，避免“按钮点不动”
  window.addEventListener("error", (e) => {
    setStatus(false, "JS：报错（看调试信息）");
    log("window.error", { message: e.message, file: e.filename, line: e.lineno, col: e.colno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    setStatus(false, "JS：Promise报错（看调试信息）");
    log("unhandledrejection", { reason: String(e.reason) });
  });

  // ---------- format helpers ----------
  const fmtMoney = (n) => (Number.isFinite(n) ? Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "--");
  const fmtPct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(2) + "%" : "--");
  const todayStr = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  // ---------- Storage ----------
  const LS_KEY = "fund_holdings_app_v5";
  let holdings = [];
  function loadHoldings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]") || []; }
    catch { return []; }
  }
  function saveHoldings() {
    localStorage.setItem(LS_KEY, JSON.stringify(holdings));
  }
  function uid() {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function typeLabel(t) {
    if (t === "fund") return "基金";
    if (t === "lof") return "LOF";
    return "场内";
  }

  // ---------- JSONP (解决 GitHub Pages 跨域) ----------
  function jsonp(url, cbParam = "cb", timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const cbName = "__jp_" + Math.random().toString(16).slice(2);
      const sep = url.includes("?") ? "&" : "?";
      const full = url + sep + cbParam + "=" + cbName + "&_=" + Date.now();

      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("JSONP timeout"));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        try { delete window[cbName]; } catch {}
        script.remove();
      }

      window[cbName] = (data) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(data);
      };

      const script = document.createElement("script");
      script.src = full;
      script.onerror = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("JSONP load error"));
      };
      document.head.appendChild(script);
    });
  }

  // ---------- Eastmoney: secid 判断（161226优先深市） ----------
  function guessSecid(code) {
    const c = String(code);
    if (/^16\d{4}$/.test(c)) return "0." + c;            // 161226 这类 LOF 多数深市
    if (/^(5|6|9)\d{5}$/.test(c)) return "1." + c;       // 沪市常见
    return "0." + c;                                     // 默认深市先试
  }

  // 价格归一化（少数情况下接口会返回 4183 -> 4.183）
  function normalizePrice(raw) {
    let p = Number(raw);
    if (!Number.isFinite(p)) return NaN;
    if (p > 1000 && p < 100000) p = p / 1000;
    else if (p >= 100000) p = p / 100;
    return p;
  }

  // ---------- Eastmoney: 实时行情 ----------
  async function loadQuote(code) {
    const c = String(code).trim();
    const first = guessSecid(c);
    const second = first.startsWith("0.") ? ("1." + c) : ("0." + c);

    const tryOne = async (secid) => {
      // f2: 最新价  f3: 涨跌幅  f12: 代码  f14: 名称
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f2,f3,f12,f14`;
      const data = await jsonp(url, "cb", 12000);
      const d = data && data.data;
      if (!d) return null;
      const name = d.f14;
      const price = normalizePrice(d.f2);
      const chgPct = Number(d.f3) / 100; // 注意：f3 是百分比数值（例如 1.23），这里转成 0.0123
      if (!name || !Number.isFinite(price) || price <= 0) return null;
      return { secid, name, price, chgPct: Number.isFinite(chgPct) ? chgPct : NaN };
    };

    // 先试规则市场，再兜底另一市场
    let q = null;
    try { q = await tryOne(first); } catch (e) { log("quote first failed", { code: c, secid: first, err: String(e) }); }
    if (q) return q;

    try { q = await tryOne(second); } catch (e) { log("quote second failed", { code: c, secid: second, err: String(e) }); }
    return q; // 可能为 null
  }

  // ---------- Eastmoney: K线（日线 close，用于7日曲线：场内/LOF的场内价） ----------
  async function loadKlineClose(code, limit = 60) {
    const c = String(code).trim();
    const first = guessSecid(c);
    const second = first.startsWith("0.") ? ("1." + c) : ("0." + c);

    const tryOne = async (secid) => {
      // klt=101 日线，fqt=1 前复权（这里主要取 close，不纠结复权也行）
      const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=101&fqt=1&lmt=${limit}&fields2=f51,f52,f53,f54,f55,f56`;
      const data = await jsonp(url, "cb", 12000);
      const kl = data && data.data && data.data.klines;
      if (!Array.isArray(kl) || !kl.length) return null;
      const rows = kl.map((s) => {
        const parts = String(s).split(",");
        // f51 日期, f54 收盘
        return { date: parts[0], close: Number(parts[2]) };
      }).filter((x) => x.date && Number.isFinite(x.close));
      if (!rows.length) return null;
      return { secid, rows };
    };

    let k = null;
    try { k = await tryOne(first); } catch (e) { log("kline first failed", { code: c, secid: first, err: String(e) }); }
    if (k) return k;

    try { k = await tryOne(second); } catch (e) { log("kline second failed", { code: c, secid: second, err: String(e) }); }
    return k;
  }

  // ---------- Eastmoney: 净值（pingzhongdata，基金/LOF通用） ----------
  function msToDate(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  function loadNav(code) {
    return new Promise((resolve, reject) => {
      const c = String(code).trim();
      const url = `https://fund.eastmoney.com/pingzhongdata/${c}.js?v=${Date.now()}`;
      const s = document.createElement("script");

      s.onload = () => {
        try {
          const name = window.fS_name;
          const trend = window.Data_netWorthTrend;
          if (!name || !Array.isArray(trend) || trend.length === 0) throw new Error("nav missing fields");

          const navSeries = trend.map((it) => ({ date: msToDate(it.x), nav: Number(it.y) }))
            .filter((x) => x.date && Number.isFinite(x.nav))
            .sort((a, b) => a.date.localeCompare(b.date));

          const last = navSeries[navSeries.length - 1];

          // 清理全局污染
          ["fS_name", "fS_code", "Data_netWorthTrend", "Data_ACWorthTrend", "Data_grandTotal"].forEach((k) => {
            try { delete window[k]; } catch {}
          });

          s.remove();
          resolve({ code: c, name, navSeries, latestNav: last.nav, latestNavDate: last.date });
        } catch (e) {
          s.remove();
          reject(e);
        }
      };

      s.onerror = () => {
        s.remove();
        reject(new Error("pingzhongdata load error"));
      };

      s.src = url;
      document.head.appendChild(s);
    });
  }

  // ---------- 缓存（减少重复请求） ----------
  const cache = {
    nav: new Map(),     // code -> navData
    quote: new Map(),   // code -> quote
    kline: new Map(),   // code -> kline
    t: new Map(),       // key -> timestamp
  };

  function cacheGet(map, key, ttlMs) {
    const ts = cache.t.get(map + ":" + key);
    if (ts && (Date.now() - ts) < ttlMs) return map.get(key);
    return null;
  }
  function cacheSet(map, key, value) {
    map.set(key, value);
    cache.t.set(map + ":" + key, Date.now());
  }

  async function getNav(code) {
    const hit = cacheGet(cache.nav, code, 10 * 60 * 1000); // 10分钟
    if (hit) return hit;
    const v = await loadNav(code);
    cacheSet(cache.nav, code, v);
    return v;
  }
  async function getQuote(code) {
    const hit = cacheGet(cache.quote, code, 30 * 1000); // 30秒
    if (hit) return hit;
    const v = await loadQuote(code);
    if (v) cacheSet(cache.quote, code, v);
    return v;
  }
  async function getKline(code) {
    const hit = cacheGet(cache.kline, code, 5 * 60 * 1000); // 5分钟
    if (hit) return hit;
    const v = await loadKlineClose(code, 80);
    if (v) cacheSet(cache.kline, code, v);
    return v;
  }

  // ---------- 确认日/起息日（按净值序列交易日） ----------
  function calcConfirmInterest(navSeries, buyDate) {
    const idx = navSeries.findIndex((x) => x.date >= buyDate);
    if (idx === -1) {
      const last = navSeries[navSeries.length - 1];
      return { confirmDate: last.date, interestDate: last.date };
    }
    const confirm = navSeries[idx].date;
    const interest = navSeries[idx + 1]?.date || confirm;
    return { confirmDate: confirm, interestDate: interest };
  }

  // ---------- 计算单笔持仓 ----------
  async function computeOne(h) {
    const code = String(h.code).trim();
    const type = h.type;
    const buyDate = h.buyDate;
    const invest = Number(h.amount);
    const costMode = h.costMode || "auto";
    let costPrice = Number(h.costPrice);

    let navData = null;
    let quote = null;

    if (type === "fund" || type === "lof") {
      navData = await getNav(code);
    }
    if (type === "lof" || type === "market") {
      quote = await getQuote(code);
    }

    let confirmDate = "--", interestDate = "--";
    let shares = NaN;

    if (type === "market") {
      // 场内：成本单价默认用买入日K线close，拿不到就用当前价
      if (!Number.isFinite(costPrice) || costPrice <= 0) {
        if (costMode === "manual" && Number.isFinite(costPrice) && costPrice > 0) {
          // keep
        } else {
          const k = await getKline(code);
          const row = k?.rows?.find((r) => r.date === buyDate) || k?.rows?.[k.rows.length - 1];
          costPrice = Number(row?.close) || Number(quote?.price);
        }
      }
      shares = invest / costPrice;
    } else {
      // 基金/LOF：成本单价默认用确认日净值
      const navSeries = navData.navSeries;
      const ci = calcConfirmInterest(navSeries, buyDate);
      confirmDate = ci.confirmDate;
      interestDate = ci.interestDate;

      if (!Number.isFinite(costPrice) || costPrice <= 0) {
        if (costMode === "manual" && Number.isFinite(costPrice) && costPrice > 0) {
          // keep
        } else {
          const navOnConfirm = navSeries.find((x) => x.date === confirmDate)?.nav;
          costPrice = Number(navOnConfirm) || Number(navData.latestNav);
        }
      }
      shares = invest / costPrice;
    }

    const nav = navData?.latestNav;
    const navDate = navData?.latestNavDate;
    const mkt = quote?.price;
    const name = quote?.name || navData?.name || "--";

    const t = todayStr();

    let value = NaN;
    let profit = NaN;

    // 起息日前收益为0（按你要求）
    const notAccruedYet = (interestDate !== "--" && t < interestDate);

    if (type === "fund") {
      if (notAccruedYet) { value = invest; profit = 0; }
      else { value = shares * Number(nav); profit = value - invest; }
    } else if (type === "lof") {
      // LOF：成本按净值，卖出按场内价（含溢价）
      if (notAccruedYet) { value = invest; profit = 0; }
      else { value = shares * Number(mkt); profit = value - invest; }
    } else {
      // market
      value = shares * Number(mkt);
      profit = value - invest;
    }

    let premium = NaN;
    if (type === "lof" && Number.isFinite(nav) && nav > 0 && Number.isFinite(mkt) && mkt > 0) {
      premium = mkt / nav - 1;
    }

    return {
      id: h.id,
      code,
      type,
      name,
      buyDate,
      confirmDate,
      interestDate,
      invest,
      costPrice,
      shares,
      nav,
      navDate,
      mkt,
      premium,
      value,
      profit,
      roi: profit / invest
    };
  }

  // ---------- 7日曲线：优先从买入日向后取，若交易日>7 则取最近7 ----------
  function pick7Dates(seriesDates, buyDate) {
    const afterBuy = seriesDates.filter((d) => d >= buyDate);
    if (afterBuy.length <= 7) return afterBuy.slice(0, 7);
    return afterBuy.slice(-7); // 持有很久：最近7个交易日
  }

  async function buildCurve(targetId) {
    const points = [];
    const title = targetId === "ALL" ? "总组合" : (holdings.find((x) => x.id === targetId)?.code || "--");

    if (targetId === "ALL") {
      const settled = await Promise.allSettled(holdings.map((h) => buildCurve(h.id)));
      const ok = settled.filter((x) => x.status === "fulfilled").map((x) => x.value);

      const dateSet = new Set();
      ok.forEach((o) => o.points.forEach((p) => dateSet.add(p.date)));
      const dates = [...dateSet].sort().slice(-7);

      for (const d of dates) {
        let investSum = 0;
        let profitSum = 0;
        for (const o of ok) {
          const p = o.points.find((x) => x.date === d);
          if (!p) continue;
          investSum += o.invest;
          profitSum += p.profit;
        }
        if (investSum > 0) points.push({ date: d, profit: profitSum, roi: profitSum / investSum });
      }

      return { title, points, invest: ok.reduce((s, o) => s + o.invest, 0) };
    }

    const h = holdings.find((x) => x.id === targetId);
    if (!h) return { title, points, invest: 0 };

    const one = await computeOne(h);
    const invest = one.invest;

    // 场内：K线close；基金：净值；LOF：K线close（但起息前=0）
    if (h.type === "market") {
      const k = await getKline(h.code);
      const dates = pick7Dates(k.rows.map((r) => r.date), h.buyDate);
      for (const d of dates) {
        const close = k.rows.find((r) => r.date === d)?.close;
        const value = one.shares * close;
        const profit = value - invest;
        points.push({ date: d, profit, roi: profit / invest });
      }
      return { title: `${one.name}（${one.code}）`, points, invest };
    }

    if (h.type === "fund") {
      const navData = await getNav(h.code);
      const series = navData.navSeries;
      const dates = pick7Dates(series.map((x) => x.date), h.buyDate);
      for (const d of dates) {
        const nav = series.find((x) => x.date === d)?.nav;
        if (d < one.interestDate) points.push({ date: d, profit: 0, roi: 0 });
        else {
          const value = one.shares * nav;
          const profit = value - invest;
          points.push({ date: d, profit, roi: profit / invest });
        }
      }
      return { title: `${one.name}（${one.code}）`, points, invest };
    }

    // LOF
    const k = await getKline(h.code);
    const dates = pick7Dates(k.rows.map((r) => r.date), h.buyDate);
    for (const d of dates) {
      const close = k.rows.find((r) => r.date === d)?.close;
      if (d < one.interestDate) points.push({ date: d, profit: 0, roi: 0 });
      else {
        const value = one.shares * close;
        const profit = value - invest;
        points.push({ date: d, profit, roi: profit / invest });
      }
    }
    return { title: `${one.name}（${one.code}）`, points, invest };
  }

  // ---------- 绘图（canvas，两条线：盈亏额 / 收益率） ----------
  function draw(points) {
    const cv = $("cv");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const w = cv.width, h = cv.height;

    ctx.clearRect(0, 0, w, h);

    // grid
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = "#8ea0c7";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = (h * i) / 5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (!points || points.length === 0) {
      ctx.fillStyle = "#8ea0c7";
      ctx.font = "16px system-ui";
      ctx.fillText("暂无曲线数据", 20, 40);
      return;
    }

    const profits = points.map((p) => p.profit);
    const rois = points.map((p) => p.roi);

    const minP = Math.min(...profits), maxP = Math.max(...profits);
    const minR = Math.min(...rois), maxR = Math.max(...rois);

    const pad = 30;
    const xMap = (i) => pad + (w - 2 * pad) * (i / (points.length - 1 || 1));
    const yMapP = (v) => pad + (h - 2 * pad) * (1 - (v - minP) / ((maxP - minP) || 1));
    const yMapR = (v) => pad + (h - 2 * pad) * (1 - (v - minR) / ((maxR - minR) || 1));

    // profit line
    ctx.strokeStyle = "#36d399";
    ctx.lineWidth = 3;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xMap(i), y = yMapP(p.profit);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // roi line
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xMap(i), y = yMapR(p.roi);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // labels
    ctx.fillStyle = "#8ea0c7";
    ctx.font = "12px system-ui";
    points.forEach((p, i) => {
      const x = xMap(i);
      ctx.fillText(p.date.slice(5), x - 14, h - 10);
    });

    ctx.fillStyle = "#cfe0ff";
    ctx.font = "14px system-ui";
    ctx.fillText("绿线=盈亏额  黄线=收益率", 20, 22);
  }

  // ---------- UI render ----------
  function renderMetrics(sumInvest, sumValue, sumProfit) {
    must("mInvest").textContent = fmtMoney(sumInvest);
    must("mValue").textContent = fmtMoney(sumValue);

    const p = must("mProfit");
    p.textContent = fmtMoney(sumProfit);
    p.className = "v " + (sumProfit >= 0 ? "good" : "bad");

    const roi = sumInvest > 0 ? sumProfit / sumInvest : 0;
    const r = must("mRoi");
    r.textContent = fmtPct(roi);
    r.className = "v " + (roi >= 0 ? "good" : "bad");
  }

  function renderTable(rows) {
    const tb = must("tb");
    tb.innerHTML = "";

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="14" class="muted">暂无持仓。先新增一个 (ง •̀_•́)ง</td></tr>`;
      return;
    }

    rows.forEach((r) => {
      const pCls = r.profit >= 0 ? "good" : "bad";
      const rCls = r.roi >= 0 ? "good" : "bad";
      const premTxt = Number.isFinite(r.premium) ? fmtPct(r.premium) : "--";
      const premCls = Number.isFinite(r.premium) ? (r.premium >= 0 ? "warn" : "muted") : "muted";
      const navTxt = Number.isFinite(r.nav) ? (r.nav.toFixed(4) + " (" + r.navDate + ")") : "--";
      const mktTxt = Number.isFinite(r.mkt) ? r.mkt.toFixed(4) : "--";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div style="font-weight:900">${escapeHtml(r.name)}</div><div class="muted">${r.code}</div></td>
        <td class="muted">${typeLabel(r.type)}</td>
        <td class="muted">${r.buyDate}</td>
        <td class="muted">${r.confirmDate}/${r.interestDate}</td>
        <td>${fmtMoney(r.invest)}</td>
        <td class="muted">${Number.isFinite(r.costPrice) ? r.costPrice.toFixed(4) : "--"}</td>
        <td class="muted">${Number.isFinite(r.shares) ? r.shares.toFixed(4) : "--"}</td>
        <td class="muted">${navTxt}</td>
        <td class="muted">${mktTxt}</td>
        <td class="${premCls}">${premTxt}</td>
        <td>${fmtMoney(r.value)}</td>
        <td class="${pCls}">${fmtMoney(r.profit)}</td>
        <td class="${rCls}">${fmtPct(r.roi)}</td>
        <td>
          <button class="secondary" data-act="curve" data-id="${r.id}">曲线</button>
          <button class="danger" data-act="del" data-id="${r.id}">删</button>
        </td>`;
      tb.appendChild(tr);
    });
  }

  function populateCurveSel() {
    const sel = must("curveSel");
    sel.innerHTML = "";

    const all = document.createElement("option");
    all.value = "ALL";
    all.textContent = "总组合";
    sel.appendChild(all);

    holdings.forEach((h) => {
      const o = document.createElement("option");
      o.value = h.id;
      o.textContent = `${h.code} · ${typeLabel(h.type)}`;
      sel.appendChild(o);
    });
  }

  // ---------- Main refresh ----------
  let timer = null;

  async function refreshAll() {
    setStatus(true, `JS：刷新中… ${VERSION}`);
    log("refresh start", { version: VERSION, holdings: holdings.length });

    // 无持仓
    if (!holdings.length) {
      $("hint") && ($("hint").textContent = "持仓数：0");
      renderMetrics(0, 0, 0);
      renderTable([]);
      populateCurveSel();
      $("curveState") && ($("curveState").textContent = "曲线状态：无数据");
      draw([]);
      setStatus(true, `JS：就绪（无持仓）${VERSION}`);
      return;
    }

    const rows = [];
    for (const h of holdings) {
      try {
        const r = await computeOne(h);
        rows.push(r);
      } catch (e) {
        log("computeOne failed", { code: h.code, type: h.type, err: String(e) });
      }
    }

    let sumInvest = 0, sumValue = 0, sumProfit = 0;
    rows.forEach((r) => { sumInvest += r.invest; sumValue += r.value; sumProfit += r.profit; });

    renderMetrics(sumInvest, sumValue, sumProfit);
    renderTable(rows);
    $("hint") && ($("hint").textContent = `持仓数：${rows.length}（失败项看调试信息）`);

    populateCurveSel();
    const target = $("curveSel")?.value || "ALL";

    try {
      const curve = await buildCurve(target);
      $("curveState") && ($("curveState").textContent = curve.points.length ? `曲线状态：${curve.title}（${curve.points.length}点）` : "曲线状态：无数据");
      draw(curve.points);
    } catch (e) {
      log("buildCurve failed", { target, err: String(e) });
      $("curveState") && ($("curveState").textContent = "曲线状态：生成失败（看调试信息）");
      draw([]);
    }

    setStatus(true, `JS：就绪 ✅ ${VERSION}`);
    log("refresh done", { sumInvest, sumValue, sumProfit });
  }

  // ---------- Event bind ----------
  function bindEvents() {
    must("btnRefresh").addEventListener("click", () => refreshAll());

    must("auto").addEventListener("change", () => {
      const s = Number(must("auto").value);
      if (timer) clearInterval(timer);
      timer = null;
      if (s > 0) timer = setInterval(refreshAll, s * 1000);
      log("auto refresh", { seconds: s });
    });

    must("btnClear").addEventListener("click", () => {
      must("inCode").value = "";
      must("inAmount").value = "";
      must("inCostPrice").value = "";
      must("inType").value = "fund";
      must("inCostMode").value = "auto";
      must("inBuyDate").value = todayStr();
    });

    must("btnWipe").addEventListener("click", () => {
      if (!confirm("确定清空全部持仓？")) return;
      holdings = [];
      saveHoldings();
      refreshAll();
    });

    must("btnAdd").addEventListener("click", async () => {
      try {
        const code = must("inCode").value.trim();
        let type = must("inType").value;
        const buyDate = must("inBuyDate").value || todayStr();
        const amount = Number(must("inAmount").value);
        const costMode = must("inCostMode").value;
        const costPrice = must("inCostPrice").value.trim();

        if (!/^[0-9]{6}$/.test(code)) { alert("代码请输入6位数字"); return; }
        if (!(amount > 0)) { alert("投入金额必须 > 0"); return; }

        // 兜底：16开头默认当 LOF（你最关心的 161226）
        if (type === "fund" && code.startsWith("16")) type = "lof";

        const h = { id: uid(), code, type, buyDate, amount, costMode, costPrice };
        holdings.push(h);
        saveHoldings();
        log("add", h);

        await refreshAll();
      } catch (e) {
        log("btnAdd error", { err: String(e) });
        alert("新增失败：看右下调试信息");
      }
    });

    must("curveSel").addEventListener("change", () => refreshAll());

    must("tb").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const act = btn.dataset.act;
      const id = btn.dataset.id;

      if (act === "del") {
        if (!confirm("确定删除？")) return;
        holdings = holdings.filter((x) => x.id !== id);
        saveHoldings();
        refreshAll();
      }

      if (act === "curve") {
        must("curveSel").value = id;
        refreshAll();
      }
    });
  }

  // ---------- Boot ----------
  function boot() {
    setStatus(true, `JS：启动… ${VERSION}`);
    log("boot", { version: VERSION });

    // 默认日期
    $("inBuyDate") && ($("inBuyDate").value = todayStr());

    // 读取持仓
    holdings = loadHoldings();

    // 绑定事件（如果这里报错，就会显示 Missing element id）
    bindEvents();

    // 默认自动刷新 60s（如果你页面没有这个选项，也会提示缺失）
    if ($("auto")) {
      $("auto").value = "60";
      $("auto").dispatchEvent(new Event("change"));
    }

    refreshAll();
  }

  document.addEventListener("DOMContentLoaded", boot);

  // ---------- 小彩蛋：给你一个一键自检 161226 ----------
  window.test161226 = async () => {
    const q = await loadQuote("161226");
    alert(q ? `OK：${q.name}\nsecid=${q.secid}\n现价=${q.price}\n涨跌=${(q.chgPct * 100).toFixed(2)}%` : "161226 无法取到行情（看调试信息）");
  };
})();
