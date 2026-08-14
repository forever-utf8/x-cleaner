// ==UserScript==
// @name         X 批量屏蔽垃圾账号
// @namespace    https://github.com/forever-utf8/x-cleaner
// @version      1.7.0
// @description  在 X(Twitter) 页面按「用户名/handle 关键词」或「推文内容关键词」自动扫描并批量屏蔽引流/垃圾账号；点➕追加关键词后立即扫描屏蔽，屏蔽速度已提到最快。
// @author       Proma
// @license      MIT
// @homepageURL  https://github.com/forever-utf8/x-cleaner
// @supportURL   https://github.com/forever-utf8/x-cleaner/issues
// @updateURL    https://raw.githubusercontent.com/forever-utf8/x-cleaner/master/src/x-block-spam.user.js
// @downloadURL  https://raw.githubusercontent.com/forever-utf8/x-cleaner/master/src/x-block-spam.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================
   * ①  配置区（改这里即可）
   * ======================================================= */

  // 模式1：命中「显示名 或 @handle」中任一关键词即屏蔽
  const USERNAME_KEYWORDS = [
    '破处', '同城', '约炮', '约爱', '线下约见', '点头像约', '真实可靠',
    // 从面板永久词固化：身份/人设特征，做用户名/昵称才可疑（仅查名字，避免正文误伤）
    '体制内老师', '小护士', '少妇', '单男', '初男', '处男', '主人',
    '纯情', '大一', '反差', '风骚', '搭子',
  ];

  // 模式2：命中「推文正文」中任一关键词即屏蔽
  const CONTENT_KEYWORDS = [
    '同城', '约炮', '免费破处', '点头像约', '线下约见', '同城约爱', '同城会面',
    // 从面板永久词固化：正文招嫖/引流话术与动作词（仅查正文）
    '比她骚', '太涩了', '我福不黑', '比她sao', '比我骚', '比我Sao', '打✈️',
    '无偿约萢', '固萢', '约操', '线下', '破初', '催情', '找炮友', '无偿约',
    '需要哥哥', '固炮', '寻欢', '被人', '匹配', '野战', '约见', '过夜',
  ];

  const CONFIG = {
    // 每次屏蔽操作之间的随机延时区间（毫秒），防风控。屏蔽越慢越安全。
    // 追求「快到不可见」：默认几乎不等待；如需防风控可调大。
    DELAY_MIN_MS: 0,
    DELAY_MAX_MS: 0,

    // 单次运行最多屏蔽多少个用户，达到上限自动停止，保护账号。
    MAX_BLOCK_PER_RUN: 30,

    // 干跑模式：true 只在控制台/面板列出会被屏蔽的用户，不真正屏蔽（首次使用建议先开）。
    DRY_RUN: true,

    // 关键词匹配是否忽略大小写（对中文无影响，对英文关键词有效）。
    IGNORE_CASE: true,

    // 每一步点击后等待菜单/弹窗出现的最长等待（毫秒）。
    UI_WAIT_MS: 4000,

    // 自动运行：进入推文详情页（URL 含 /status/）自动扫描屏蔽，无需手点。
    AUTO_RUN: false,

    // 自动运行仅限推文详情页（true）；若为 false 则在任何页面都自动运行。
    AUTO_RUN_ONLY_STATUS: true,

    // 页面追加新内容/滚动后自动重扫的去抖延时（毫秒）。
    AUTO_RESCAN_DEBOUNCE_MS: 1200,
  };

  /* =========================================================
   * ②  内部状态
   * ======================================================= */
  const state = {
    running: false,
    stopRequested: false,
    blockedHandles: new Set(),   // 本次会话已屏蔽（去重）
    processedHandles: new Set(), // 本次运行已处理过的（去重，避免重复开菜单）
    blockedCount: 0,
    matchedCount: 0,
  };

  /* =========================================================
   * ③  工具函数
   * ======================================================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  const norm = (s) => (CONFIG.IGNORE_CASE ? String(s || '').toLowerCase() : String(s || ''));
  const normKw = (arr) => arr.map((k) => norm(k));

  function hitKeyword(text, keywords) {
    const t = norm(text);
    if (!t) return null;
    for (const k of keywords) {
      if (k && t.includes(k)) return k;
    }
    return null;
  }

  // 等待某个元素出现（在 root 内），超时返回 null
  async function waitFor(selector, root = document, timeout = CONFIG.UI_WAIT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(15);
    }
    return null;
  }

  // 读取元素可见文本，并把 X 渲染成图片的 emoji（<img alt="😊">）还原为字符
  function readTextWithEmoji(el) {
    if (!el) return '';
    let out = '';
    const walk = (node) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) {
          out += n.nodeValue;
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          // X 的 emoji 图片：<img alt="🌈"> 或带 emoji 类名
          if (n.tagName === 'IMG' && n.getAttribute('alt')) {
            out += n.getAttribute('alt');
          } else {
            walk(n);
          }
        }
      });
    };
    walk(el);
    return out;
  }

  // 从一个 tweet article 中提取 { handle, displayName, content }
  function extractTweetInfo(article) {
    let handle = '';
    let displayName = '';
    let content = '';

    const nameBlock = article.querySelector('[data-testid="User-Name"]');
    if (nameBlock) {
      const fullText = readTextWithEmoji(nameBlock);
      // 找 @handle
      const m = fullText.match(/@([A-Za-z0-9_]+)/);
      if (m) handle = m[0]; // 含 @
      // 显示名：@ 之前那段（保留 emoji，只折叠空白）
      displayName = fullText.split('@')[0].replace(/\s+/g, ' ').trim();
    }
    // 兜底：从链接里取 handle
    if (!handle) {
      const link = article.querySelector('a[href^="/"][role="link"]');
      if (link) {
        const href = link.getAttribute('href') || '';
        const mm = href.match(/^\/([A-Za-z0-9_]+)(\/|$)/);
        if (mm && !['home', 'explore', 'notifications', 'messages', 'i', 'search'].includes(mm[1])) {
          handle = '@' + mm[1];
        }
      }
    }

    const textEl = article.querySelector('[data-testid="tweetText"]');
    content = readTextWithEmoji(textEl);

    return { handle, displayName, content };
  }

  // 面板临时关键词（单个，本次扫描叠加到配置列表）
  const tempKw = { username: '', content: '' };

  // 永久关键词（用户手动追加，localStorage 落盘，合并存：对用户名和推文都生效）
  const LS_KEY = 'xBlockSpam.permKeywords';
  let permKeywords = [];
  function loadPermKeywords() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      permKeywords = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(permKeywords)) permKeywords = [];
    } catch (e) { permKeywords = []; }
  }
  function savePermKeywords() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(permKeywords)); } catch (e) {}
  }

  // 面板开关持久化（干跑/自动）：用户改过后写 localStorage，刷新/重开保持。
  // 本地未存过时才用代码里的 CONFIG 默认值。
  const LS_SETTINGS_KEY = 'xBlockSpam.settings';
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        if (typeof s.dryRun === 'boolean') CONFIG.DRY_RUN = s.dryRun;
        if (typeof s.autoRun === 'boolean') CONFIG.AUTO_RUN = s.autoRun;
      }
    } catch (e) {}
  }
  function saveSettings() {
    try {
      localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify({
        dryRun: CONFIG.DRY_RUN,
        autoRun: CONFIG.AUTO_RUN,
      }));
    } catch (e) {}
  }
  function addPermKeyword(kw) {
    const k = String(kw || '').trim();
    if (!k) return false;
    if (permKeywords.includes(k)) return false; // 去重
    permKeywords.push(k);
    savePermKeywords();
    return true;
  }
  function removePermKeyword(kw) {
    const i = permKeywords.indexOf(kw);
    if (i >= 0) { permKeywords.splice(i, 1); savePermKeywords(); }
  }

  // 判断该 tweet 是否命中规则，返回 { hit, reason }
  function matchTweet(info) {
    const unameKw = normKw(
      USERNAME_KEYWORDS
        .concat(tempKw.username ? [tempKw.username] : [])
        .concat(permKeywords)
    );
    const contentKw = normKw(
      CONTENT_KEYWORDS
        .concat(tempKw.content ? [tempKw.content] : [])
        .concat(permKeywords)
    );

    const nameHay = `${info.displayName} ${info.handle}`;
    const h1 = hitKeyword(nameHay, unameKw);
    if (h1) return { hit: true, reason: `用户名含「${h1}」` };

    const h2 = hitKeyword(info.content, contentKw);
    if (h2) return { hit: true, reason: `内容含「${h2}」` };

    return { hit: false, reason: '' };
  }

  // 对单个 article 执行「屏蔽」UI 流程，成功返回 true
  // 默认静默（不滚动）；仅当菜单未弹出（元素可能不在视口）时才回退到最小滚动重试。
  async function blockViaUI(article, allowScrollRetry = true) {
    // 1) 点 "..." 菜单
    const caret = article.querySelector('[data-testid="caret"]');
    if (!caret) return { ok: false, err: '未找到菜单按钮' };
    caret.click();

    // 2) 等菜单出现，找 "屏蔽" 项
    let blockItem = await waitFor('[data-testid="block"]', document, CONFIG.UI_WAIT_MS);
    if (!blockItem) {
      // 关掉可能打开的菜单
      document.body.click();
      // 回退：元素可能不在视口导致菜单未弹，最小滚动后重试一次
      if (allowScrollRetry) {
        try { article.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (e) {}
        await sleep(60);
        caret.click();
        blockItem = await waitFor('[data-testid="block"]', document, CONFIG.UI_WAIT_MS);
      }
      if (!blockItem) {
        document.body.click();
        return { ok: false, err: '菜单里没有屏蔽项(可能是自己/已屏蔽/结构变化)' };
      }
    }
    blockItem.click();

    // 3) 等确认弹窗
    const confirmBtn = await waitFor('[data-testid="confirmationSheetConfirm"]', document, CONFIG.UI_WAIT_MS);
    if (!confirmBtn) {
      return { ok: false, err: '未出现屏蔽确认弹窗' };
    }
    confirmBtn.click();
    return { ok: true };
  }

  /* =========================================================
   * ④  主流程：扫描当前可见推文并（可选）屏蔽
   * ======================================================= */
  async function run() {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    state.blockedCount = 0;
    state.matchedCount = 0;
    state.processedHandles = new Set();

    updatePanel();
    // 读取面板临时关键词（本次扫描生效）
    tempKw.username = unameInput ? unameInput.value.trim() : '';
    tempKw.content = contentInput ? contentInput.value.trim() : '';
    log(`开始扫描（DRY_RUN=${CONFIG.DRY_RUN}，上限 ${CONFIG.MAX_BLOCK_PER_RUN}）`);
    if (tempKw.username) log(`临时用户名关键词：「${tempKw.username}」`);
    if (tempKw.content) log(`临时内容关键词：「${tempKw.content}」`);

    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    log(`当前可见推文 ${articles.length} 条`);

    // ---- 阶段1：扫描并高亮所有命中的推文 ----
    const matched = []; // { article, info, reason }
    for (const article of articles) {
      const info = extractTweetInfo(article);
      if (!info.handle) continue;

      // 去重：本次运行 + 会话已屏蔽
      if (state.processedHandles.has(info.handle)) continue;
      if (state.blockedHandles.has(info.handle)) continue;

      const m = matchTweet(info);
      if (!m.hit) continue;

      state.processedHandles.add(info.handle);
      state.matchedCount++;
      highlight(article);
      matched.push({ article, info, reason: m.reason });
      log(`命中 ${info.handle}（${info.displayName || '无名'}）— ${m.reason}`);
    }
    updatePanel();
    log(`扫描完成，命中 ${matched.length} 个，已高亮`);

    if (CONFIG.DRY_RUN) {
      state.running = false;
      updatePanel();
      const dmsg = `扫描完成（干跑）：命中 ${state.matchedCount} 个用户，未执行屏蔽`;
      log(dmsg);
      toast(dmsg);
      return;
    }

    // ---- 阶段2：逐个屏蔽高亮的推文（尽快执行）----
    for (const { article, info } of matched) {
      if (state.stopRequested) { log('已手动停止'); break; }
      if (state.blockedCount >= CONFIG.MAX_BLOCK_PER_RUN) {
        log(`已达单次上限 ${CONFIG.MAX_BLOCK_PER_RUN}，停止`);
        break;
      }

      // 静默执行：不主动滚动，直接尝试屏蔽（菜单未弹时内部才会回退滚动）
      const res = await blockViaUI(article);
      if (res.ok) {
        state.blockedHandles.add(info.handle);
        state.blockedCount++;
        markBlocked(article);
        log(`✅ 已屏蔽 ${info.handle}`);
      } else {
        unhighlight(article);
        log(`⚠️ 跳过 ${info.handle}：${res.err}`);
      }
      updatePanel();

      // 随机延时防风控（为 0 时直接跳过，尽量快）
      const d = rand(CONFIG.DELAY_MIN_MS, CONFIG.DELAY_MAX_MS);
      if (d > 0) await sleep(d);
    }

    state.running = false;
    updatePanel();

    const msg = `本次已屏蔽 ${state.blockedCount} 个用户（命中 ${state.matchedCount}）`;
    log(msg);
    toast(msg);
  }

  /* =========================================================
   * ④.0  高亮辅助（命中黄框 / 已屏蔽置灰）
   * ======================================================= */
  function highlight(article) {
    article.style.outline = '2px solid #f7b500';
    article.style.outlineOffset = '-2px';
    article.style.background = 'rgba(247,181,0,.08)';
    article.style.transition = 'background .2s ease';
  }
  function unhighlight(article) {
    article.style.outline = '';
    article.style.background = '';
  }
  function markBlocked(article) {
    article.style.outline = '2px solid #d9363e';
    article.style.background = 'rgba(217,54,62,.10)';
    article.style.opacity = '.5';
  }

  /* =========================================================
   * ④.1  气泡通知（右下角，3 秒自动消失，无需确认）
   * ======================================================= */
  function toast(text, duration = 3000) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', right: '16px', bottom: '200px', zIndex: 1000000,
      maxWidth: '300px', background: '#1d9bf0', color: '#fff',
      padding: '10px 14px', borderRadius: '10px',
      font: '13px/1.5 system-ui, sans-serif', fontWeight: '700',
      boxShadow: '0 4px 16px rgba(0,0,0,.45)',
      opacity: '0', transform: 'translateY(8px)',
      transition: 'opacity .25s ease, transform .25s ease',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  /* =========================================================
   * ⑤  浮动控制面板 + 日志
   * ======================================================= */
  let panelEl, statEl, logEl, runBtn, unameInput, contentInput;

  function log(text) {
    // eslint-disable-next-line no-console
    console.log('[X-Block]', text);
    if (logEl) {
      const line = document.createElement('div');
      line.textContent = text;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
      while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
    }
  }

  function updatePanel() {
    if (statEl) {
      statEl.textContent = `状态:${state.running ? '运行中' : '空闲'} | 命中:${state.matchedCount} | 已屏蔽:${state.blockedCount}`;
    }
    if (runBtn) {
      runBtn.textContent = state.running ? '停止' : (CONFIG.DRY_RUN ? '扫描(干跑)' : '扫描并屏蔽');
      runBtn.style.background = state.running ? '#d9363e' : '#1d9bf0';
    }
  }

  function buildPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    Object.assign(panelEl.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 999999,
      width: '260px', background: '#15202b', color: '#e7e9ea',
      border: '1px solid #38444d', borderRadius: '12px', padding: '10px',
      font: '12px/1.5 system-ui, sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,.4)',
    });

    const title = document.createElement('div');
    title.textContent = 'X 批量屏蔽';
    Object.assign(title.style, { fontWeight: '700', marginBottom: '6px', fontSize: '13px' });

    statEl = document.createElement('div');
    Object.assign(statEl.style, { marginBottom: '8px', color: '#8b98a5' });

    // 临时关键词输入行（input + ➕永久按钮）
    const mkInputRow = (ph) => {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', gap: '6px', marginBottom: '6px' });
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = ph;
      Object.assign(inp.style, {
        flex: '1', minWidth: '0', boxSizing: 'border-box',
        background: '#0e1620', color: '#e7e9ea', border: '1px solid #38444d',
        borderRadius: '8px', padding: '6px 8px', font: '12px system-ui, sans-serif',
        outline: 'none',
      });
      // 回车直接触发扫描
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !state.running) run();
      });
      const addBtn = document.createElement('button');
      addBtn.textContent = '➕';
      addBtn.title = '把这个词追加到永久列表';
      Object.assign(addBtn.style, {
        border: '1px solid #38444d', color: '#e7e9ea', background: 'transparent',
        borderRadius: '8px', padding: '0 10px', cursor: 'pointer', fontSize: '13px',
      });
      addBtn.onclick = () => {
        const ok = addPermKeyword(inp.value);
        if (ok) {
          log(`➕ 已入永久列表：「${inp.value.trim()}」`);
          inp.value = '';
          renderPerm();
          // 追加后马上扫描 & 屏蔽一次
          if (!state.running) run();
        }
        else { log('未追加（空或已存在）'); }
      };
      row.appendChild(inp);
      row.appendChild(addBtn);
      return { row, inp };
    };
    const unameRow = mkInputRow('临时用户名关键词(可空)');
    const contentRow = mkInputRow('临时推文关键词(可空)');
    unameInput = unameRow.inp;
    contentInput = contentRow.inp;

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '6px', marginBottom: '8px' });

    runBtn = document.createElement('button');
    Object.assign(runBtn.style, {
      flex: '1', border: 'none', color: '#fff', background: '#1d9bf0',
      borderRadius: '999px', padding: '6px 0', cursor: 'pointer', fontWeight: '700',
    });
    runBtn.onclick = () => {
      if (state.running) { state.stopRequested = true; }
      else { run(); }
    };

    const dryBtn = document.createElement('button');
    Object.assign(dryBtn.style, {
      border: '1px solid #38444d', color: '#e7e9ea', background: 'transparent',
      borderRadius: '999px', padding: '6px 10px', cursor: 'pointer',
    });
    const syncDry = () => { dryBtn.textContent = CONFIG.DRY_RUN ? '干跑:开' : '干跑:关'; };
    dryBtn.onclick = () => { CONFIG.DRY_RUN = !CONFIG.DRY_RUN; saveSettings(); syncDry(); updatePanel(); };
    syncDry();

    const autoBtn = document.createElement('button');
    Object.assign(autoBtn.style, {
      border: '1px solid #38444d', color: '#e7e9ea', background: 'transparent',
      borderRadius: '999px', padding: '6px 10px', cursor: 'pointer',
    });
    const syncAuto = () => {
      autoBtn.textContent = CONFIG.AUTO_RUN ? '自动:开' : '自动:关';
      autoBtn.style.color = CONFIG.AUTO_RUN ? '#1d9bf0' : '#e7e9ea';
    };
    autoBtn.onclick = () => {
      CONFIG.AUTO_RUN = !CONFIG.AUTO_RUN;
      saveSettings();
      syncAuto();
      if (CONFIG.AUTO_RUN) { setupAuto(); maybeAutoRun('手动开启自动'); }
    };
    syncAuto();

    btnRow.appendChild(runBtn);
    btnRow.appendChild(dryBtn);
    btnRow.appendChild(autoBtn);

    logEl = document.createElement('div');
    Object.assign(logEl.style, {
      maxHeight: '160px', overflowY: 'auto', background: '#0e1620',
      borderRadius: '8px', padding: '6px', fontSize: '11px', color: '#aeb8c2',
      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    });

    // 永久词管理区
    const permWrap = document.createElement('div');
    Object.assign(permWrap.style, { margin: '8px 0' });
    const permHead = document.createElement('div');
    Object.assign(permHead.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#8b98a5', marginBottom: '4px', cursor: 'pointer' });
    const permTitle = document.createElement('span');
    const permToggle = document.createElement('span');
    permToggle.textContent = '▸';
    permHead.appendChild(permTitle);
    permHead.appendChild(permToggle);
    const permList = document.createElement('div');
    Object.assign(permList.style, {
      display: 'none', flexWrap: 'wrap', gap: '4px', maxHeight: '90px', overflowY: 'auto',
      background: '#0e1620', borderRadius: '8px', padding: '6px',
    });
    let permOpen = false;
    permHead.onclick = () => {
      permOpen = !permOpen;
      permList.style.display = permOpen ? 'flex' : 'none';
      permToggle.textContent = permOpen ? '▾' : '▸';
    };
    function renderPerm() {
      permTitle.textContent = `永久词 (${permKeywords.length})`;
      permList.innerHTML = '';
      if (permKeywords.length === 0) {
        const empty = document.createElement('span');
        empty.textContent = '无';
        empty.style.color = '#55606b';
        permList.appendChild(empty);
        return;
      }
      permKeywords.forEach((kw) => {
        const chip = document.createElement('span');
        Object.assign(chip.style, {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          background: '#1d2733', border: '1px solid #38444d', borderRadius: '999px',
          padding: '2px 6px 2px 8px', fontSize: '11px', color: '#e7e9ea',
        });
        const label = document.createElement('span');
        label.textContent = kw;
        const del = document.createElement('span');
        del.textContent = '✕';
        del.title = '删除';
        Object.assign(del.style, { cursor: 'pointer', color: '#8b98a5' });
        del.onclick = () => { removePermKeyword(kw); renderPerm(); log(`已删除永久词：「${kw}」`); };
        chip.appendChild(label);
        chip.appendChild(del);
        permList.appendChild(chip);
      });
    }
    renderPerm();
    permWrap.appendChild(permHead);
    permWrap.appendChild(permList);

    panelEl.appendChild(title);
    panelEl.appendChild(statEl);
    panelEl.appendChild(unameRow.row);
    panelEl.appendChild(contentRow.row);
    panelEl.appendChild(btnRow);
    panelEl.appendChild(permWrap);
    panelEl.appendChild(logEl);
    document.body.appendChild(panelEl);

    updatePanel();
    log('面板就绪。自动运行' + (CONFIG.AUTO_RUN ? '已开启' : '已关闭') + '。');
  }

  /* =========================================================
   * ⑤.2  自动运行：进入推文页自扫 + 滚动加载新内容自重扫
   * ======================================================= */
  let autoObserver = null;
  let rescanTimer = null;

  function isStatusPage() {
    return /\/status\/\d+/.test(location.pathname);
  }

  // 是否允许在当前页自动运行
  function autoAllowedHere() {
    if (!CONFIG.AUTO_RUN) return false;
    if (CONFIG.AUTO_RUN_ONLY_STATUS) return isStatusPage();
    return true;
  }

  // 去抖触发自动扫描
  function maybeAutoRun(reason) {
    if (!autoAllowedHere()) return;
    if (state.running) return; // 正在跑就不重入
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      if (!autoAllowedHere() || state.running) return;
      log(`自动运行（${reason || '触发'}）`);
      run();
    }, CONFIG.AUTO_RESCAN_DEBOUNCE_MS);
  }

  // 监听页面追加新推文 + URL 变化
  function setupAuto() {
    if (autoObserver) return; // 只装一次

    // 1) 监听新推文节点插入（滚动加载/展开）
    autoObserver = new MutationObserver((mutations) => {
      if (!autoAllowedHere() || state.running) return;
      let hasNewTweet = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (
            (node.matches && node.matches('article[data-testid="tweet"]')) ||
            (node.querySelector && node.querySelector('article[data-testid="tweet"]'))
          ) { hasNewTweet = true; break; }
        }
        if (hasNewTweet) break;
      }
      if (hasNewTweet) maybeAutoRun('新内容加载');
    });
    autoObserver.observe(document.body, { childList: true, subtree: true });

    // 2) 监听 SPA URL 变化（进入新推文页）
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        maybeAutoRun('进入新页面');
      }
    }, 800);
  }

  // 等页面基本就绪再挂面板
  const boot = setInterval(() => {
    if (document.body) {
      clearInterval(boot);
      loadPermKeywords();
      loadSettings();
      buildPanel();
      setupAuto();
      // 初次进入若已在推文页，自动跑一次
      maybeAutoRun('首次进入');
    }
  }, 500);
})();
