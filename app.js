(() => {
  "use strict";

  const VERSION = "v9_2026-02-02_A";
  const UT = "fa5fd1943c7b386f172d6893dbfba10b";
  const LS_KEY = "fund_holdings_app_v9";
  const LS_MODE = "fund_view_mode_v9";

  const $ = (id) => document.getElementById(id);

  // ===== 中国时区工具：解决你人在海外导致日期错乱 =====
  function cnParts() {
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short", hour12: false
    });
    const parts = dtf.formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t)?.value;
    const y = get("year"), m = get("month"), d = get("day");
    const hh = Number(get("hour")), mm = Number(get("minute"));
    const wd = get("weekday"); // Mon/Tue/...
    return { date: `${y}-${m}-${d}`, hh, mm, wd };
  }

  function marketStateCN() {
    const p = cnParts();
    const dow = p.wd; // Mon Tue Wed Thu Fri Sat Sun
    const isWeekend = (dow === "Sat" || dow === "Sun");
    const t = p.hh * 60 + p.mm;
    const inAM = (t >= 9 * 60 + 30 && t <= 11 * 60 + 30);
    const inPM = (t >= 13 * 60 && t <= 15 * 60);
    const trading = !isWeekend && (inAM || inPM);
    let state = "已收盘";
    if (isWeekend) state = "休市";
    else if (trading) state = "交易中";
    else if (t < 9 * 60 + 30) state = "未开盘";
    return { state, cnDate: p.date };
  }

  const todayStrCN = () => cnParts().date;

  // ===== helpers =====
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

  // ===== storage =====
  let holdings = [];
  let viewMode = localStorage.getItem(LS_MODE) || "intraday"; // intraday / settle

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

  // ===== JSONP =====
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

  // ===== Eastmoney quote + Tencent fallback =====
  function guessSecid(code) {
    const c = String(code);
    if (/^16\d{4}$/.test(c)) return "0." + c;
    if (/^(5|6|9)\d{5}$/.test(c)) return "1." + c;
    return "0." + c;
  }

  function normalizePrice(raw) {
    let p = Number(raw);
    if (!Number.isFinite(p)) return NaN;
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

  // ===== pingzhongdata NAV =====
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

  // ===== fundgz estimate =====
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

  // ===== confirm / interest =====
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

  // ===== 7-day window =====
  function build7dWindow(navSeries, buyDate) {
    if (!Array.isArray(navSeries) || navSeries.length === 0) return null;
    const fromBuy = navSeries.filter(p => p.date >= buyDate);
    const src = fromBuy.length ? fromBuy : navSeries.slice(-7);
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

  // ===== compute one =====
  async function computeOne(h) {
    const code = String(h.code).trim();
    const type = h.type;
    const buyDate = h.buyDate;
    const invest = Number(h.amount);
    const lofPriceMode = h.lofPriceMode || "nav"; // nav/mkt

    let costPrice = (h.costPrice !== "" && h.costPrice != null) ? Number(h.costPrice) : NaN;

    let navData = null;
    let gz = null;
    let quote = null;
    let err = "";

    if (type === "fund" || type === "lof") {
      try { navData = await loadNav(code); }
      catch { err += "净值获取失败; "; }
      try { gz = await loadFundGz(code); }
      catch {}
    }

    if (type === "lof" || type === "market") {
      try { quote = await loadQuote(code); }
      catch { err += "场内行情失败; "; }
      if (!quote) err += "场内行情空; ";
    }

    const series = navData?.navSeries || [];
    let confirmDate = "--", interestDate = "--";
    if ((type === "fund" || type === "lof") && series.length) {
      const ci = calcConfirmInterest(series, buyDate);
      confirmDate = ci.confirmDate;
      interestDate = ci.interestDate;
    }

    // auto cost
    if (!Number.isFinite(costPrice) || costPrice <= 0) {
      if (type === "market") {
        costPrice = Number(quote?.price);
      } else {
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
    const quoteSrc = quote?.src || "--";
    const premium = (type === "lof" && Number.isFinite(nav) && nav > 0 && Number.isFinite(mkt) && mkt > 0) ? (mkt / nav - 1) : NaN;

    const tCN = todayStrCN();
    const notAccruedYet = (interestDate !== "--" && tCN < interestDate);

    // ----- settle (结算口径) -----
    let settleValue = invest, settleProfit = 0;
    if (!notAccruedYet && Number.isFinite(shares)) {
      if (type === "fund") {
        if (Number.isFinite(nav)) { settleValue = shares * nav; settleProfit = settleValue - invest; }
      } else if (type === "lof") {
        if (lofPriceMode === "mkt") {
          if (Number.isFinite(mkt)) { settleValue = shares * mkt; settleProfit = settleValue - invest; }
          else if (Number.isFinite(nav)) { settleValue = shares * nav; settleProfit = settleValue - invest; }
        } else {
          if (Number.isFinite(nav)) { settleValue = shares * nav; settleProfit = settleValue - invest; }
        }
      } else if (type === "market") {
        if (Number.isFinite(mkt)) { settleValue = shares * mkt; settleProfit = settleValue - invest; }
      }
    }

    // ----- intraday (盘中口径) -----
    // 盘中参考价：基金用估值；LOF优先用场内价（更适合你做盘中判断）；无场内则用估值/净值兜底
    let intraPrice = NaN;
    let intraSrc = "--";
    if (type === "market") {
      intraPrice = Number(mkt);
      intraSrc = Number.isFinite(intraPrice) ? `场内价(${quoteSrc})` : "--";
    } else if (type === "fund") {
      intraPrice = Number.isFinite(estNav) ? estNav : nav;
      intraSrc = Number.isFinite(estNav) ? `估值(${estTime})` : "净值(兜底)";
    } else if (type === "lof") {
      if (Number.isFinite(mkt)) { intraPrice = mkt; intraSrc = `场内价(${quoteSrc})`; }
      else if (Number.isFinite(estNav)) { intraPrice = estNav; intraSrc = `估值(${estTime})`; }
      else { intraPrice = nav; intraSrc = "净值(兜底)"; }
    }

    let intraValue = invest, intraProfit = 0;
    if (!notAccruedYet && Number.isFinite(shares) && Number.isFinite(intraPrice) && intraPrice > 0) {
      intraValue = shares * intraPrice;
      intraProfit = intraValue - invest;
    }

    const win7 = (type === "fund" || type === "lof") ? build7dWindow(series, buyDate) : null;

    return {
      id: h.id, code, type, lofPriceMode,
      name, buyDate,
      confirmDate, interestDate,
      invest, costPrice, shares,

      nav, navDate, navDailyPct,
      estNav, estPct, estTime,
      mkt, premium, quoteSrc,

      settleValue, settleProfit, settleRoi: invest > 0 ? settleProfit / invest : 0,
      intraPrice, intraSrc, intraValue, intraProfit, intraRoi: invest > 0 ? intraProfit / invest : 0,

      win7,
      err: err.trim()
    };
  }

  // ===== render =====
  function renderMetrics(sumInvest, sumValue, sumProfit) {
    $("mInvest").textContent = fmtMoney(sumInvest);
    $("mValue").textContent = fmtMoney(sumValue);

    $("mProfit").textContent = fmtMoney(sumProfit);
    $("mProfit").className = "v " + (sumProfit >= 0 ? "good" : "bad");

    const roi = sumInvest > 0 ? sumProfit / sumInvest : 0;
    $("mRoi").textContent = fmtPct(roi);
    $("mRoi").className = "v " + (roi >= 0 ? "good" : "bad");
  }

  function renderTable(rows) {
    const tb = $("tb");
    tb.innerHTML = "";

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="15" class="muted">暂无持仓。先新增一个 (ง •̀_•́)ง</td></tr>`;
      return;
    }

    rows.forEach((r) => {
      const showValue = (viewMode === "intraday") ? r.intraValue : r.settleValue;
      const showProfit = (viewMode === "intraday") ? r.intraProfit : r.settleProfit;
      const showRoi = (viewMode === "intraday") ? r.intraRoi : r.settleRoi;

      const pCls = showProfit >= 0 ? "good" : "bad";
      const rCls = showRoi >= 0 ? "good" : "bad";

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
        <div class="muted">${r.code}${r.type==="lof" ? `（结算按${r.lofPriceMode==="mkt"?"场内价":"净值"}）` : ""}</div>
        <div class="muted">盘中参考：${Number.isFinite(r.intraPrice)? r.intraPrice.toFixed(4):"--"} · ${r.intraSrc}</div>
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
        <td>${fmtMoney(showValue)}</td>
        <td class="${pCls}">${fmtMoney(showProfit)}</td>
        <td class="${rCls}">${fmtPct(showRoi)}</td>
        <td><button class="btn danger" data-act="del" data-id="${r.id}" type="button">删</button></td>
      `;
      tb.appendChild(tr);
    });
  }

  // ===== chart (净值维度) =====
  const chart = { canvas: null, ctx: null };

  function clearCanvas() {
    if (!chart.ctx || !chart.canvas) return;
    chart.ctx.clearRect(0, 0, chart.canvas.width, chart.canvas.height);
  }

  function drawChart(win7, title) {
    if (!chart.ctx || !chart.canvas) return;
    const ctx = chart.ctx;
    const W = chart.canvas.width;
    const H = chart.canvas.height;
    clearCanvas();

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
      ctx.fillText("暂无可绘制数据（净值历史不足）", 16, 38);
      return;
    }

    const pts = win7.points;
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

    ctx.fillStyle = "rgba(233,238,252,.9)";
    ctx.font = "15px system-ui";
    ctx.fillText(title, 16, 20);

    ctx.fillStyle = "rgba(233,238,252,.65)";
    ctx.font = "12px system-ui";
    for (let i = 0; i <= 2; i++) {
      const v = ymin + (ymax - ymin) * (i / 2);
      const y = yAt(v);
      ctx.fillText((v * 100).toFixed(2) + "%", 10, y + 4);
    }

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

    ctx.fillStyle = "rgba(58,242,178,.9)";
    pts.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.cum);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    });

    ctx.fillStyle = "rgba(233,238,252,.6)";
    ctx.font = "12px system-ui";
    ctx.fillText(pts[0].date, left, H - 12);
    const lastText = pts[pts.length - 1].date;
    const tw = ctx.measureText(lastText).width;
    ctx.fillText(lastText, W - right - tw, H - 12);
  }

  function renderChartSelector(rows) {
    const sel = $("selChart");
    sel.innerHTML = "";
    rows.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `${r.code} ${r.name}（${typeLabel(r.type)}）`;
      sel.appendChild(opt);
    });
    if (rows.length) sel.value = rows[0].id;
  }

  function updateChart(rows) {
    const sel = $("selChart");
    const meta = $("chartMeta");
    const r = rows.find(x => x.id === sel.value) || rows[0];
    if (!r) return;

    if (meta) {
      meta.textContent = r.win7 ? `窗口：${r.win7.baseDate} → ${r.win7.endDate}` : "窗口：--";
    }
    drawChart(r.win7, `${r.code} ${r.name} · 7日累计收益（净值维度）`);
  }

  // ===== refresh =====
  let timer = null;
  let lastRows = [];

  async function refreshAll() {
    const ms = marketStateCN();
    setStatus(true, `刷新中… ${VERSION} · ${ms.state} · 口径=${viewMode === "intraday" ? "盘中" : "结算"}`);

    if (!holdings.length) {
      $("hint").textContent = "持仓数：0";
      renderMetrics(0, 0, 0);
      renderTable([]);
      lastRows = [];
      $("selChart").innerHTML = "";
      drawChart(null, "");
      setStatus(true, `就绪 · ${ms.state} · 无持仓`);
      return;
    }

    const rows = [];
    for (const h of holdings) rows.push(await computeOne(h));

    let sumInvest = 0, sumValue = 0, sumProfit = 0;
    rows.forEach(r => {
      sumInvest += r.invest;
      const v = (viewMode === "intraday") ? r.intraValue : r.settleValue;
      const p = (viewMode === "intraday") ? r.intraProfit : r.settleProfit;
      sumValue += v;
      sumProfit += p;
    });

    renderMetrics(sumInvest, sumValue, sumProfit);
    renderTable(rows);
    $("hint").textContent = `持仓数：${rows.length}`;

    const sel = $("selChart");
    const prev = sel.value;
    renderChartSelector(rows);
    if (prev && rows.some(x => x.id === prev)) sel.value = prev;
    updateChart(rows);

    lastRows = rows;

    // 汇总状态：把“为什么看起来像上周五”说清楚
    const anyEst = rows.find(r => r.estTime && r.estTime !== "--");
    const estInfo = anyEst ? `估值最后：${anyEst.estTime}` : "估值：--";
    const navInfo = rows.find(r => r.navDate)?.navDate ? `净值日期：${rows.find(r=>r.navDate).navDate}` : "净值日期：--";

    setStatus(true, `就绪 ✅ ${ms.state} · 口径=${viewMode === "intraday" ? "盘中" : "结算"} · ${estInfo} · ${navInfo}`);
  }

  // ===== events =====
  function bindEvents() {
    function syncLofModeUI() {
      const type = $("inType").value || "fund";
      $("lofModeWrap").style.display = (type === "lof") ? "" : "none";
    }

    $("inType").addEventListener("change", syncLofModeUI);

    $("mode").value = viewMode;
    $("mode").addEventListener("change", () => {
      viewMode = $("mode").value;
      localStorage.setItem(LS_MODE, viewMode);
      refreshAll();
    });

    $("btnRefresh").addEventListener("click", refreshAll);

    $("auto").addEventListener("change", () => {
      const s = Number($("auto").value);
      if (timer) clearInterval(timer);
      timer = null;
      if (s > 0) timer = setInterval(refreshAll, s * 1000);
    });

    $("btnClear").addEventListener("click", () => {
      $("inCode").value = "";
      $("inAmount").value = "";
      $("inCostPrice").value = "";
      $("inType").value = "fund";
      $("inLofPriceMode").value = "nav";
      $("inBuyDate").value = todayStrCN();
      syncLofModeUI();
    });

    $("btnWipe").addEventListener("click", () => {
      if (!confirm("确定清空全部持仓？")) return;
      holdings = [];
      saveHoldings();
      refreshAll();
    });

    $("btnAdd").addEventListener("click", async () => {
      const code = $("inCode").value.trim();
      const type = $("inType").value || "fund";
      const buyDate = $("inBuyDate").value || todayStrCN();
      const amount = Number($("inAmount").value);
      const costPriceRaw = ($("inCostPrice").value || "").trim();
      const lofPriceMode = $("inLofPriceMode").value || "nav";

      if (!/^[0-9]{6}$/.test(code)) { alert("代码请输入6位数字"); return; }
      if (!(amount > 0)) { alert("投入金额必须 > 0"); return; }

      holdings.push({
        id: uid(),
        code, type, buyDate,
        amount,
        costPrice: costPriceRaw,
        lofPriceMode
      });

      saveHoldings();
      await refreshAll();
    });

    $("tb").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      if (btn.dataset.act === "del") {
        if (!confirm("确定删除？")) return;
        holdings = holdings.filter(x => x.id !== btn.dataset.id);
        saveHoldings();
        refreshAll();
      }
    });

    $("selChart").addEventListener("change", () => updateChart(lastRows));

    syncLofModeUI();
  }

  function boot() {
    holdings = loadHoldings();
    $("inBuyDate").value = todayStrCN();

    chart.canvas = $("chart");
    chart.ctx = chart.canvas ? chart.canvas.getContext("2d") : null;

    bindEvents();

    $("auto").value = "60";
    $("auto").dispatchEvent(new Event("change"));

    setStatus(true, `启动… ${VERSION}`);
    refreshAll();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
