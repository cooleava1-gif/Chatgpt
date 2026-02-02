/* app.js — GitHub Pages 版基金看板（v8）
 * 关键修复：
 * 1) LOF 默认按场外净值算盈亏；可选按场内价算（LOF计价方式）
 * 2) 删除页面调试栏（仅保留状态提示）
 * 3) fund/lof 都显示盘中估值（估值=推算，净值=官方）
 * 4) 7日曲线恢复：按买入日起，截取最近 7 个交易日做“累计收益曲线”
 */

(() => {
  "use strict";

  const VERSION = "v8_2026-02-02";
  const UT = "fa5fd1943c7b386f172d6893dbfba10b";
  const LS_KEY = "fund_holdings_app_v8";

  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------
  const safeJSON = (o) => { try { return JSON.stringify(o); } catch { return String(o); } };
  const todayStr = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  const fmtMoney = (n) => Number.isFinite(n) ? Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "--";
  const fmtPct = (n) => Number.isFinite(n) ? (n * 100).toFixed(2) + "%" : "--";

  function setStatus(ok, text) {
    const el = $("status");
    if (!el) return;
    el.textContent = text;
    el.style.borderColor = ok ? "rgba(54,211,153,.6)" : "rgba(251,113,133,.6)";
    el.style.color = ok ? "#bfffe5" : "#ffd1d9";
  }

  function typeLabel(t) {
    if (t === "fund") return "基金";
    if (t === "lof") return "LOF";
    return "场内";
  }

  // ---------- storage ----------
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

  // ---------- JSONP ----------
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

  // ---------- Eastmoney quote + Tencent fallback ----------
  function guessSecid(code) {
    const c = String(code);
    if (/^16\d{4}$/.test(c)) return "0." + c; // 16xxxx LOF 通常深市
    if (/^(5|6|9)\d{5}$/.test(c)) return "1." + c; // 沪市
    return "0." + c; // 默认深市
  }

  function normalizePrice(raw) {
    let p = Number(raw);
    if (!Number.isFinite(p)) return NaN;
    // 东财 f2 可能是 *1000
    if (p > 1000 && p < 100000) p /= 1000;
    else if (p >= 100000) p /= 100;
    return p;
  }

  async function quoteEastmoney(code) {
    const c = String(code).trim();
    const first = guessSecid(c);
    const second = first.startsWith("0.") ? ("1." + c) : ("0." + c);

    const tryOne = async (secid) => {
      const url = `https://push2.eastmoney.com/api/qt/stock/get?ut=${UT}&secid=${encodeURIComponent(secid)}&fields=f2,f3,f12,f14`;
      const resp = await jsonp(url, "cb", 12000);
      const d = resp && resp.data;
      if (!d) return null;
      const name = d.f14;
      const price = normalizePrice(d.f2);
      const chgPct = Number(d.f3) / 100;
      if (!name || !Number.isFinite(price) || price <= 0) return null;
      return { src: "eastmoney", secid, name, price, chgPct };
    };

    try { const a = await tryOne(first); if (a) return a; } catch {}
    try { const b = await tryOne(second); if (b) return b; } catch {}
    return null;
  }

  function guessTxPrefix(code) {
    return /^(5|6|9)\d{5}$/.test(String(code)) ? "sh" : "sz";
  }

  function quoteTencent(code) {
    return new Promise((resolve) => {
      const c = String(code).trim();
      const p1 = guessTxPrefix(c);
      const p2 = p1 === "sz" ? "sh" : "sz";

      const tryOne = (prefix) => new Promise((res) => {
        const varName = `v_${prefix}${c}`;
        const url = `https://qt.gtimg.cn/q=${prefix}${c}&r=${Date.now()}`;
        const s = document.createElement("script");

        const timer = setTimeout(() => { cleanup(); res(null); }, 8000);
        function cleanup() {
          clearTimeout(timer);
          s.remove();
          try { delete window[varName]; } catch {}
        }

        s.onload = () => {
          try {
            const raw = window[varName];
            cleanup();
            if (!raw || typeof raw !== "string") return res(null);
            const parts = raw.split("~");
            const name = parts[1];
            const price = Number(parts[3]);
            const prev = Number(parts[4]);
            if (!name || !Number.isFinite(price) || price <= 0) return res(null);
            const chgPct = (Number.isFinite(prev) && prev > 0) ? (price / prev - 1) : NaN;
            res({ src: "tencent", secid: `${prefix}.${c}`, name, price, chgPct });
          } catch {
            cleanup(); res(null);
          }
        };
        s.onerror = () => { cleanup(); res(null); };
        s.src = url;
        document.head.appendChild(s);
      });

      (async () => {
        const a = await tryOne(p1);
        if (a) return resolve(a);
        const b = await tryOne(p2);
        resolve(b || null);
      })();
    });
  }

  async function loadQuote(code) {
    const em = await quoteEastmoney(code);
    if (em) return em;
    return await quoteTencent(code);
  }

  // ---------- pingzhongdata NAV ----------
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

          const navSeries = trend.map(it => ({ date: msToDate(it.x), nav: Number(it.y) }))
            .filter(x => x.date && Number.isFinite(x.nav))
            .sort((a, b) => a.date.localeCompare(b.date));

          const last = navSeries[navSeries.length - 1];
          const prev = navSeries[navSeries.length - 2];
          const dailyPct = (prev && prev.nav > 0) ? (last.nav / prev.nav - 1) : NaN;

          ["fS_name","fS_code","Data_netWorthTrend","Data_ACWorthTrend","Data_grandTotal"].forEach(k => { try { delete window[k]; } catch {} });
          s.remove();

          resolve({
            code: c, name,
            navSeries,
            latestNav: last.nav,
            latestNavDate: last.date,
            latestDailyPct: dailyPct
          });
        } catch (e) {
          s.remove(); reject(e);
        }
      };

      s.onerror = () => { s.remove(); reject(new Error("pingzhongdata load error")); };
      s.src = url;
      document.head.appendChild(s);
    });
  }

  // ---------- fundgz estimate ----------
  function loadFundGz(code) {
    return new Promise((resolve) => {
      const c = String(code).trim();
      const url = `https://fundgz.1234567.com.cn/js/${c}.js?rt=${Date.now()}`;
      const s = document.createElement("script");
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(null);
      }, 9000);

      function cleanup() {
        clearTimeout(timer);
        s.remove();
        try { delete window.jsonpgz; } catch {}
      }

      window.jsonpgz = (data) => {
        if (done) return;
        done = true;
        cleanup();
        if (!data || !data.gsz) return resolve(null);
        resolve({
          estNav: Number(data.gsz),
          estPct: Number(data.gszzl) / 100,
          estTime: data.gztime || "--",
          baseDate: data.jzrq || "--",
          baseNav: Number(data.dwjz)
        });
      };

      s.onerror = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(null);
      };

      s.src = url;
      document.head.appendChild(s);
    });
  }

  // ---------- confirm / interest ----------
  function calcConfirmInterest(navSeries, buyDate) {
    const idx = navSeries.findIndex(x => x.date >= buyDate);
    if (idx === -1) {
      const last = navSeries[navSeries.length - 1];
      return { confirmDate: last.date, interestDate: last.date };
    }
    const confirm = navSeries[idx].date;
    const interest = navSeries[idx + 1]?.date || confirm;
    return { confirmDate: confirm, interestDate: interest };
  }

  // ---------- 7-day window from buyDate ----------
  function build7dWindow(navSeries, buyDate) {
    if (!Array.isArray(navSeries) || navSeries.length === 0) return null;

    // 从 buyDate 起拿所有点
    const fromBuy = navSeries.filter(p => p.date >= buyDate);
    const src = fromBuy.length ? fromBuy : navSeries.slice(-7);

    // 取“最近 7 个交易日”
    const win = src.slice(-7);

    if (win.length < 2) return null;

    const base = win[0].nav;
    const points = win.map(p => ({
      date: p.date,
      nav: p.nav,
      cum: (base > 0) ? (p.nav / base - 1) : 0
    }));
    return { points, baseDate: win[0].date, endDate: win[win.length - 1].date };
  }

  // ---------- compute one ----------
  async function computeOne(h) {
    const code = String(h.code).trim();
    const type = h.type;
    const buyDate = h.buyDate;
    const invest = Number(h.amount);

    let costPrice = (h.costPrice !== "" && h.costPrice != null) ? Number(h.costPrice) : NaN;
    const lofPriceMode = h.lofPriceMode || "nav"; // nav / mkt

    let navData = null;
    let gz = null;
    let quote = null;
    let err = "";

    // fund/lof -> NAV
    if (type === "fund" || type === "lof") {
      try { navData = await loadNav(code); }
      catch (e) { err += "净值获取失败; "; }
    }

    // fund/lof -> estimate
    if (type === "fund" || type === "lof") {
      try { gz = await loadFundGz(code); }
      catch (e) { /* ignore */ }
    }

    // lof/market -> quote
    if (type === "lof" || type === "market") {
      try { quote = await loadQuote(code); }
      catch (e) { err += "场内行情失败; "; }
      if (!quote) err += "场内行情空; ";
    }

    // confirm / interest
    let confirmDate = "--", interestDate = "--";
    const series = navData?.navSeries || [];
    if ((type === "fund" || type === "lof") && series.length) {
      const ci = calcConfirmInterest(series, buyDate);
      confirmDate = ci.confirmDate;
      interestDate = ci.interestDate;
    }

    // auto costPrice:
    if (!Number.isFinite(costPrice) || costPrice <= 0) {
      if (type === "market") {
        // 场内：没填成本单价时，只能用“当前价”做近似（会不准）
        costPrice = Number(quote?.price);
      } else {
        // fund/lof：用确认日净值
        const navOnConfirm = series.find(x => x.date === confirmDate)?.nav;
        costPrice = Number(navOnConfirm) || Number(navData?.latestNav);
      }
    }

    const shares = (Number.isFinite(costPrice) && costPrice > 0) ? (invest / costPrice) : NaN;

    const name = quote?.name || navData?.name || "--";
    const nav = navData?.latestNav;
    const navDate = navData?.latestNavDate;
    const navDailyPct = navData?.latestDailyPct;

    const estNav = gz?.estNav;
    const estPct = gz?.estPct;
    const estTime = gz?.estTime;

    const mkt = quote?.price;
    const premium = (type === "lof" && Number.isFinite(nav) && nav > 0 && Number.isFinite(mkt) && mkt > 0) ? (mkt / nav - 1) : NaN;

    // Profit accrual: before interestDate -> 0
    const t = todayStr();
    const notAccruedYet = (interestDate !== "--" && t < interestDate);

    let value = invest, profit = 0;
    if (!notAccruedYet && Number.isFinite(shares)) {
      if (type === "fund") {
        if (Number.isFinite(nav)) { value = shares * nav; profit = value - invest; }
      } else if (type === "lof") {
        // 关键：默认按 NAV 算（你要的 126 左右）
        if (lofPriceMode === "mkt") {
          if (Number.isFinite(mkt)) { value = shares * mkt; profit = value - invest; }
          else if (Number.isFinite(nav)) { value = shares * nav; profit = value - invest; }
        } else {
          if (Number.isFinite(nav)) { value = shares * nav; profit = value - invest; }
        }
      } else if (type === "market") {
        if (Number.isFinite(mkt)) { value = shares * mkt; profit = value - invest; }
      }
    }

    // 7d window (NAV based, for fund/lof)
    const win7 = (type === "fund" || type === "lof") ? build7dWindow(series, buyDate) : null;

    return {
      id: h.id, code, type, lofPriceMode,
      name, buyDate,
      confirmDate, interestDate,
      invest, costPrice, shares,
      nav, navDate, navDailyPct,
      estNav, estPct, estTime,
      mkt, premium,
      value, profit, roi: invest > 0 ? profit / invest : 0,
      win7,
      err: err.trim()
    };
  }

  // ---------- render metrics ----------
  function renderMetrics(sumInvest, sumValue, sumProfit) {
    if ($("mInvest")) $("mInvest").textContent = fmtMoney(sumInvest);
    if ($("mValue")) $("mValue").textContent = fmtMoney(sumValue);

    if ($("mProfit")) {
      $("mProfit").textContent = fmtMoney(sumProfit);
      $("mProfit").className = "v " + (sumProfit >= 0 ? "good" : "bad");
    }
    const roi = sumInvest > 0 ? sumProfit / sumInvest : 0;
    if ($("mRoi")) {
      $("mRoi").textContent = fmtPct(roi);
      $("mRoi").className = "v " + (roi >= 0 ? "good" : "bad");
    }
  }

  // ---------- table ----------
  function renderTable(rows) {
    const tb = $("tb");
    if (!tb) return;
    tb.innerHTML = "";

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="15" class="muted">暂无持仓。先新增一个 (ง •̀_•́)ง</td></tr>`;
      return;
    }

    rows.forEach((r) => {
      const pCls = r.profit >= 0 ? "good" : "bad";
      const rCls = r.roi >= 0 ? "good" : "bad";

      const navLine = Number.isFinite(r.nav)
        ? `${r.nav.toFixed(4)}（${r.navDate}，日=${fmtPct(r.navDailyPct)}）`
        : "--";

      const estLine = (Number.isFinite(r.estNav) && Number.isFinite(r.estPct))
        ? `${r.estNav.toFixed(4)}（${r.estTime}，估=${fmtPct(r.estPct)}）`
        : "--";

      const mktTxt = Number.isFinite(r.mkt) ? r.mkt.toFixed(4) : "--";
      const premTxt = Number.isFinite(r.premium) ? fmtPct(r.premium) : "--";

      const nameHtml = `
        <div style="font-weight:900">${r.name}</div>
        <div class="muted">${r.code}${r.type==="lof" ? `（按${r.lofPriceMode==="mkt"?"场内价":"净值"}算）` : ""}</div>
        ${r.err ? `<div class="muted">⚠ ${r.err}</div>` : ""}
      `;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${nameHtml}</td>
        <td class="muted">${typeLabel(r.type)}</td>
        <td class="muted">${r.buyDate}</td>
        <td class="muted">${r.confirmDate}/${r.interestDate}</td>
        <td>${fmtMoney(r.invest)}</td>
        <td class="muted">${Number.isFinite(r.costPrice) ? r.costPrice.toFixed(4) : "--"}</td>
        <td class="muted">${Number.isFinite(r.shares) ? r.shares.toFixed(4) : "--"}</td>
        <td><div class="muted">${navLine}</div></td>
        <td><div class="muted">${estLine}</div></td>
        <td class="muted">${mktTxt}</td>
        <td class="muted">${premTxt}</td>
        <td>${fmtMoney(r.value)}</td>
        <td class="${pCls}">${fmtMoney(r.profit)}</td>
        <td class="${rCls}">${fmtPct(r.roi)}</td>
        <td><button class="btn danger" data-act="del" data-id="${r.id}" type="button">删</button></td>
      `;
      tb.appendChild(tr);
    });
  }

  // ---------- chart ----------
  const chart = {
    canvas: null,
    ctx: null
  };

  function clearCanvas() {
    if (!chart.ctx || !chart.canvas) return;
    const ctx = chart.ctx;
    ctx.clearRect(0, 0, chart.canvas.width, chart.canvas.height);
  }

  function drawChart(win7, title) {
    if (!chart.ctx || !chart.canvas) return;
    const ctx = chart.ctx;
    const W = chart.canvas.width;
    const H = chart.canvas.height;

    clearCanvas();

    // background grid
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.lineWidth = 1;

    for (let i = 1; i <= 4; i++) {
      const y = (H / 5) * i;
      ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(W - 12, y); ctx.stroke();
    }
    ctx.restore();

    if (!win7 || !win7.points || win7.points.length < 2) {
      ctx.fillStyle = "rgba(233,238,252,.65)";
      ctx.font = "14px system-ui";
      ctx.fillText("暂无可绘制数据（可能净值未拉到或交易日不足）", 16, 38);
      return;
    }

    const pts = win7.points;

    // y range from cum returns
    let ymin = Infinity, ymax = -Infinity;
    pts.forEach(p => { ymin = Math.min(ymin, p.cum); ymax = Math.max(ymax, p.cum); });
    if (ymin === ymax) { ymin -= 0.01; ymax += 0.01; }
    const pad = (ymax - ymin) * 0.15;
    ymin -= pad; ymax += pad;

    const left = 46, right = 14, top = 30, bottom = 34;
    const plotW = W - left - right;
    const plotH = H - top - bottom;

    const xAt = (i) => left + (plotW * i) / (pts.length - 1);
    const yAt = (v) => top + (1 - (v - ymin) / (ymax - ymin)) * plotH;

    // title
    ctx.fillStyle = "rgba(233,238,252,.9)";
    ctx.font = "15px system-ui";
    ctx.fillText(title, 16, 20);

    // y labels (3 ticks)
    ctx.fillStyle = "rgba(233,238,252,.65)";
    ctx.font = "12px system-ui";
    for (let i = 0; i <= 2; i++) {
      const v = ymin + (ymax - ymin) * (i / 2);
      const y = yAt(v);
      ctx.fillText((v * 100).toFixed(2) + "%", 10, y + 4);
    }

    // line
    ctx.strokeStyle = "rgba(122,162,255,.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.cum);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // points
    ctx.fillStyle = "rgba(58,242,178,.9)";
    pts.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.cum);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // x labels (first / last)
    ctx.fillStyle = "rgba(233,238,252,.6)";
    ctx.font = "12px system-ui";
    ctx.fillText(pts[0].date, left, H - 12);
    const lastText = pts[pts.length - 1].date;
    const tw = ctx.measureText(lastText).width;
    ctx.fillText(lastText, W - right - tw, H - 12);
  }

  function renderChartSelector(rows) {
    const sel = $("selChart");
    if (!sel) return;

    sel.innerHTML = "";
    rows.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `${r.code} ${r.name}（${typeLabel(r.type)}）`;
      sel.appendChild(opt);
    });

    // default
    if (rows.length) sel.value = rows[0].id;
  }

  function updateChart(rows) {
    const sel = $("selChart");
    const meta = $("chartMeta");
    if (!sel || !rows) return;

    const r = rows.find(x => x.id === sel.value) || rows[0];
    if (!r) return;

    if (meta) {
      if (r.win7) meta.textContent = `窗口：${r.win7.baseDate} → ${r.win7.endDate}`;
      else meta.textContent = "窗口：--";
    }

    const title = `${r.code} ${r.name} · 7日累计收益（按净值）`;
    drawChart(r.win7, title);
  }

  // ---------- refresh ----------
  let timer = null;
  let lastRows = [];

  async function refreshAll() {
    setStatus(true, `JS：刷新中… ${VERSION}`);

    if (!holdings.length) {
      $("hint") && ($("hint").textContent = "持仓数：0");
      renderMetrics(0, 0, 0);
      renderTable([]);
      lastRows = [];
      const sel = $("selChart"); if (sel) sel.innerHTML = "";
      drawChart(null, "");
      setStatus(true, `JS：就绪（无持仓）${VERSION}`);
      return;
    }

    const rows = [];
    for (const h of holdings) rows.push(await computeOne(h));

    let sumInvest = 0, sumValue = 0, sumProfit = 0;
    rows.forEach(r => { sumInvest += r.invest; sumValue += r.value; sumProfit += r.profit; });

    renderMetrics(sumInvest, sumValue, sumProfit);
    renderTable(rows);

    $("hint") && ($("hint").textContent = `持仓数：${rows.length}`);

    // chart selector
    const sel = $("selChart");
    const prev = sel?.value;
    renderChartSelector(rows);
    if (sel && prev && rows.some(x => x.id === prev)) sel.value = prev;
    updateChart(rows);

    lastRows = rows;
    setStatus(true, `JS：就绪 ✅ ${VERSION}`);
  }

  // ---------- events ----------
  function bindEvents() {
    // show/hide LOF pricing mode
    function syncLofModeUI() {
      const type = $("inType")?.value || "fund";
      const wrap = $("lofModeWrap");
      if (wrap) wrap.style.display = (type === "lof") ? "" : "none";
    }

    $("inType") && $("inType").addEventListener("change", syncLofModeUI);

    $("btnRefresh") && $("btnRefresh").addEventListener("click", refreshAll);

    const auto = $("auto");
    if (auto) {
      auto.addEventListener("change", () => {
        const s = Number(auto.value);
        if (timer) clearInterval(timer);
        timer = null;
        if (s > 0) timer = setInterval(refreshAll, s * 1000);
      });
    }

    $("btnClear") && $("btnClear").addEventListener("click", () => {
      $("inCode") && ($("inCode").value = "");
      $("inAmount") && ($("inAmount").value = "");
      $("inCostPrice") && ($("inCostPrice").value = "");
      $("inType") && ($("inType").value = "fund");
      $("inLofPriceMode") && ($("inLofPriceMode").value = "nav");
      $("inBuyDate") && ($("inBuyDate").value = todayStr());
      syncLofModeUI();
    });

    $("btnWipe") && $("btnWipe").addEventListener("click", () => {
      if (!confirm("确定清空全部持仓？")) return;
      holdings = [];
      saveHoldings();
      refreshAll();
    });

    $("btnAdd") && $("btnAdd").addEventListener("click", async () => {
      const code = $("inCode")?.value?.trim() || "";
      const type = $("inType")?.value || "fund";
      const buyDate = $("inBuyDate")?.value || todayStr();
      const amount = Number($("inAmount")?.value);

      const costPriceRaw = ($("inCostPrice")?.value || "").trim();
      const lofPriceMode = $("inLofPriceMode")?.value || "nav";

      if (!/^[0-9]{6}$/.test(code)) { alert("代码请输入6位数字"); return; }
      if (!(amount > 0)) { alert("投入金额必须 > 0"); return; }

      const h = {
        id: uid(),
        code,
        type,
        lofPriceMode,
        buyDate,
        amount,
        costPrice: costPriceRaw
      };

      holdings.push(h);
      saveHoldings();
      await refreshAll();
    });

    // delete
    $("tb") && $("tb").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      if (btn.dataset.act === "del") {
        if (!confirm("确定删除？")) return;
        holdings = holdings.filter(x => x.id !== btn.dataset.id);
        saveHoldings();
        refreshAll();
      }
    });

    // chart select
    $("selChart") && $("selChart").addEventListener("change", () => {
      updateChart(lastRows);
    });

    syncLofModeUI();
  }

  // ---------- boot ----------
  function boot() {
    holdings = loadHoldings();
    $("inBuyDate") && ($("inBuyDate").value = todayStr());

    chart.canvas = $("chart");
    chart.ctx = chart.canvas ? chart.canvas.getContext("2d") : null;

    bindEvents();

    // auto refresh default
    if ($("auto")) {
      $("auto").value = "60";
      $("auto").dispatchEvent(new Event("change"));
    }

    setStatus(true, `JS：启动… ${VERSION}`);
    refreshAll();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
