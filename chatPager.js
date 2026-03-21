(() => {
  if (window.chatPager && window.chatPager.destroy) {
    window.chatPager.destroy();
  }

  const MODE = {
    DISPLAY: 0,
    DETACH: 1,
    COMPRESS: 2,
    REFERRED_COMPRESS: 3,
  };

  const CONFIG = {
    pageSize: 10,
    autoToLastPage: true,
    scrollToTopOnPageChange: true,
    mode: MODE.COMPRESS,
    min_compress_length: 50,
    debug: true,
  };

  const MARK = {
    hidden: 'data-chatpager-hidden',
    originalDisplay: 'data-chatpager-original-display',
  };


  const MESSAGE_SELECTOR = 'article[data-turn], section[data-turn]';

  const STATE = {
    page: 0,
    totalPages: 1,
    observer: null,
    metaObserver: null,
    destroyed: false,
    rootUI: null,
    messages: [],
    container: null,
    scrollContainer: null,
  };


//#region 
  function ensureScanContainer() {
    if (STATE.container && STATE.container.isConnected) {
      return STATE.container;
    }

    const firstMessage = document.querySelector(MESSAGE_SELECTOR);
    STATE.container = firstMessage ? firstMessage.parentElement : null;
    return STATE.container;
  }

  function ensureScrollContainer() {
    if (STATE.scrollContainer && STATE.scrollContainer.isConnected) {
      return STATE.scrollContainer;
    }

    let cur = ensureScanContainer();
    while (cur) {
      const style = getComputedStyle(cur);
      const overflowY = style.overflowY;

      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        cur.scrollHeight > cur.clientHeight
      ) {
        STATE.scrollContainer = cur;
        return cur;
      }

      cur = cur.parentElement;
    }

    STATE.scrollContainer = document.scrollingElement || document.documentElement;
    return STATE.scrollContainer;
  }

  function ensureMessageRefStore(messageRoot) {
    if (!messageRoot.__chatpagerRefs) {
      messageRoot.__chatpagerRefs = [];
    }
    return messageRoot.__chatpagerRefs;
   }
//#endregion

//#region 
  function isMessage(node) {
    if (!(node instanceof Element)) return false;

    const tag = node.tagName;
    if (tag !== 'ARTICLE' && tag !== 'SECTION') return false;

    return node.hasAttribute('data-turn');
  }

  function findFirstMessage() {
    const container = ensureScanContainer();
    if (!container) return null;

    const first = container.firstElementChild;
    return isMessage(first) ? first : findNextMessage(first);
  }

  function findNextMessage(currentMessage) {
    if (!currentMessage) return null;

    let cur = currentMessage.nextElementSibling;
    while (cur) {
      if (isMessage(cur)) return cur;
      cur = cur.nextElementSibling;
    }
    return null;
  }

  function updateMessageList() {
    const initIndex = STATE.messages.length;
    let index = initIndex;

    let cur =
      index === 0
        ? findFirstMessage()
        : findNextMessage(STATE.messages[index - 1]);

    while (cur) {
      STATE.messages.push(cur);
      cur.__chatpagerIndex = index;
      index++;
      cur = findNextMessage(cur);
    }

    console.log('add: ' + (index - initIndex));
    return index - initIndex;
  }

  function resetMessageList() {
    STATE.messages.length = 0;
    return updateMessageList();
  }

  function getMinRemovedIndex(mutations) {
    let min = Infinity;

    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (!isMessage(node)) continue;

        const idx = node.__chatpagerIndex;
        if (Number.isFinite(idx) && idx < min) {
          min = idx;
        }
      }
    }

    return Number.isFinite(min) ? min : null;
  }
//#endregion

//#region
  function compressNodesIntoPlaceholder(startNode, endNode) {
    const parent = startNode.parentNode;
    const nextSibling = endNode.nextSibling;

    const range = document.createRange();
    range.setStartBefore(startNode);
    range.setEndAfter(endNode);

    const fragment = range.extractContents();
    const temp = document.createElement('div');
    temp.appendChild(fragment);
    const html = temp.innerHTML;

    if (html.length < CONFIG.min_compress_length) {
      parent.insertBefore(fragment, nextSibling);

      while (temp.firstChild) {
        parent.insertBefore(temp.firstChild, nextSibling);
      }

      return null;
    }

    const placeholder = document.createElement('span');
    placeholder.hidden = true;
    placeholder.__chatpagerCompressed = html;
    placeholder.setAttribute('data-chatpager-compressed', '1');

    parent.insertBefore(placeholder, nextSibling);
    return placeholder;
  }

  function restoreCompressedPlaceholder(placeholder) {
    const html = placeholder.__chatpagerCompressed;
    const parent = placeholder.parentNode;

    const range = document.createRange();
    range.setStartBefore(placeholder);

    const frag = range.createContextualFragment(html);

    parent.insertBefore(frag, placeholder);
    placeholder.remove();
  }

  function referNodeIntoPlaceholder(node, refStore) {
    const refId = refStore.length;

    refStore.push({
      node,
      restored: false,
    });

    const placeholder = document.createElement('span');
    placeholder.hidden = true;
    placeholder.setAttribute('data-chatpager-ref', String(refId));

    node.replaceWith(placeholder);
    return placeholder;
  }

  function restoreReferencePlaceholder(placeholder, refStore) {
    const refId = Number(placeholder.getAttribute('data-chatpager-ref'));
    const entry = refStore[refId];
    if (!entry || entry.restored || !entry.node) {
      placeholder.remove();
      return;
    }

    placeholder.replaceWith(entry.node);
    entry.restored = true;
  }

  function isHardNonCompressible(node) { 
    /* 主要是两种，一种是会被chatGPT修改的内容，一种是本身绑定了监听事件的内容*/
    if (!(node instanceof Element)) return false;

    return (
      node.tagName === 'BUTTON' ||
      node.hasAttribute('data-state') ||
      //node.getAttribute('data-turn') === "user" ||
      //node.getAttribute('aria-label') === 'Response actions' || //回复操作
      //node.getAttribute('aria-label') === 'Your message actions' || //你的消息操作
      node.firstElementChild?.tagName === 'BUTTON' ||
      node.classList.contains('hover:entity-accent') 
    );
  }

  function isHardCompressible(node) {
    if (!node.firstElementChild) return true;
    return node instanceof Element && node.id === 'code-block-viewer';
  }

  function isSoftCompressible(node) {
    if (node.firstElementChild?.hasAttribute('data-message-id')) return false;
    return true;
  }

  function isReferable(node) {
    if (CONFIG.mode !== MODE.REFERRED_COMPRESS) return false;
    return !node.__chatpagerRefs;
  }

  function tryCompress(node, refStore) {
    if (!(node instanceof Element)) return true;
  
    if (isHardNonCompressible(node)) {

      if (refStore && isReferable(node)) {
        referNodeIntoPlaceholder(node, refStore);
        return true;
      }

      return false;
    }

    if (isHardCompressible(node)) return true;

    let start = null;
    let end = null;
    let allTrue = true;

    for (let cur = node.firstChild; cur; ) {
      const next = cur.nextSibling;
      const ok = tryCompress(cur, refStore);

      if (ok) {
        if (start === null) start = cur;
        end = cur;
      } else {
        if (start !== null) {
          compressNodesIntoPlaceholder(start, end);
          start = null;
          end = null;
        }
        allTrue = false;
      }

      cur = next;
    }

    if (start !== null) {
      if (allTrue && isSoftCompressible(node)) {
        return true;
      }
      compressNodesIntoPlaceholder(start, end);
    }

    if (refStore && isReferable(node)) {
      referNodeIntoPlaceholder(node, refStore);
      return true;
    }

    return false;
  }

  function compressMessageContent(node, allowRef){
    const refStore = allowRef ? ensureMessageRefStore(node): null;
    const ret = tryCompress(node, refStore);

    if (ret && node.firstChild) {
      compressNodesIntoPlaceholder(
        node.firstChild,
        node.lastChild
      );
    }

    node.__chatpagerHasCompressed = true;
  }

  function decompressMessageContent(node) {
    if (node.__chatpagerRefs) {
      const refStore = node.__chatpagerRefs;
      let refUnsolved = node.__chatpagerRefs.length;

      while (refUnsolved > 0){
        const refList = node.querySelectorAll('[data-chatpager-ref]');
        refUnsolved -= refList.length;

        for (const placeholder of refList) {
          restoreReferencePlaceholder(placeholder, refStore);
        }

        const compressedList = node.querySelectorAll('[data-chatpager-compressed]');

        for (const placeholder of compressedList) {
          restoreCompressedPlaceholder(placeholder);
        }

      }

      delete node.__chatpagerHasCompressed;
      delete node.__chatpagerRefs;
      return;
    }

    if (node.__chatpagerHasCompressed) {
      const compressedList = node.querySelectorAll('[data-chatpager-compressed]');

      for (const placeholder of compressedList) {
        restoreCompressedPlaceholder(placeholder);
      }

      delete node.__chatpagerHasCompressed;
      return;
    }

    return;
  }

  function detachMessageContent(message) {
    if (!message || message.__chatpagerFragment) return false;
    if (!message.firstChild) return false;

    const range = document.createRange();
    range.selectNodeContents(message);
    message.__chatpagerFragment = range.extractContents();
    return true;
  }

  function attachMessageContent(message) {
    const frag = message && message.__chatpagerFragment;
    if (!frag) return false;

    message.appendChild(frag);
    delete message.__chatpagerFragment;
    return true;
  }

//#endregion

//#region

  function isMessageFinished(message){
    if (message.__chatpagerMessageFinished) {
      return true;
    }

    if (message.querySelector('[data-testid="copy-turn-action-button"]')){
      message.__chatpagerMessageFinished = true;
      return true;
    }

    return false;
  }

  function packMessageContent(message){
    if (message.getAttribute('data-turn') === 'assistant' && !isMessageFinished(message)) {
      return;
    }

    if (CONFIG.mode === MODE.DETACH){
      detachMessageContent(message);  
    }

    if (CONFIG.mode === MODE.COMPRESS || CONFIG.mode === MODE.REFERRED_COMPRESS){
      compressMessageContent(message, CONFIG.mode === MODE.REFERRED_COMPRESS);
      //detachMessageContent(message); 
    }
  }

  function unpackMessageContent(message){
    attachMessageContent(message);
    decompressMessageContent(message);
  }

  function hide(message) {
    if (!message || message.getAttribute(MARK.hidden) === '1') return;
    
    packMessageContent(message);

    message.setAttribute(MARK.hidden, '1');
    message.setAttribute(MARK.originalDisplay, message.style.display || '');
    message.style.display = 'none';
 }

  function show(message) {
    if (!message || message.getAttribute(MARK.hidden) !== '1') return;

    unpackMessageContent(message);

    message.style.display = message.getAttribute(MARK.originalDisplay) || '';
    message.removeAttribute(MARK.hidden);
    message.removeAttribute(MARK.originalDisplay);
  }

  function packRange(start, end){
    for (let i = Math.max(0, start); i < end && i < STATE.messages.length; i++) {
      if (STATE.messages[i].getAttribute(MARK.hidden) !=="1") continue;
      packMessageContent(STATE.messages[i]);
    }
  }

  function unpackRange(start, end){
    for (let i = Math.max(0, start); i < end && i < STATE.messages.length; i++) {
      unpackMessageContent(STATE.messages[i]);
    }
  }

  function showRange(start, end) {
    for (let i = Math.max(0, start); i < end && i < STATE.messages.length; i++) {
      show(STATE.messages[i]);
    }
  }

  function hideRange(start, end) {
    for (let i = Math.max(0, start); i < end && i < STATE.messages.length; i++) {
      hide(STATE.messages[i]);
    }
  }

//#endregion

//#region
function ensureToolbar() {
  let root = document.getElementById('chatpager-toolbar-root');
  if (root) {
    root.style.display = 'flex';
    updateToolbar();
    return root;
  }

  const MODE_LABELS = {
    [MODE.DISPLAY]: 'Display only',
    [MODE.DETACH]: 'Detach',
    [MODE.COMPRESS]: 'Compress',
    [MODE.REFERRED_COMPRESS]: 'Referred compress',
  };

  function button(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = onClick;
    b.className = 'chatpager-btn';
    return b;
  }

  function label(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.className = 'chatpager-label';
    return el;
  }

  function modeSelect(id, value) {
    const select = document.createElement('select');
    select.id = id;
    select.className = 'chatpager-select';

    Object.entries(MODE_LABELS).forEach(([modeValue, text]) => {
      const opt = document.createElement('option');
      opt.value = modeValue;
      opt.textContent = text;
      select.appendChild(opt);
    });

    select.value = String(value);
    return select;
  }

  if (!document.getElementById('chatpager-toolbar-style')) {
    const style = document.createElement('style');
    style.id = 'chatpager-toolbar-style';
    style.textContent = `
      #chatpager-toolbar-root {
        position: fixed;
        top: 50%;
        right: 40px;
        transform: translateY(-50%);
        z-index: 999999;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        font-family: ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
        color: rgb(13, 13, 13);
      }

      .chatpager-panel,
      .chatpager-toolbar {
        background: #ffffff;
        border: 1px solid rgba(13, 13, 13, 0.08);
        border-radius: 16px;
        box-shadow: 0 8px 24px rgba(13, 13, 13, 0.08);
        box-sizing: border-box;
      }

      .chatpager-toolbar {
        width: 124px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .chatpager-panel {
        width: 292px;
        padding: 16px 12px 12px 12px;
        display: none;
        flex-direction: column;
        gap: 10px;
      }

      .chatpager-drag-handle {
        height: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        user-select: none;
      }

      .chatpager-drag-handle:active {
        cursor: grabbing;
      }

      .chatpager-drag-bar {
        width: 80px;
        height: 3px;
        border-radius: 999px;
        background: rgba(13, 13, 13, 0.18);
        transition: all 120ms ease;
      }

      .chatpager-drag-handle:hover .chatpager-drag-bar {
        background: rgba(13, 13, 13, 0.28);
        width: 84px;
      }

      .chatpager-drag-handle:active .chatpager-drag-bar {
        background: rgba(13, 13, 13, 0.35);
        width: 86px;
      }

      .chatpager-btn,
      .chatpager-input,
      .chatpager-select,
      #chatpager-info {
        height: 36px;
        box-sizing: border-box;
        border-radius: 12px;
        font-size: 14px;
        line-height: 20px;
      }

      .chatpager-btn {
        width: 100%;
        border: 1px solid rgba(13, 13, 13, 0.06);
        background: rgba(13, 13, 13, 0.02);
        color: rgb(13, 13, 13);
        font-weight: 500;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }

      .chatpager-btn:hover {
        background: rgba(13, 13, 13, 0.05);
        border-color: rgba(13, 13, 13, 0.1);
      }

      .chatpager-input,
      .chatpager-select {
        width: 100%;
        padding: 0 10px;
        border: 1px solid rgba(13, 13, 13, 0.08);
        background: #ffffff;
        color: rgb(13, 13, 13);
        outline: none;
      }

      .chatpager-select {
        cursor: pointer;
      }

      #chatpager-info {
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(13, 13, 13, 0.025);
        border: 1px solid rgba(13, 13, 13, 0.06);
        color: rgb(13, 13, 13);
        font-weight: 600;
      }

      .chatpager-label {
        font-size: 12px;
        line-height: 16px;
        color: rgba(13, 13, 13, 0.62);
        font-weight: 600;
        white-space: nowrap;
      }

      .chatpager-section-title {
        font-size: 12px;
        line-height: 16px;
        color: rgba(13, 13, 13, 0.62);
        font-weight: 700;
      }

      .chatpager-divider {
        height: 1px;
        background: rgba(13, 13, 13, 0.08);
        margin: 4px 0;
      }

      .chatpager-row-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .chatpager-general-mode-row {
        display: grid;
        grid-template-columns: 78px 1fr;
        align-items: center;
        gap: 8px;
      }

      .chatpager-general-size-row {
        display: grid;
        grid-template-columns: 78px 1fr auto;
        align-items: center;
        gap: 8px;
      }

      .chatpager-range-row {
        display: grid;
        grid-template-columns: 1fr 14px 1fr auto;
        align-items: center;
        gap: 8px;
      }

      .chatpager-range-sep {
        text-align: center;
        color: rgba(13, 13, 13, 0.5);
        font-size: 14px;
        font-weight: 600;
        user-select: none;
      }
    `;
    document.head.appendChild(style);
  }

  root = document.createElement('div');
  root.id = 'chatpager-toolbar-root';

  const panel = document.createElement('div');
  panel.id = 'chatpager-settings-panel';
  panel.className = 'chatpager-panel';
  panel.style.display = 'none';

  const bar = document.createElement('div');
  bar.id = 'chatpager-toolbar';
  bar.className = 'chatpager-toolbar';

  const dragHandle = document.createElement('div');
  dragHandle.className = 'chatpager-drag-handle';
  dragHandle.innerHTML = '<div class="chatpager-drag-bar"></div>';

  const info = document.createElement('div');
  info.id = 'chatpager-info';

  const pageInput = document.createElement('input');
  pageInput.id = 'chatpager-input';
  pageInput.className = 'chatpager-input';
  pageInput.style.textAlign = 'center';
  pageInput.type = 'number';
  pageInput.min = '1';
  pageInput.placeholder = 'Page';
  pageInput.onchange = () => {
    const v = Number(pageInput.value);
    if (Number.isFinite(v)) window.chatPager.go(v);
  };

  const pageSizeInput = document.createElement('input');
  pageSizeInput.id = 'chatpager-setting-pagesize';
  pageSizeInput.className = 'chatpager-input';
  pageSizeInput.type = 'text';

  const modeChoice = modeSelect('chatpager-setting-mode', CONFIG.mode);
  const rangeMode = modeSelect('chatpager-range-mode', CONFIG.mode);

  const rangeFromInput = document.createElement('input');
  rangeFromInput.id = 'chatpager-range-from';
  rangeFromInput.className = 'chatpager-input';
  rangeFromInput.type = 'number';
  rangeFromInput.min = '1';
  rangeFromInput.placeholder = 'From';

  const rangeToInput = document.createElement('input');
  rangeToInput.id = 'chatpager-range-to';
  rangeToInput.className = 'chatpager-input';
  rangeToInput.type = 'number';
  rangeToInput.min = '1';
  rangeToInput.placeholder = 'To';

  function resetParam() {
    pageSizeInput.value = String(CONFIG.pageSize || 20);
    modeChoice.value = String(CONFIG.mode);
    rangeMode.value = String(CONFIG.mode);
    rangeFromInput.value = '1';
    rangeToInput.value = String(Math.max(1, STATE.totalPages - 1));
  }

  function togglePanel() {
    if (panel.style.display === 'none') {
      resetParam();
      panel.style.display = 'flex';
    } else {
      panel.style.display = 'none';
    }
  }

  function resetPagerByPanel() {
    const newMode = Number(modeChoice.value);
    const newPageSize = Number(pageSizeInput.value);

    if (!Number.isFinite(newPageSize) || newPageSize <= 0) return;

    CONFIG.mode = newMode;
    CONFIG.pageSize = newPageSize;
    tryResetPager();
  }

  function applyGeneral() {
    const newMode = Number(modeChoice.value);
    const newPageSize = Number(pageSizeInput.value);

    if (!Number.isFinite(newPageSize) || newPageSize <= 0) {
      resetParam();
      return;
    }

    if (newMode !== CONFIG.mode) {
      CONFIG.mode = newMode;
    }

    if (newPageSize !== CONFIG.pageSize) {
      const currentStart = (STATE.page - 1) * CONFIG.pageSize;
      const currentEnd = currentStart + CONFIG.pageSize;

      hideRange(currentStart, currentEnd);
      CONFIG.pageSize = newPageSize;
      recalcTotalPages();
      STATE.page = 0;
      changePage(STATE.totalPages);
      scrollToBottom();
    }
  }

  function rangeApply() {
    const from = Number(rangeFromInput.value);
    const to = Number(rangeToInput.value);

    if (!Number.isFinite(from) || from <= 0) {
      resetParam();
      return;
    }

    if (!Number.isFinite(to) || to > STATE.totalPages || to < from) {
      resetParam();
      return;
    }

    const currentMode = CONFIG.mode;
    CONFIG.mode = Number(rangeMode.value);
    unpackRange((from - 1) * CONFIG.pageSize, to * CONFIG.pageSize);
    packRange((from - 1) * CONFIG.pageSize, to * CONFIG.pageSize);
    CONFIG.mode = currentMode;
  }

  const settingsBtn = button('Settings', togglePanel);

  bar.append(
    dragHandle,
    button('First', () => window.chatPager.first()),
    button('Prev', () => window.chatPager.prev()),
    info,
    pageInput,
    button('Next', () => window.chatPager.next()),
    button('Last', () => window.chatPager.last()),
    settingsBtn
  );

  const topButtons = document.createElement('div');
  topButtons.className = 'chatpager-row-2';
  topButtons.append(
    button('Reset', resetPagerByPanel),
    button('Disable', tryDisablePager)
  );

  const divider1 = document.createElement('div');
  divider1.className = 'chatpager-divider';

  const generalTitle = document.createElement('div');
  generalTitle.textContent = 'General';
  generalTitle.className = 'chatpager-section-title';

  const generalModeRow = document.createElement('div');
  generalModeRow.className = 'chatpager-general-mode-row';
  generalModeRow.append(
    label('Hide mode'),
    modeChoice
  );

  const generalSizeRow = document.createElement('div');
  generalSizeRow.className = 'chatpager-general-size-row';

  const generalApplyBtn = button('Apply', applyGeneral);
  generalApplyBtn.style.width = 'auto';
  generalApplyBtn.style.padding = '0 12px';

  generalSizeRow.append(
    label('Page size'),
    pageSizeInput,
    generalApplyBtn
  );

  const divider2 = document.createElement('div');
  divider2.className = 'chatpager-divider';

  const rangeTitle = document.createElement('div');
  rangeTitle.textContent = 'Compress page range';
  rangeTitle.className = 'chatpager-section-title';

  const rangeRow = document.createElement('div');
  rangeRow.className = 'chatpager-range-row';

  const rangeSep = document.createElement('div');
  rangeSep.className = 'chatpager-range-sep';
  rangeSep.textContent = '-';

  const rangeApplyBtn = button('Apply', rangeApply);
  rangeApplyBtn.style.width = 'auto';
  rangeApplyBtn.style.padding = '0 12px';

  rangeRow.append(
    rangeFromInput,
    rangeSep,
    rangeToInput,
    rangeApplyBtn
  );

  panel.append(
    topButtons,
    divider1,
    generalTitle,
    generalModeRow,
    generalSizeRow,
    divider2,
    rangeTitle,
    rangeMode,
    rangeRow
  );

  root.append(panel, bar);
  document.body.appendChild(root);

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startRight = 40;
  let startTopPx = 0;

  function onMouseMove(e) {
    if (!dragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const newRight = startRight - dx;
    const newTop = startTopPx + dy;

    root.style.right = `${newRight}px`;
    root.style.top = `${newTop}px`;
    root.style.transform = 'none';
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  dragHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;

    const rect = root.getBoundingClientRect();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startRight = window.innerWidth - rect.right;
    startTopPx = rect.top;

    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    e.preventDefault();
    e.stopPropagation();
  });

  STATE.rootUI = root;
  updateToolbar();
  return root;
}

function hideToolBar() {
  const root = document.getElementById('chatpager-toolbar-root');
  if (root) {
    root.style.display = 'none';
  }
}

function updateToolbar() {
  const info = document.getElementById('chatpager-info');
  const input = document.getElementById('chatpager-input');

  if (info) {
    info.textContent = `${STATE.page}/${STATE.totalPages}`;
  }

  if (input) {
    input.max = String(STATE.totalPages);
    input.value = String(STATE.page);
  }
}
//#endregion


  function scrollToTop() {
    ensureScrollContainer().scrollTop = 0;
  }

  function scrollToBottom() {
    const scroller = ensureScrollContainer();
    scroller.scrollTop = scroller.scrollHeight;
  }


  function changePage(page) {
    if (page === STATE.page) {
      return;
    }
    
    const newStart = (page - 1) * CONFIG.pageSize;
    const newEnd = newStart + CONFIG.pageSize;

    if (newEnd < 1 || newStart >= STATE.messages.length) return;

    const currentStart = (STATE.page - 1) * CONFIG.pageSize;
    const currentEnd = currentStart + CONFIG.pageSize;

    STATE.page = page;
    hideRange(currentStart, currentEnd);
    showRange(newStart, newEnd);
    updateToolbar();
  }

  function recalcTotalPages() {
    STATE.totalPages = Math.max(1, Math.ceil(STATE.messages.length / CONFIG.pageSize));
  }

  function handleMutations(mutations) {
    try {
      if (!STATE.container || !STATE.container.isConnected) {
        return;
      }

      const minRemovedIndex = getMinRemovedIndex(mutations);

      if (minRemovedIndex !== null) {
        console.log('remove: ' + (STATE.messages.length - minRemovedIndex));
        STATE.messages.length = minRemovedIndex;
        const added = updateMessageList();
        hideRange(STATE.messages.length - added, (STATE.page - 1) * CONFIG.pageSize);
        hideRange(STATE.page * CONFIG.pageSize, STATE.messages.length);
        recalcTotalPages();
        updateToolbar();
        return;
      }

      const added = updateMessageList();

      if (added === 0) {
        return null;
      }

      if (STATE.messages.length > STATE.totalPages * CONFIG.pageSize) {
        recalcTotalPages();
        changePage(STATE.totalPages);
      }

      hideRange(STATE.messages.length - added, (STATE.page - 1) * CONFIG.pageSize);
      hideRange(STATE.page * CONFIG.pageSize, STATE.messages.length);

      return;
    } catch (e) {
      console.warn('[chatPager] mutation error → full rebuild', e);
      tryResetPager();
      return;
    }
  }

  function resetPager() {
    if (!ensureScanContainer()) {
      return;
    }

    showRange(0, STATE.messages.length);
    resetMessageList();
    hideRange(0, STATE.messages.length);
    recalcTotalPages();
    ensureToolbar();
    STATE.page = 0;
    changePage(STATE.totalPages);
    scrollToBottom();

    if (STATE.observer) {
      STATE.observer.disconnect();
      STATE.observer = null;
    }

    STATE.observer = new MutationObserver((mutations) => {
      handleMutations(mutations);
    });

    STATE.observer.observe(STATE.container, {
      childList: true,
      subtree: false,
    });

    if (STATE.metaObserver) {
      STATE.metaObserver.disconnect();
      STATE.metaObserver = null;
    }

    STATE.metaObserver = new MutationObserver(() => {
      if (!STATE.container || !STATE.container.isConnected){
        console.log('remove: ' + STATE.messages.length);
        tryResetPager();
      }
    });

    const main = document.getElementById('main');
    STATE.metaObserver.observe(main ? main : document.body, {
      childList: true,
      subtree: false,
    });
  }

  function waitResetPager(){
    if (STATE.metaObserver) {
      STATE.metaObserver.disconnect();
      STATE.metaObserver = null;
    }

    STATE.metaObserver = new MutationObserver(() => {
      if (ensureScanContainer()){
        resetPager();
      }
    });

    const main = document.getElementById('main');
    STATE.metaObserver.observe(main ? main : document.body, {
      childList: true,
      subtree: true,
    });
  }

  function tryResetPager() {
    hideToolBar();
    if (ensureScanContainer()){
      resetPager();
    } else {
      waitResetPager();
    }
  }

  function tryDisablePager() {
    STATE.destroyed = true;
    if (STATE.observer) STATE.observer.disconnect();
    if (STATE.metaObserver) STATE.metaObserver.disconnect();

    for (const message of STATE.messages) {
      show(message);
    }

    if (STATE.rootUI) STATE.rootUI.remove();
    delete window.chatPager;

    STATE.observer = null;
    STATE.metaObserver = null;
    STATE.container = null;
    STATE.scrollContainer = null;
  }

  tryResetPager();

  window.chatPager = {
    config: CONFIG,
    next() {
      if (STATE.page === STATE.totalPages) return;
      changePage(STATE.page + 1);
      scrollToTop();
    },
    prev() {
      if (STATE.page === 1) return;
      changePage(STATE.page - 1);
      scrollToBottom();
    },
    go(p) {
      p = Number(p);
      if (!Number.isFinite(p)) return;
      if (p < 1) p = 1;
      if (p > STATE.totalPages) p = STATE.totalPages;
      if (p === STATE.page) return;
      if (p > STATE.page) {
        changePage(p);
        scrollToTop();
        return;
      } else {
        changePage(p);
        scrollToBottom();
        return;
      }
    },
    first() {
      changePage(1);
      scrollToTop();
    },
    last() {
      changePage(STATE.totalPages);
      scrollToBottom();
    }, 
    state: STATE,
  };
})();



