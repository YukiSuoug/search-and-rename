/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** @type {any} */
  let state = {
    mode: 'rename',
    busy: false,
    options: {
      find: '',
      replace: '',
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      preserveCase: false,
      preserveExtension: true,
      matchTarget: 'both',
    },
    config: { confirmThreshold: 15, canUndo: false },
    items: [],
    rows: [],
    collapsed: {},
    /** 换行模式：名字过长时折行显示（默认关，行高统一才好扫视） */
    wrap: false,
  };

  /** 恢复 Webview 被隐藏后要保留的 UI 状态 */
  const persisted = vscode.getState();
  if (persisted) {
    state = Object.assign(state, persisted);
  }

  const $ = (id) => document.getElementById(id);

  /* ----------------------------- tabs ----------------------------- */

  function setMode(mode) {
    state.mode = mode;
    $('tab-rename').setAttribute('aria-selected', String(mode === 'rename'));
    $('tab-content').setAttribute('aria-selected', String(mode === 'content'));
    $('pane-rename').hidden = mode !== 'rename';
    $('pane-content').hidden = mode !== 'content';
    persist();
  }

  $('tab-rename').addEventListener('click', () => setMode('rename'));
  $('tab-content').addEventListener('click', () => {
    setMode('content');
    vscode.postMessage({ type: 'switchMode', mode: 'content' });
  });

  $('btn-native').addEventListener('click', () => {
    vscode.postMessage({ type: 'openNativeSearch', find: $('find').value });
  });

  /* -------------------------- 输入焦点上报 -------------------------- */

  // webview 里的 DOM 焦点不会反映到 VSCode 的上下文键上，
  // 必须主动上报，否则 keybindings 里的 when 子句判断不了"用户正在打字"。
  //
  // 用事件委托挂在 document 上而不是逐个绑定：面板里的输入框是动态渲染的
  // （renderRows 会重建列表），逐个绑定会在重建后失效。
  function isTextInput(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  document.addEventListener(
    'focusin',
    (e) => {
      if (isTextInput(e.target)) {
        vscode.postMessage({ type: 'inputFocus', focused: true });
      }
    },
    true // capture：focusin 冒泡会被某些组件吞掉，用捕获更可靠
  );

  document.addEventListener(
    'focusout',
    (e) => {
      if (isTextInput(e.target)) {
        // focusout 在切换焦点时触发，先看新焦点落在哪：
        // 从 find 直接跳到 replace 不应该"闪一下"置为 false。
        const next = e.relatedTarget;
        if (!isTextInput(next)) {
          vscode.postMessage({ type: 'inputFocus', focused: false });
        }
      }
    },
    true
  );

  // 面板整体失焦（用户点到编辑器/其它视图）时兜底复位，
  // 否则可能出现"焦点仍在输入框"的残留状态导致快捷键永久失效。
  window.addEventListener('blur', () => {
    vscode.postMessage({ type: 'inputFocus', focused: false });
  });

  /* --------------------------- options ---------------------------- */

  function bindToggle(id, key) {
    const el = $(id);
    el.addEventListener('click', () => {
      state.options[key] = !state.options[key];
      syncToggles();
      persist();
      schedulePreview();
    });
  }

  bindToggle('opt-case', 'caseSensitive');
  bindToggle('opt-word', 'wholeWord');
  bindToggle('opt-regex', 'isRegex');
  bindToggle('opt-preserve', 'preserveCase');

  $('opt-target').addEventListener('change', () => {
    state.options.matchTarget = $('opt-target').value;
    persist();
    schedulePreview();
  });

  $('opt-ext').addEventListener('change', () => {
    state.options.preserveExtension = $('opt-ext').checked;
    persist();
    schedulePreview();
  });

  function syncToggles() {
    $('opt-case').classList.toggle('on', !!state.options.caseSensitive);
    $('opt-word').classList.toggle('on', !!state.options.wholeWord);
    $('opt-regex').classList.toggle('on', !!state.options.isRegex);
    $('opt-preserve').classList.toggle('on', !!state.options.preserveCase);
    $('opt-target').value = state.options.matchTarget;
    $('opt-ext').checked = !!state.options.preserveExtension;
    $('find').value = state.options.find;
    $('replace').value = state.options.replace;
  }

  /* --------------------------- inputs ----------------------------- */

  let debounceTimer = null;
  function schedulePreview() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (!state.options.find) {
      render({ items: [], total: 0, conflictCount: 0, truncated: false });
      return;
    }
    debounceTimer = setTimeout(() => {
      requestPreview();
    }, 300);
  }

  function requestPreview() {
    state.options.find = $('find').value;
    state.options.replace = $('replace').value;
    persist();
    setStatus('正在扫描…');
    vscode.postMessage({ type: 'preview', options: state.options });
  }

  $('find').addEventListener('input', schedulePreview);
  $('replace').addEventListener('input', schedulePreview);
  $('find').addEventListener('keydown', onEnterPreview);
  $('replace').addEventListener('keydown', onEnterPreview);

  function onEnterPreview(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      requestPreview();
    }
  }

  $('btn-preview').addEventListener('click', requestPreview);

  /* --------------------------- render ----------------------------- */

  function render(result) {
    state.items = result.items || [];
    state.rows = result.rows || [];
    persist();

    const list = $('list');
    list.textContent = '';

    const head = $('list-head');
    if (state.rows.length === 0) {
      head.hidden = true;
      $('empty').hidden = false;
      $('empty').textContent = state.options.find
        ? '没有匹配到可重命名的名称。'
        : '输入「查找名称」后点击预览。';
      updateButtons();
      return;
    }

    head.hidden = false;
    $('empty').hidden = true;
    // 只统计「自身会被改名的文件夹」；容器头只是目录分组，不算在内
    const renamedDirCount = state.rows.filter((r) => r.isGroup && !r.isContainer).length;
    const countText =
      `${state.items.length} 项` +
      (renamedDirCount > 0 ? ` · ${renamedDirCount} 个文件夹` : '') +
      (result.conflictCount > 0 ? ` · ${result.conflictCount} 项冲突` : '');
    $('count').textContent = countText;
    // 窄侧边栏下这段会被压缩截断（按钮优先），悬停给出完整文本
    $('count').title = countText;

    const frag = document.createDocumentFragment();
    for (const row of state.rows) {
      frag.appendChild(renderRow(row));
    }
    list.appendChild(frag);

    updateButtons();
    setStatus(
      result.truncated
        ? '⚠ 结果已达扫描上限，可能不完整。'
        : `${state.items.length} 项 · ${selectedCount()} 项已勾选`
    );
  }

  /** 折叠状态：key -> true 表示已折叠。默认全部展开 */
  function isCollapsed(key) {
    return !!(state.collapsed && state.collapsed[key]);
  }

  function setCollapsed(key, v) {
    if (!state.collapsed) state.collapsed = {};
    if (v) state.collapsed[key] = true;
    else delete state.collapsed[key];
    persist();
  }

  function renderRow(row) {
    const isContainer = !!row.isContainer;
    const blocking =
      row.conflict === 'targetExists' ||
      row.conflict === 'duplicateTarget' ||
      row.conflict === 'invalidName';

    const el = document.createElement('div');
    el.className =
      'row' +
      (row.isGroup ? ' group' : ' leaf') +
      (isContainer ? ' container' : '') +
      (row.conflict ? ' conflict' : '');
    el.dataset.key = row.key;
    el.dataset.depth = String(row.depth);
    // 每级缩进 8px（原 12px）。深层嵌套下这两级就省下 8px ≈ 1 个字符。
    el.style.paddingLeft = 2 + row.depth * 8 + 'px';
    // 整行 tooltip = 完整相对路径（行内为了紧凑只显示文件名）
    el.title = row.relPath || row.oldName || '';

    // 分组头：展开/折叠箭头
    if (row.isGroup) {
      if (row.hasChildren) {
        const caret = document.createElement('span');
        caret.className = 'caret';
        caret.textContent = isCollapsed(row.key) ? '▶' : '▼';
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          const nowCollapsed = !isCollapsed(row.key);
          setCollapsed(row.key, nowCollapsed);
          applyCollapse();
        });
        el.appendChild(caret);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'caret spacer';
        el.appendChild(spacer);
      }
    }

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !blocking;
    cb.dataset.key = row.key;
    if (row.isGroup) {
      cb.dataset.group = '1';
    }
    if (isContainer) {
      // ⚠️ 容器头只是「目录分组」，本身不是待重命名条目。
      // 打上标记，让 getSelectedKeys() / selectedCount() 把它排除掉，
      // 否则会把 `dir::xxx` 这种合成 key 当成真实路径传给执行层。
      cb.dataset.container = '1';
    }
    cb.addEventListener('change', () => {
      if (row.isGroup) {
        // 勾选分组头 → 联动整棵子树
        setSubtreeChecked(row.key, cb.checked);
      }
      onSelectChange();
    });
    el.appendChild(cb);

    // 叶子必然是文件 —— 📄 图标不承载任何信息，去掉，把宽度让给文件名。
    // 只在分组头（目录）上画一个细字形。
    if (row.isGroup) {
      const icon = document.createElement('span');
      icon.className = 'icon dir';
      icon.setAttribute('aria-hidden', 'true');
      el.appendChild(icon);
    }

    const body = document.createElement('div');
    body.className = 'body';

    // 分组头的相对路径行。
    // 改名头如果 label 和旧名相同就不重复画（下一行的 diff 里已经有名字了）。
    if (row.isGroup) {
      const showPath = isContainer || row.relPath !== row.oldName;
      if (showPath && row.relPath) {
        const path = document.createElement('div');
        path.className = 'path';
        path.textContent = row.relPath;
        body.appendChild(path);
      }
    }

    const names = document.createElement('div');
    names.className = 'names';

    if (isContainer) {
      // 容器头没有 old/new，只报数量。
      // 注：这里不能再画 ancestorDiff —— 上一版正是它把绝对路径刷满每一行。
      names.classList.add('count');
      names.textContent = `${row.containerCount || 0} 项`;
    } else {
      /*
       * 一行放不下时的取舍（方案 B）：**新名永不截断**。
       *
       * 旧名和新名里，只有「新名」是你真正要确认并提交的东西；旧名大部分可以
       * 从新名 + 高亮反推出来。所以让左侧整体可压缩（必要时缩成 `ot_body_029.…`），
       * 右侧新名用 `flex: 0 0 auto` 钉死不缩 —— 空间不够时**全部由左侧吸收**。
       * 结果：永远一行，且关键信息永远完整。
       */
      const oldSide = document.createElement('span');
      oldSide.className = 'name-old';

      // 单条目目录的前缀（省掉一行分组头）—— 属于"可牺牲"的一侧
      if (row.dirHint) {
        const hint = document.createElement('span');
        hint.className = 'dir-hint';
        hint.textContent = row.dirHint + '/';
        oldSide.appendChild(hint);
      }
      appendDiff(oldSide, row.oldDiff, 'del');
      names.appendChild(oldSide);

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      names.appendChild(arrow);

      const newSide = document.createElement('span');
      newSide.className = 'name-new';
      appendDiff(newSide, row.newDiff, 'ins');
      names.appendChild(newSide);
    }

    body.appendChild(names);

    // 冲突 / 分组统计
    if (row.isGroup && row.childConflictCount > 0) {
      const stat = document.createElement('div');
      stat.className = 'warn-msg';
      stat.textContent = `⚠ 子树内 ${row.childConflictCount} 项冲突`;
      body.appendChild(stat);
    } else if (row.conflictMessage) {
      const warn = document.createElement('div');
      warn.className = 'warn-msg';
      warn.textContent = '⚠ ' + row.conflictMessage;
      body.appendChild(warn);
    }

    el.appendChild(body);
    return el;
  }

  /** 根据折叠状态隐藏子孙行 */
  function applyCollapse() {
    const rows = Array.from($('list').querySelectorAll('.row'));
    // 每条分组头对应的「子树深度阈值」栈
    const hiddenUnder = []; // {depth, collapsed}

    for (const el of rows) {
      const depth = Number(el.dataset.depth);
      // 弹出已经结束的父级
      while (hiddenUnder.length > 0 && hiddenUnder[hiddenUnder.length - 1].depth >= depth) {
        hiddenUnder.pop();
      }
      const hidden = hiddenUnder.some((h) => h.collapsed);
      el.hidden = hidden;

      if (el.classList.contains('group')) {
        hiddenUnder.push({ depth, collapsed: isCollapsed(el.dataset.key) });
      }
    }
    // 勾选计数要把隐藏行也算进去（它们在语义上仍被选中）
    onSelectChange(true);
  }

  function appendDiff(parent, segs, cls) {
    if (!segs || segs.length === 0) {
      return;
    }
    for (const seg of segs) {
      const span = document.createElement('span');
      span.textContent = seg.text;
      if (seg.changed) {
        span.className = cls;
      }
      parent.appendChild(span);
    }
  }

  function selectedCount() {
    // 容器头（目录分组）不是可执行条目，不能计入选中数
    return document.querySelectorAll(
      '#list input[type=checkbox]:checked:not([data-container="1"])'
    ).length;
  }

  function getSelectedKeys() {
    const keys = [];
    document.querySelectorAll('#list input[type=checkbox]').forEach((cb) => {
      // ⚠️ 必须排除容器头：它的 key 是 `dir::<相对路径>` 合成值，不是真实 fsPath
      if (cb.checked && cb.dataset.container !== '1') {
        keys.push(cb.dataset.key);
      }
    });
    return keys;
  }

  /* --------------------------- head ------------------------------- */

  /** 勾选/取消一个分组头时，联动其整棵子树 */
  function setSubtreeChecked(groupKey, checked) {
    const all = Array.from($('list').querySelectorAll('.row'));
    const idx = all.findIndex((el) => el.dataset.key === groupKey);
    if (idx < 0) {
      return;
    }
    const baseDepth = Number(all[idx].dataset.depth);
    for (let i = idx + 1; i < all.length; i++) {
      const d = Number(all[i].dataset.depth);
      if (d <= baseDepth) {
        break; // 回到同级或更外层，子树结束
      }
      const cb = all[i].querySelector('input[type=checkbox]');
      if (cb && !cb.disabled) {
        cb.checked = checked;
      }
    }
  }

  /** 反向：子项全部勾选时，回填父分组的勾选态（含 indeterminate） */
  function syncGroupCheckboxes() {
    const all = Array.from($('list').querySelectorAll('.row'));
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      if (!el.classList.contains('group')) {
        continue;
      }
      const baseDepth = Number(el.dataset.depth);
      let total = 0;
      let checked = 0;
      for (let j = i + 1; j < all.length; j++) {
        const d = Number(all[j].dataset.depth);
        if (d <= baseDepth) {
          break;
        }
        const cb = all[j].querySelector('input[type=checkbox]');
        // 容器头自身不计入统计（它只是分组，真实条目在它的子孙里），
        // 否则父级状态会被"分组本身也是勾选的"带偏。
        if (cb && !cb.disabled && cb.dataset.container !== '1') {
          total++;
          if (cb.checked) checked++;
        }
      }
      const self = el.querySelector('input[type=checkbox]');
      if (!self || self.disabled) {
        continue;
      }
      self.checked = total > 0 && checked === total;
      self.indeterminate = checked > 0 && checked < total;
    }
  }

  $('check-all').addEventListener('change', () => {
    const on = $('check-all').checked;
    document.querySelectorAll('#list input[type=checkbox]').forEach((cb) => {
      cb.checked = on;
    });
    onSelectChange();
  });

  $('btn-expand').addEventListener('click', () => {
    state.collapsed = {};
    persist();
    document.querySelectorAll('#list .caret:not(.spacer)').forEach((c) => {
      c.textContent = '▼';
    });
    applyCollapse();
  });

  $('btn-collapse').addEventListener('click', () => {
    const collapsed = {};
    state.rows.forEach((r) => {
      if (r.isGroup && r.hasChildren) {
        collapsed[r.key] = true;
      }
    });
    state.collapsed = collapsed;
    persist();
    document.querySelectorAll('#list .caret:not(.spacer)').forEach((c) => {
      c.textContent = '▶';
    });
    applyCollapse();
  });

  function onSelectChange(silent) {
    syncGroupCheckboxes();
    const cbs = Array.from(document.querySelectorAll('#list input[type=checkbox]'));
    const all = cbs.length > 0 && cbs.every((c) => c.checked);
    $('check-all').checked = all;
    updateButtons();
    if (!silent) {
      setStatus(`${state.items.length} 项 · ${selectedCount()} 项已勾选`);
    }
  }

  /* --------------------------- actions ---------------------------- */

  function updateButtons() {
    const n = selectedCount();
    $('btn-execute').disabled = state.busy || n === 0;
    $('btn-execute').textContent = n > 0 ? `重命名所选 (${n})` : '全部重命名';
    $('btn-undo').disabled = state.busy || !state.config.canUndo;
  }

  $('btn-execute').addEventListener('click', () => {
    const keys = getSelectedKeys();
    if (keys.length === 0) {
      setStatus('未勾选任何项。');
      return;
    }
    vscode.postMessage({ type: 'execute', keys });
  });

  $('btn-undo').addEventListener('click', () => {
    vscode.postMessage({ type: 'undo' });
  });

  /* --------------------------- status ----------------------------- */

  function setStatus(text, isError) {
    const el = $('status');
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  function setBusy(busy, message) {
    state.busy = busy;
    document.getElementById('root').classList.toggle('busy', busy);
    if (busy && message) {
      setStatus(message);
    }
    updateButtons();
  }

  /* --------------------------- messages --------------------------- */

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'mode':
        setMode(msg.mode);
        break;
      case 'busy':
        setBusy(msg.busy, msg.message);
        break;
      case 'previewResult':
        render(msg.result);
        break;      case 'options':
        state.options = Object.assign(state.options, msg.options || {});
        state.config = msg.config || state.config;
        syncToggles();
        if (state.options.find) {
          schedulePreview();
        }
        updateButtons();
        break;
      case 'result': {
        const r = msg.result;
        if (r.failed && r.failed.length > 0) {
          setStatus(`完成 ${r.done} 项，失败 ${r.failed.length} 项。`);
        } else {
          setStatus(`已重命名 ${r.done} 项。`);
        }
        break;
      }
      case 'error':
        setStatus(msg.message, true);
        break;
    }
  });

  function persist() {
    vscode.setState({
      mode: state.mode,
      options: state.options,
      items: state.items,
      rows: state.rows,
      collapsed: state.collapsed,
      wrap: state.wrap,
      config: state.config,
    });
  }

  /* --------------------------- 换行开关 --------------------------- */

  /**
   * 换行模式：纯展示层开关，只切一个 class。
   *
   * 刻意不做成"永远换行"：默认紧凑能保持行高统一、便于快速扫视，
   * 而紧凑模式下**新名已经永远完整**（被省略的只有旧名，悬停有完整路径），
   * 所以换行只在"我要核对旧名"时才需要。
   * 想常开的人打开一次即可 —— 状态会被持久化，体验上等同于永远换行。
   */
  function applyWrap() {
    const on = !!state.wrap;
    $('list').classList.toggle('wrap', on);
    $('btn-wrap').classList.toggle('on', on);
    $('btn-wrap').setAttribute('aria-pressed', String(on));
  }

  $('btn-wrap').addEventListener('click', () => {
    state.wrap = !state.wrap;
    persist();
    applyWrap();
  });

  /* --------------------------- init ------------------------------- */

  syncToggles();
  setMode(state.mode || 'rename');
  applyWrap();
  updateButtons();
  if (state.rows && state.rows.length > 0) {
    render({
      items: state.items,
      rows: state.rows,
      total: state.items.length,
      conflictCount: 0,
      truncated: false,
    });
    applyCollapse();
  }
  vscode.postMessage({ type: 'ready' });

  // 从持久化状态恢复时，若已有查找串则自动重算一次
  if (state.options.find) {
    schedulePreview();
  }
})();
