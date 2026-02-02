/* app.js — GitHub Pages 版基金看板（v6）
 * 修复点：
 * 1) quote 获取不再用 fetch：改为 script 注入（JSONP/类JSONP），绕开CORS
 * 2) 161226 等 LOF 自动识别深/沪，并加腾讯行情兜底
 * 3) quote 失败不再让整笔“消失”，总投入不会变 0，表格提示错误
 */

(() => {
  "use strict";

  const VERSION = "v6_2026-02-02";
  const UT = "fa5fd1943c7b386f172d6893dbfba10b";

  const $ = (id) => document.getElementById(id);

  // ---------- debug ----------
  const logLines = [];
  function safeJSON(x){ try{return JSON.stringify(x)}catch{return String(x)} }
  function log(msg, obj){
    const t = new Date().toLocaleString();
    logLines.push(`[${t}] ${msg}${obj ? " " + safeJSON(obj) : ""}`);
    if (logLines.length > 300) logLines.shift();
    const dbg = $("dbg");
    if (dbg) dbg.textContent = logLines.join("\n");
  }
  function setStatus(ok, text){
    const el = $("status");
    if (!el) return;
    el.textContent = text;
    el.style.borderColor = ok ? "rgba(54,211,153,.6)" : "rgba(251,113,133,.6)";
    el.style.color = ok ? "#bfffe5" : "#ffd1d9";
  }

  window.addEventListener("error", (e) => {
    setStatus(false, "JS：报错（看调试信息）");
    log("window.error", { message: e.message, file: e.filename, line: e.lineno, col: e.colno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    setStatus(false, "JS：Promise报错（看调试信息）");
    log("unhandledrejection", { reason: String(e.reason) });
  });

  // ---------- fmt ----------
  const fmtMoney = (n) => (Number.isFinite(n) ? Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "--");
  const fmtPct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(2) + "%" : "--");
  const todayStr = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };

  function typeLabel(t){
    if (t === "fund") return "基金";
    if (t === "lof") return "LOF";
    return "场内";
  }

  // ---------- storage ----------
  const LS_KEY = "fund_holdings_app_v6";
  let holdings = [];
  function loadHoldings(){
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]") || []; }
    catch { return []; }
  }
  function saveHoldings(){
    localStorage.setItem(LS_KEY, JSON.stringify(holdings));
  }
  function uid(){
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  // ---------- JSONP ----------
  function jsonp(url, cbParam = "cb", timeoutMs = 12000){
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

      function cleanup(){
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

  // ---------- quote: Eastmoney (JSONP) ----------
  function guessSecid(code){
    const c = String(code);
    if (/^16\d{4}$/.test(c)) return "0." + c;            // 161xxx 优先深市（关键）
    if (/^(5|6|9)\d{5}$/.test(c)) return "1." + c;       // 沪市常见
    return "0." + c;
  }

  function normalizePrice(raw){
    let p = Number(raw);
    if (!Number.isFinite(p)) return NaN;
    // 把 4183 -> 4.183 这类情况拉回正常区间
    if (p > 1000 && p < 100000) p = p / 1000;
    else if (p >= 100000) p = p / 100;
    return p;
  }

  async function quoteEastmoney(code){
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

    try {
      const q1 = await tryOne(first);
      if (q1) return q1;
    } catch (e) { log("quote eastmoney first failed", { code: c, secid: first, err: String(e) }); }

    try {
      const q2 = await tryOne(second);
      if (q2) return q2;
    } catch (e) { log("quote eastmoney second failed", { code: c, secid: second, err: String(e) }); }

    return null;
  }

  // ---------- quote: Tencent fallback (script variable) ----------
  function guessTxPrefix(code){
    const c = String(code);
    if (/^(5|6|9)\d{5}$/.test(c)) return "sh";
    return "sz"; // 161226 -> sz161226
  }

  function quoteTencent(code){
    return new Promise((resolve) => {
      const c = String(code).trim();
      const p1 = guessTxPrefix(c);
      const p2 = p1 === "sz" ? "sh" : "sz";

      const tryOne = (prefix) => new Promise((res) => {
        const varName = `v_${prefix}${c}`;
        const url = `https://qt.gtimg.cn/q=${prefix}${c}&r=${Date.now()}`;
        const s = document.createElement("script");

        const timer = setTimeout(() => {
          cleanup();
          res(null);
        }, 8000);

        function cleanup(){
          clearTimeout(timer);
          s.remove();
          try { delete window[varName]; } catch {}
        }

        s.onload = () => {
          try {
            const raw = window[varName];
            cleanup();
            if (!raw || typeof raw !== "string") return res(null);
            // 格式： "51~名称~代码~现价~昨收~今开~..."
            const parts = raw.split("~");
            const name = parts[1];
            const price = Number(parts[3]);
            const prev = Number(parts[4]);
            if (!name || !Number.isFinite(price) || price <= 0) return res(null);
            const chgPct = Number.isFinite(prev) && prev > 0 ? (price / prev - 1) : NaN;
            res({ src: "tencent", secid: `${prefix}.${c}`, name, price, chgPct });
          } catch {
            cleanup();
            res(null);
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

  async function loadQuote(code){
    // 先东财，再腾讯兜底
    const em = await quoteEastmoney(code);
    if (em) return em;
    const tx = await quoteTencent(code);
    if (tx) return tx;
    return null;
  }

  // ---------- NAV: pingzhongdata ----------
  function msToDate(ms){
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  function loadNav(code){
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
            .sort((a,b) => a.date.localeCompare(b.date));

          const last = navSeries[navSeries.length - 1];

          ["fS_name","fS_code","Data_netWorthTrend","Data_ACWorthTrend","Data_grandTotal"].forEach(k => {
            try { delete window[k]; } catch {}
          });
          s.remove();

          resolve({ code: c, name, navSeries, latestNav: last.nav, latestNavDate: last.date });
        } catch (e) {
          s.remove();
          reject(e);
        }
      };

      s.onerror = () => { s.remove(); reject(new Error("pingzhongdata load error")); };
      s.src = url;
      document.head.appendChild(s);
    });
  }

  // ---------- confirm/interest ----------
  function calcConfirmInterest(navSeries, buyDate){
    const idx = navSeries.findIndex(x => x.date >= buyDate);
    if (idx === -1) {
      const last = navSeries[navSeries.length - 1];
      return { confirmDate: last.date, interestDate: last.date };
    }
    const confirm = navSeries[idx].date;
    const interest = navSeries[idx + 1]?.date || confirm;
    return { confirmDate: confirm, interestDate: interest };
  }

  // ---------- compute one (永不 throw) ----------
  async function computeOne(h){
    const code = String(h.code).trim();
    const type = h.type;
    const buyDate = h.buyDate;
    const invest = Number(h.amount);

    const costMode = h.costMode || "auto";
    let costPrice = Number(h.costPrice);

    let navData = null;
    let quote = null;
    let err = "";

    // NAV（fund/lof）
    if (type === "fund" || type === "lof") {
      try { navData = await loadNav(code); }
      catch (e) { err += "nav failed; "; log("nav failed", { code, err: String(e) }); }
    }

    // QUOTE（lof/market）
    if (type === "lof" || type === "market") {
      try { quote = await loadQuote(code); }
      catch (e) { err += "quote failed; "; log("quote failed", { code, err: String(e) }); }
      if (!quote) err += "quote null; ";
    }

    // 成本 / 份额
    let confirmDate = "--", interestDate = "--";
    let shares = NaN;

    if (type === "market") {
      // 场内：没有历史K线就用当前价
      if (!Number.isFinite(costPrice) || costPrice <= 0) {
        if (costMode === "manual" && Number.isFinite(costPrice) && costPrice > 0) {
          // keep
        } else {
          costPrice = Number(quote?.price);
        }
      }
      shares = (Number.isFinite(costPrice) && costPrice > 0) ? (invest / costPrice) : NaN;
    } else {
      // fund/lof：确认日净值
      const series = navData?.navSeries || [];
      if (series.length) {
        const ci = calcConfirmInterest(series, buyDate);
        confirmDate = ci.confirmDate;
        interestDate = ci.interestDate;
      }

      if (!Number.isFinite(costPrice) || costPrice <= 0) {
        if (costMode === "manual" && Number.isFinite(costPrice) && costPrice > 0) {
          // keep
        } else {
          const navOnConfirm = series.find(x => x.date === confirmDate)?.nav;
          costPrice = Number(navOnConfirm) || Number(navData?.latestNav);
        }
      }
      shares = (Number.isFinite(costPrice) && costPrice > 0) ? (invest / costPrice) : NaN;
    }

    const name = quote?.name || navData?.name || "--";
    const nav = navData?.latestNav;
    const navDate = navData?.latestNavDate;
    const mkt = quote?.price;

    const t = todayStr();
    const notAccruedYet = (interestDate !== "--" && t < interestDate);

    let value = invest;
    let profit = 0;

    if (!notAccruedYet && Number.isFinite(shares)) {
      if (type === "fund" && Number.isFinite(nav)) {
        value = shares * nav;
        profit = value - invest;
      }
      if (type === "lof") {
        // 优先用场内价（含溢价），没有就退回净值
        if (Number.isFinite(mkt)) {
          value = shares * mkt;
          profit = value - invest;
        } else if (Number.isFinite(nav)) {
          value = shares * nav;
          profit = value - invest;
        }
      }
      if (type === "market" && Number.isFinite(mkt)) {
        value = shares * mkt;
        profit = value - invest;
      }
    }

    let premium = NaN;
    if (type === "lof" && Number.isFinite(nav) && nav > 0 && Number.isFinite(mkt) && mkt > 0) {
      premium = mkt / nav - 1;
    }

    return {
      id: h.id, code, type, name, buyDate,
      confirmDate, interestDate,
      invest,
      costPrice, shares,
      nav, navDate,
      mkt,
      premium,
      value, profit,
      roi: invest > 0 ? profit / invest : 0,
      err: err.trim()
    };
  }

  // ---------- table render ----------
  function renderMetrics(sumInvest, sumValue, sumProfit){
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

  function renderTable(rows){
    const tb = $("tb");
    if (!tb) return;
    tb.innerHTML = "";

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="14" class="muted">暂无持仓。先新增一个 (ง •̀_•́)ง</td></tr>`;
      return;
    }

    rows.forEach((r) => {
      const pCls = r.profit >= 0 ? "good" : "bad";
      const rCls = r.roi >= 0 ? "good" : "bad";
      const premTxt = Number.isFinite(r.premium) ? fmtPct(r.premium) : "--";
      const navTxt = Number.isFinite(r.nav) ? (r.nav.toFixed(4) + " (" + r.navDate + ")") : "--";
      const mktTxt = Number.isFinite(r.mkt) ? r.mkt.toFixed(4) : "--";
      const errTxt = r.err ? `⚠ ${r.err}` : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div style="font-weight:900">${r.name}</div><div class="muted">${r.code}</div><div class="muted" style="font-size:12px">${errTxt}</div></td>
        <td class="muted">${typeLabel(r.type)}</td>
        <td class="muted">${r.buyDate}</td>
        <td class="muted">${r.confirmDate}/${r.interestDate}</td>
        <td>${fmtMoney(r.invest)}</td>
        <td class="muted">${Number.isFinite(r.costPrice) ? r.costPrice.toFixed(4) : "--"}</td>
        <td class="muted">${Number.isFinite(r.shares) ? r.shares.toFixed(4) : "--"}</td>
        <td class="muted">${navTxt}</td>
        <td class="muted">${mktTxt}</td>
        <td class="muted">${premTxt}</td>
        <td>${fmtMoney(r.value)}</td>
        <td class="${pCls}">${fmtMoney(r.profit)}</td>
        <td class="${rCls}">${fmtPct(r.roi)}</td>
        <td>
          <button class="danger" data-act="del" data-id="${r.id}">删</button>
        </td>`;
      tb.appendChild(tr);
    });
  }

  // ---------- refresh ----------
  let timer = null;

  async function refreshAll(){
    setStatus(true, `JS：刷新中… ${VERSION}`);
    log("refresh start", { version: VERSION, holdings: holdings.length });

    if (!holdings.length) {
      if ($("hint")) $("hint").textContent = "持仓数：0";
      renderMetrics(0, 0, 0);
      renderTable([]);
      setStatus(true, `JS：就绪（无持仓）${VERSION}`);
      return;
    }

    const rows = [];
    for (const h of holdings) {
      const r = await computeOne(h); // v6：不会 throw
      rows.push(r);
    }

    // 总览：只对“可计算的 value/profit”汇总（否则会误导）
    let sumInvest = 0, sumValue = 0, sumProfit = 0;
    rows.forEach((r) => {
      sumInvest += r.invest;
      if (Number.isFinite(r.value)) sumValue += r.value;
      if (Number.isFinite(r.profit)) sumProfit += r.profit;
    });

    renderMetrics(sumInvest, sumValue, sumProfit);
    renderTable(rows);
    if ($("hint")) $("hint").textContent = `持仓数：${rows.length}`;

    setStatus(true, `JS：就绪 ✅ ${VERSION}`);
    log("refresh done", { sumInvest, sumValue, sumProfit });
  }

  // ---------- events ----------
  function bindEvents(){
    const btnRefresh = $("btnRefresh");
    if (btnRefresh) btnRefresh.addEventListener("click", refreshAll);

    const auto = $("auto");
    if (auto) {
      auto.addEventListener("change", () => {
        const s = Number(auto.value);
        if (timer) clearInterval(timer);
        timer = null;
        if (s > 0) timer = setInterval(refreshAll, s * 1000);
        log("auto refresh", { seconds: s });
      });
    }

    const btnClear = $("btnClear");
    if (btnClear) btnClear.addEventListener("click", () => {
      if ($("inCode")) $("inCode").value = "";
      if ($("inAmount")) $("inAmount").value = "";
      if ($("inCostPrice")) $("inCostPrice").value = "";
      if ($("inType")) $("inType").value = "fund";
      if ($("inCostMode")) $("inCostMode").value = "auto";
      if ($("inBuyDate")) $("inBuyDate").value = todayStr();
    });

    const btnWipe = $("btnWipe");
    if (btnWipe) btnWipe.addEventListener("click", () => {
      if (!confirm("确定清空全部持仓？")) return;
      holdings = [];
      saveHoldings();
      refreshAll();
    });

    const btnAdd = $("btnAdd");
    if (btnAdd) btnAdd.addEventListener("click", async () => {
      const code = $("inCode")?.value?.trim() || "";
      let type = $("inType")?.value || "fund";
      const buyDate = $("inBuyDate")?.value || todayStr();
      const amount = Number($("inAmount")?.value);
      const costMode = $("inCostMode")?.value || "auto";
      const costPrice = ($("inCostPrice")?.value || "").trim();

      if (!/^[0-9]{6}$/.test(code)) { alert("代码请输入6位数字"); return; }
      if (!(amount > 0)) { alert("投入金额必须 > 0"); return; }

      // 16开头默认当 LOF（你最关心的 161226）
      if (type === "fund" && code.startsWith("16")) type = "lof";

      const h = { id: uid(), code, type, buyDate, amount, costMode, costPrice };
      holdings.push(h);
      saveHoldings();
      log("add", h);
      await refreshAll();
    });

    const tb = $("tb");
    if (tb) {
      tb.addEventListener("click", (ev) => {
        const btn = ev.target.closest("button");
        if (!btn) return;
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        if (act === "del") {
          if (!confirm("确定删除？")) return;
          holdings = holdings.filter(x => x.id !== id);
          saveHoldings();
          refreshAll();
        }
      });
    }
  }

  // ---------- boot ----------
  function boot(){
    holdings = loadHoldings();
    if ($("inBuyDate")) $("inBuyDate").value = todayStr();

    bindEvents();

    // 默认自动刷新 60s（如果你页面有这个下拉）
    if ($("auto")) {
      $("auto").value = "60";
      $("auto").dispatchEvent(new Event("change"));
    }

    setStatus(true, `JS：启动… ${VERSION}`);
    log("boot", { version: VERSION });

    refreshAll();
  }

  document.addEventListener("DOMContentLoaded", boot);

  // 一键自测（控制台跑 test161226()）
  window.test161226 = async () => {
    const q = await loadQuote("161226");
    alert(q ? `OK(${q.src})：${q.name}\n现价=${q.price}\n涨跌=${Number.isFinite(q.chgPct)?(q.chgPct*100).toFixed(2)+"%":"--"}\nsecid=${q.secid}` : "161226 仍取不到行情（看调试信息）");
  };
})();
