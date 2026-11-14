// ==UserScript==
// @name         嘉立创购物车5品牌分组助手
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  按 5 个品牌一组选中购物车品牌（立创一单最多 5 张券），支持顺序/随机；配套 JLC_CART_TOOL_2.0（Vue 版 4.x）使用
// @author       haoduck
// @match        https://cart.szlcsc.com/cart/display.html*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=szlcsc.com
// @run-at       document-idle
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/haoduck/jlc_tool
// @supportURL   https://github.com/haoduck/jlc_tool/issues
// @updateURL    https://fastly.jsdelivr.net/gh/haoduck/jlc_tool@main/js/%E5%98%89%E7%AB%8B%E5%88%9B%E8%B4%AD%E7%89%A9%E8%BD%A65%E5%93%81%E7%89%8C%E5%88%86%E7%BB%84%E5%8A%A9%E6%89%8B.js
// @downloadURL  https://fastly.jsdelivr.net/gh/haoduck/jlc_tool@main/js/%E5%98%89%E7%AB%8B%E5%88%9B%E8%B4%AD%E7%89%A9%E8%BD%A65%E5%93%81%E7%89%8C%E5%88%86%E7%BB%84%E5%8A%A9%E6%89%8B.js
// ==/UserScript==
/*
 * 原理（不改原脚本一行代码）：
 *   原脚本品牌行的复选框绑定了 handleCheckboxClick(e, brandName)：
 *     - 普通点击   → 切换该品牌所有商品
 *     - Shift+点击 → 追加选中该品牌（只加不减）
 *     - Ctrl+点击  → 仅选中该品牌（清掉其它、只留这个）
 *
 * 速度：原脚本的选中请求本身有 200ms 防抖（sendPluginCheckedCk），
 *   所以快速连点不会发 5 次请求，而是合并成 1 次；之后再统一刷新。
 *   本脚本因此改成“连点 + 等一次刷新”，比“点一个等一个”快很多。
 *
 * 数据来源全部是 DOM：不读取、不修改原脚本内部状态，升级原脚本也不影响。
 */
(() => {
  'use strict';

  const ROW_SELECTOR = '.brand_row__';
  const MAX_BRANDS = 5;
  const CLICK_GAP = 50;      // 连点间隔，落在原脚本 200ms 防抖窗口内
  const POLL_INTERVAL = 90;  // 等待刷新时的轮询间隔

  const rows = () => Array.from(document.querySelectorAll(ROW_SELECTOR));
  const inputOf = (row) => row.querySelector('input[type=checkbox]');
  const isChecked = (row) => {
    if (!row) return false;
    if (row.querySelector('.ant-checkbox-checked')) return true;
    const input = inputOf(row);
    return input ? input.checked : false;
  };
  const nameOf = (row) => {
    const el = row && row.querySelector('[data-brand-name]');
    if (el) return el.getAttribute('data-brand-name') || '';
    return row ? (row.textContent || '').trim().slice(0, 24) : '';
  };
  const rowByName = (name) => rows().find((row) => nameOf(row) === name) || null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clickCheckbox(row, opts = {}, attempt = 0) {
    // 优先点 input：点 label 会触发浏览器默认行为再转发一次 click，
    // 部分实现下会让 onClick 跑两遍（选中→又取消）。
    // 第 2/3 次尝试换包装元素，兼容事件绑在 span/label 上的实现。
    const candidates = [
      inputOf(row),
      row.querySelector('.ant-checkbox-inner'),
      row.querySelector('.ant-checkbox-wrapper'),
      row,
    ].filter(Boolean);
    const target = candidates[Math.min(attempt, candidates.length - 1)];
    target.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
      shiftKey: !!opts.shift,
      ctrlKey: !!opts.ctrl,
      metaKey: !!opts.ctrl,
    }));
  }

  /** 等界面刷新到：恰好 checked 这 expect 个品牌、且名字都在 names 里 */
  async function waitSelection(names, expect, timeout) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const current = rows().filter(isChecked).map(nameOf);
      if (current.length === expect && names.every((name) => current.includes(name))) return true;
      await sleep(POLL_INTERVAL);
    }
    return false;
  }

  async function addBrandByName(name) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = rowByName(name);
      if (!row) return false;
      if (isChecked(row)) return true;
      clickCheckbox(row, { shift: true }, attempt);
      const fresh = rowByName(name) || row;
      const startedAt = Date.now();
      while (Date.now() - startedAt < (attempt === 0 ? 5000 : 3000)) {
        if (isChecked(fresh)) return true;
        await sleep(POLL_INTERVAL);
      }
    }
    return false;
  }

  /** 核心：让界面最终只剩 names 里这些品牌被选中 */
  async function applySelection(names, label) {
    const targetNames = names.filter((name) => rowByName(name));
    if (!targetNames.length) {
      return { ok: false, msg: '还没找到品牌列表，等购物车加载完再点' };
    }

    const anyChecked = rows().some(isChecked);

    // 1) 已有别的品牌被选中：先 Ctrl 点第一个目标品牌，只留它（清掉其它）
    if (anyChecked) {
      const first = rowByName(targetNames[0]);
      if (first) {
        clickCheckbox(first, { ctrl: true });
        await sleep(CLICK_GAP);
      }
    }

    // 2) 其余目标品牌 Shift 连点（只加不减），由原脚本 200ms 防抖合并成一次请求
    //    注意：Ctrl 点击后 DOM 要等刷新才会变，这里不能拿“当前是否选中”来跳过，
    //    否则会把刚被 Ctrl 清掉、但界面还显示选中的品牌漏掉。
    const rest = anyChecked ? targetNames.slice(1) : targetNames;
    for (const name of rest) {
      const row = rowByName(name);
      if (!row) continue;
      clickCheckbox(row, { shift: true });
      await sleep(CLICK_GAP);
    }

    // 3) 等刷新（正常 1~3 秒）
    let settled = await waitSelection(targetNames, targetNames.length, 9000);

    // 4) 没等到就补点（顺序模式，每次等确认）
    if (!settled) {
      for (const name of targetNames) {
        if (!isChecked(rowByName(name))) await addBrandByName(name);
      }
      settled = await waitSelection(targetNames, targetNames.length, 6000);
    }

    await sleep(140);
    const checkedNames = rows().filter(isChecked).map(nameOf);
    return {
      ok: true,
      settled,
      count: checkedNames.length,
      names: checkedNames,
      msg: checkedNames.length
        ? `${label}已选 ${checkedNames.length} 个品牌：${checkedNames.join('、')}`
        : `${label}没有选中任何品牌，请重试`,
    };
  }

  async function selectFive() {
    const all = rows();
    if (!all.length) return { ok: false, msg: '还没找到品牌列表，等购物车加载完再点' };
    const unchecked = all.filter((row) => !isChecked(row));
    if (!unchecked.length) return { ok: false, msg: '所有品牌都已选中，不需要再选' };
    const names = unchecked.slice(0, MAX_BRANDS).map(nameOf).filter(Boolean);
    return applySelection(names, '');
  }

  async function selectRandom() {
    const pool = rows().map(nameOf).filter(Boolean);
    if (!pool.length) return { ok: false, msg: '还没找到品牌列表，等购物车加载完再点' };
    if (pool.length <= MAX_BRANDS) return applySelection(pool, '随机');
    // Fisher-Yates 洗牌，避免 sort(random) 的分布偏差
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return applySelection(pool.slice(0, MAX_BRANDS), '随机');
  }

  /* ---------------- UI ---------------- */
  const host = document.createElement('div');
  host.id = 'lc5-host';
  (document.body || document.documentElement).appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border-radius: 10px;
        background: rgba(255, 255, 255, .96); border: 1px solid #e5e6eb;
        box-shadow: 0 6px 20px rgba(0, 0, 0, .16);
        font: 12px/1.4 -apple-system, "Segoe UI", "Microsoft Yahei", sans-serif;
        color: #1f2329;
      }
      button {
        border: 0; border-radius: 7px; padding: 7px 12px; cursor: pointer;
        color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap;
      }
      #go { background: #1677ff; }
      #rnd { background: #7a5af8; }
      #go:hover { background: #3b8cff; }
      #rnd:hover { background: #9179fa; }
      button:disabled { background: #b9c6dc; cursor: wait; }
      .meta { line-height: 1.35; white-space: nowrap; }
      .meta b { color: #1677ff; }
      .tip { display: block; color: #8a9099; font-size: 11px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
      .tip.err { color: #d54941; }
    </style>
    <div class="bar">
      <button id="go" type="button" title="按品牌列表顺序，选中未选中的前 5 个品牌；会替换当前选择">选 5 个品牌</button>
      <button id="rnd" type="button" title="随机挑 5 个品牌；会替换当前选择">随机 5 个</button>
      <div class="meta">
        已选 <b id="count">0</b> / ${MAX_BRANDS}
        <span class="tip" id="msg">每单最多 5 张券</span>
      </div>
    </div>`;

  const $ = (id) => shadow.getElementById(id);
  const DEFAULT_TIP = '每单最多 5 张券';
  let msgTimer = null;

  function showMsg(text, isError) {
    const msg = $('msg');
    msg.textContent = text;
    msg.classList.toggle('err', !!isError);
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      msg.textContent = DEFAULT_TIP;
      msg.classList.remove('err');
    }, 9000);
  }

  function refreshCount() {
    $('count').textContent = String(rows().filter(isChecked).length);
  }

  let busy = false;

  async function run(fn, label) {
    if (busy) return;
    busy = true;
    const go = $('go');
    const rnd = $('rnd');
    go.disabled = true;
    rnd.disabled = true;
    const startedAt = performance.now();
    try {
      const result = await fn();
      const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      showMsg(result.ok ? `${result.msg}（${seconds}s）` : result.msg, !result.ok);
      console.log('[5品牌]', label, result.msg);
    } catch (error) {
      showMsg(`选择失败：${error && error.message ? error.message : error}`, true);
      console.error('[5品牌]', error);
    } finally {
      busy = false;
      go.disabled = false;
      rnd.disabled = false;
      refreshCount();
    }
  }

  $('go').addEventListener('click', () => run(selectFive, '顺序'));
  $('rnd').addEventListener('click', () => run(selectRandom, '随机'));

  setInterval(refreshCount, 1500);
  refreshCount();

  // 供调试/二开使用
  window.__LC5__ = { selectFive, selectRandom, applySelection, rows, isChecked, nameOf, clickCheckbox };

  console.log('[5品牌] 已加载：右下角“选 5 个品牌 / 随机 5 个”');
})();