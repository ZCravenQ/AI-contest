import { CATEGORIES, BASIC_CATEGORIES, LIMITS, byteLength, measurePacket, createReceipt, readReceipt, receiptText } from './packet-v6.mjs';
import { createDefaultMessages, coverage, recommendSelection } from './minimal-v61.mjs';
import { paginateReceipt } from './receipt-layout.mjs';
import { createSceneMotion } from './scene-motion-v6.mjs';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'yuxun.last-packet.v4';
const labelFor = id => CATEGORIES.find(category => category.id === id)?.label || '未分类';
let draftInitialized = false;
let messages = [];
let nextId = 7;
let budget = 96;
let scene = 1;
let draftPage = 0;
let perPage = 4;
let editingId = null;
let receipt = null;
let receiptData = null;
let receiptPages = [];
let receiptPage = 0;
let receiptNeedsLayout = true;
let disconnected = false;
let restored = false;
let storageState = 'empty';
const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let reducedMotion = !!motionPreference?.matches;
const sceneMotion = createSceneMotion({ enabled: () => !reducedMotion });
let introAnimation = null;

function clearIntro() {
  const animation = introAnimation;
  introAnimation = null;
  try { animation?.cancel(); } catch { /* Keep the already-visible heading usable. */ }
}

function revealIntro() {
  const number = document.querySelector('.hero-number');
  if (reducedMotion || !number || typeof number.animate !== 'function') return;
  try {
    const animation = number.animate([
      { opacity: 0.15, clipPath: 'inset(0 100% 0 0)' },
      { opacity: 1, clipPath: 'inset(0)' },
    ], { duration: 560, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'none' });
    introAnimation = animation;
    Promise.resolve(animation.finished).then(() => {
      if (introAnimation === animation) clearIntro();
    }, () => {
      if (introAnimation === animation) clearIntro();
    });
  } catch { clearIntro(); }
}

function announce(text) { $('announcement').textContent = text; }
function selectedItems() { return messages.filter(message => message.selected); }
function sectionFor(index) { return $(`scene-${Math.min(index, 3)}`); }
function titleFor(index) { return $(`scene-title-${Math.min(index, 3)}`); }
function canVisit(index) {
  return index === 1 || (index === 2 && draftInitialized)
    || (index === 3 && !!receipt) || (index === 4 && !!receipt && disconnected);
}

function updateNavigation() {
  for (let index = 1; index < 5; index += 1) {
    const button = $(`nav-${index}`);
    button.disabled = !canVisit(index);
    if (index === scene) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  $('forget-open').disabled = !receipt;
  $('restore-open').hidden = !receipt;
  $('restore-open').textContent = restored ? '查看上次留下的便笺' : '查看已经抵达的便笺';
  const skip = document.querySelector('.skip');
  if (skip) skip.href = `#scene-title-${Math.min(scene, 3)}`;
}

function goTo(index, { focus = true, motion = true } = {}) {
  if (!canVisit(index)) return;
  clearIntro();
  const previous = scene;
  const outgoing = sectionFor(previous);
  const incoming = sectionFor(index);
  // Finish stale transitions before assigning final visibility or accessibility.
  sceneMotion.cancel();
  scene = index;
  document.body.dataset.scene = String(index);
  for (let item = 1; item < 4; item += 1) {
    const section = $(`scene-${item}`);
    const active = section === incoming;
    section.hidden = !active;
    section.inert = !active;
    section.setAttribute('aria-hidden', String(!active));
  }
  updateNavigation();
  if (scene === 2) renderDraft();
  if (scene >= 3) {
    updateReceiptState();
    if (receiptNeedsLayout) renderReceipt(true);
  }
  if (motion && previous !== index && outgoing !== incoming) {
    sceneMotion.transition({ outgoing, incoming, direction: index > previous ? 1 : -1, focal: index === 1 });
  }
  if (focus) titleFor(index).focus({ preventScroll: true });
}

function initializeDraft() {
  messages = createDefaultMessages();
  const recommended = new Set(recommendSelection(messages, budget));
  messages.forEach(message => { message.selected = recommended.has(message.id); });
  nextId = 7;
  draftInitialized = true;
  draftPage = 0;
  renderDraft();
}

function renderDraft(focusId = null) {
  const totalPages = Math.max(1, Math.ceil(messages.length / perPage));
  draftPage = Math.min(draftPage, totalPages - 1);
  const cards = messages.slice(draftPage * perPage, (draftPage + 1) * perPage).map(message => {
    const card = document.createElement('article');
    card.className = `message-card${message.selected ? ' selected' : ''}`;
    card.dataset.messageId = message.id;
    const select = document.createElement('button');
    select.type = 'button'; select.id = `select-${message.id}`; select.className = 'message-select';
    select.setAttribute('aria-pressed', String(message.selected));
    select.setAttribute('aria-label', `${message.selected ? '取消选择' : '选择'}${labelFor(message.category)}消息：${message.text}`);
    const top = document.createElement('span'); top.className = 'message-topline';
    const label = document.createElement('span'); label.textContent = labelFor(message.category);
    const check = document.createElement('span'); check.className = 'selection-box'; check.setAttribute('aria-hidden', 'true');
    top.append(label, check);
    const text = document.createElement('span'); text.className = 'message-text'; text.textContent = message.text;
    select.append(top, text);
    select.addEventListener('click', () => { message.selected = !message.selected; renderDraft(select.id); });
    const footer = document.createElement('div'); footer.className = 'message-card-footer';
    const size = document.createElement('span'); size.textContent = `${byteLength(message.text) + 3} B`;
    size.title = '正文 + 1 B 分类 + 2 B 长度；包头校验另计';
    const edit = document.createElement('button'); edit.type = 'button'; edit.id = `edit-${message.id}`;
    edit.className = 'edit-message'; edit.textContent = '全文 / 编辑';
    edit.setAttribute('aria-label', `查看全文或编辑${labelFor(message.category)}消息`);
    edit.addEventListener('click', () => openEditor(message.id));
    footer.append(size, edit); card.append(select, footer); return card;
  });
  $('message-list').replaceChildren(...cards);
  $('draft-page').textContent = `${draftPage + 1} / ${totalPages}`;
  $('draft-prev').disabled = draftPage === 0;
  $('draft-next').disabled = draftPage >= totalPages - 1;
  $('draft-pager').hidden = totalPages === 1;
  $('add-message').disabled = messages.length >= LIMITS.maxMessages;
  $('add-message').title = messages.length >= LIMITS.maxMessages ? '最多六条，可先编辑或删除一条' : '';
  updateCapacity();
  if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
}

function updateCapacity() {
  const chosen = selectedItems();
  const bytes = measurePacket(chosen);
  const over = bytes > budget;
  const aspects = coverage(chosen);
  $('budget').disabled = false;
  $('budget').value = String(budget);
  $('budget-value').textContent = String(budget);
  const shortView = window.innerWidth < 600 && (window.visualViewport?.height || window.innerHeight) < 620;
  $('selection-count').textContent = shortView ? `已选 ${chosen.length} 条 · 基本 ${aspects.count}/4` : `已选 ${chosen.length} / ${messages.length} 条`;
  $('capacity-status').textContent = chosen.length === 0 ? '先选一条，让这一包有话可说。'
    : over ? `${bytes} / ${budget} B · 超出 ${bytes - budget} B` : `${bytes} / ${budget} B · 余 ${budget - bytes} B`;
  $('capacity-fill').style.transform = `scaleX(${Math.min(bytes / budget, 1)})`;
  $('capacity-meter').setAttribute('aria-valuemax', String(budget));
  $('capacity-meter').setAttribute('aria-valuenow', String(Math.min(bytes, budget)));
  $('capacity-meter').setAttribute('aria-valuetext', over ? `已用 ${bytes} B，超出 ${bytes - budget} B，尚不能发送` : `已用 ${bytes} B，共 ${budget} B`);
  $('capacity-meter').parentElement.classList.toggle('over', over);
  $('coverage-summary').textContent = `基本方面 ${aspects.count} / ${aspects.total}${over ? ' · 超限未送出' : ''}`;
  $('coverage-list').replaceChildren(...BASIC_CATEGORIES.map(id => {
    const tag = document.createElement('span'); const covered = aspects.covered.includes(id);
    tag.className = `coverage-item${covered ? ' covered' : ''}`;
    tag.textContent = `${covered ? '✓' : '−'} ${labelFor(id)}`;
    tag.setAttribute('aria-label', `${labelFor(id)}：${covered ? '已选' : '未选'}`); return tag;
  }));
  $('send').disabled = !draftInitialized || chosen.length === 0 || over;
  $('send').firstElementChild.textContent = receipt ? '重新送出这一包' : '送出这一包';
  const missing = aspects.missing.map(labelFor).join('、');
  $('draft-note').textContent = over ? '取消一条、改短一点，或增加容量。'
    : missing ? `尚未选择：${missing}。是否需要，由你决定。`
      : receipt ? '改草稿不会改写已收到的便笺。' : '分类也计入容量，文字不自动删改。';
}

function validateEditor() {
  const text = $('message-text').value;
  const characters = Array.from(text).length;
  let error = '';
  if (!text.trim()) error = '先写下一句想送出的话。';
  else if (characters > 80) error = `多了 ${characters - 80} 个字符，请亲手精简。`;
  else if (text.split('\n').length > 3) error = '最多三行，让每个字都能清楚呈现。';
  else if (!CATEGORIES.some(category => category.id === $('message-category').value)) error = '请选择有效分类。';
  else { try { byteLength(text); } catch (problem) { error = problem.message; } }
  $('edit-counter').textContent = `${characters} / 80`;
  $('edit-error').textContent = error;
  $('edit-save').disabled = !!error;
  return !error;
}

function openEditor(id = null) {
  editingId = id;
  const message = messages.find(item => item.id === id);
  $('edit-title').textContent = message ? '让这句话更像你。' : '写一句自己的话。';
  $('message-text').value = message?.text || '';
  $('message-category').value = message?.category || 'other';
  $('delete-message').hidden = !message;
  validateEditor();
  $('edit-dialog').showModal();
  $('message-text').focus();
}

function saveEditor(event) {
  event.preventDefault();
  if (!validateEditor()) return;
  const text = $('message-text').value;
  const category = $('message-category').value;
  let message = messages.find(item => item.id === editingId);
  if (message) Object.assign(message, { text, category });
  else {
    if (messages.length >= LIMITS.maxMessages) return;
    message = { id: `m${nextId++}`, text, category, selected: true };
    messages.push(message);
  }
 
  draftPage = Math.floor(messages.indexOf(message) / perPage);
  $('edit-dialog').close();
  renderDraft(`edit-${message.id}`);
  announce('文字和分类已保存；已接收便笺保持不变。');
}

function makeReceivedItem(item) {
  const row = document.createElement('div'); row.className = 'received-item';
  row.dataset.messageIndex = String(item.index);
  const label = document.createElement('span'); label.className = 'received-number';
  label.textContent = `${labelFor(receiptData.items[item.index].category)}${item.continuation ? '·续' : ''}`;
  const text = document.createElement('p'); text.className = 'received-text'; text.textContent = item.text;
  row.append(label, text); return row;
}

function receiptAnchor() {
  const first = receiptPages[receiptPage]?.[0];
  if (!first) return null;
  const offset = receiptPages.slice(0, receiptPage).flat().filter(item => item.index === first.index)
    .reduce((sum, item) => sum + Array.from(item.text).length, 0);
  return { index: first.index, offset };
}

function layoutReceipt() {
  const anchor = receiptAnchor();
  const host = $('received-messages');
  const height = host.clientHeight;
  const measure = document.createElement('div'); measure.className = 'receipt-messages receipt-measure';
  measure.style.width = `${host.clientWidth || 300}px`;
  document.body.append(measure);
  const available = Math.max(36, height - (window.innerWidth <= 850 ? 24 : 28) - 8);
  const fits = items => {
    measure.replaceChildren(...items.map(makeReceivedItem));
    const actualHeight = measure.scrollHeight;
    // Deterministic fallback only for environments with no layout (not a browser viewport assertion).
    if (!height || !actualHeight) return items.reduce((sum, item) => sum + Math.ceil(Array.from(item.text).length / 18) + 1, 0) <= 10;
    return actualHeight <= available;
  };
  receiptPages = paginateReceipt(receiptData.items.map(item => item.text), fits);
  measure.remove();
  receiptPage = Math.min(receiptPage, receiptPages.length - 1);
  if (anchor) {
    let offset = 0;
    let found = false;
    receiptPages.forEach((page, index) => page.forEach(item => {
      if (item.index !== anchor.index || found) return;
      const end = offset + Array.from(item.text).length;
      if (anchor.offset >= offset && anchor.offset < end) { receiptPage = index; found = true; }
      offset = end;
    }));
  }
  receiptNeedsLayout = false;
}

function renderReceipt(relayout = false) {
  if (!receiptData) return;
  if (relayout) layoutReceipt();
  $('received-messages').replaceChildren(...(receiptPages[receiptPage] || []).map(makeReceivedItem));
  $('received-page').textContent = `${receiptPage + 1} / ${receiptPages.length}`;
  $('received-prev').disabled = receiptPage === 0;
  $('received-next').disabled = receiptPage >= receiptPages.length - 1;
  $('received-size').textContent = `${receiptData.items.length} 条 · ${receiptData.byteLength} B`;
  $('receipt-count').textContent = `${receiptData.byteLength} / ${receiptData.budget} B`;
}

function updateReceiptState() {
  const kept = scene === 4;
  $('scene-title-3').textContent = kept ? '连接停了，\n这些话还在。' : '这些话，\n抵达了。';
  $('receipt-summary').textContent = kept ? (restored ? '这是你上次留下的那一包。' : '还是同一包，一个字也没有少。')
    : `${receiptData.items.length} 条消息，${receiptData.byteLength} B。文字${receiptData.version === 6 ? '和分类' : ''}已完整还原。`;
  $('receipt-label').textContent = kept ? '留下的便笺' : '你的消息';
  $('connection-indicator').classList.toggle('off', disconnected);
  $('connection-indicator').setAttribute('aria-label', disconnected ? '本地模拟连接已结束' : '本地模拟连接');
  $('connection-label').textContent = disconnected ? '模拟连接已结束' : '本地模拟连接';
  $('receipt-hint').textContent = kept ? '保存为文字文件，离开此页也能阅读。' : '断开后，同一份文字仍留在这里。';
  $('disconnect').hidden = kept;
  $('disconnect').firstElementChild.textContent = disconnected ? '查看留下的消息' : '断开模拟连接';
  $('download').hidden = !kept;
  $('edit-draft').textContent = draftInitialized ? '返回整理' : '基于便笺编辑';
  $('receipt-storage').textContent = storageState === 'saved' ? '已保存在本机，刷新可恢复。'
    : '仅在当前页面保留。请保存便笺；刷新不会保留这次修改。';
}

function sendPacket() {
  try {
    const candidate = createReceipt(selectedItems(), budget);
    const decoded = readReceipt(candidate);
    receipt = candidate; receiptData = decoded;
    disconnected = false; restored = false;
    receiptPage = 0; receiptPages = []; receiptNeedsLayout = true;
    try {
      const serialized = JSON.stringify(candidate);
      localStorage.setItem(STORAGE_KEY, serialized);
      if (localStorage.getItem(STORAGE_KEY) !== serialized) throw new Error('Storage did not retain the record');
      storageState = 'saved';
    } catch { storageState = 'memory'; }
    updateCapacity();
    goTo(3);
    announce(`已抵达 ${decoded.items.length} 条完整分类消息。`);
  } catch (error) { $('draft-note').textContent = error.message; announce(error.message); }
}

function restoreReceipt() {
  try {
    const serialized = localStorage.getItem(STORAGE_KEY);
    if (!serialized) return;
    if (serialized.length > 24000) throw new Error('Saved record too long');
    const decoded = readReceipt(JSON.parse(serialized));
    receiptData = decoded;
    receipt = { version: decoded.version, packet: decoded.packet, budget: decoded.budget, createdAt: decoded.createdAt };
    disconnected = true; restored = true; storageState = 'saved';
    // The saved receipt is independent. The main flow starts with fixed example messages.
  } catch {
    storageState = 'memory';
    announce('未能恢复本机记录。旧记录未被当作有效接收内容，可以重新整理消息。');
  }
}

function downloadReceipt() {
  if (!receipt) return;
  try {
    const blob = new Blob([receiptText(receipt)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = '余讯-最后一包.txt';
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    announce('已发起便笺下载，分类和完整文字可独立阅读。');
  } catch {
    $('receipt-storage').textContent = '下载未完成，请选择并复制便笺中的完整文字。';
    announce('下载未完成，请复制便笺文字保存。');
  }
}

function updateLayout() {
  const height = window.visualViewport?.height || window.innerHeight;
  const width = window.innerWidth;
  document.documentElement.style.setProperty('--viewport-height', `${Math.floor(height)}px`);
  const focusId = document.activeElement?.id;
  const focusedMessage = /^(?:select|edit)-(m\d+)$/.exec(focusId || '');
  const focusedIndex = focusedMessage ? messages.findIndex(message => message.id === focusedMessage[1]) : -1;
  const firstIndex = focusedIndex >= 0 ? focusedIndex : draftPage * perPage;
  perPage = height < 620 ? 1 : (width > 850 && height >= 820 ? 4 : 2);
  draftPage = Math.floor(firstIndex / perPage);
  document.body.dataset.perPage = String(perPage);
  if (draftInitialized) renderDraft();
  if (receipt) {
    if (scene >= 3) renderReceipt(true);
    else receiptNeedsLayout = true;
  }
  if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
}

for (let index = 1; index < 5; index += 1) $(`nav-${index}`).addEventListener('click', () => goTo(index));
$('enter-minimal').addEventListener('click', () => { if (!draftInitialized) initializeDraft(); goTo(2); });
$('restore-open').addEventListener('click', () => goTo(disconnected ? 4 : 3));
$('budget').addEventListener('input', event => {
  const value = Number(event.target.value);
  if (Number.isInteger(value) && value >= LIMITS.minBudget && value <= LIMITS.maxBudget && (value - LIMITS.minBudget) % LIMITS.step === 0) budget = value;
  updateCapacity();
});
$('recommend').addEventListener('click', () => {
  const chosen = new Set(recommendSelection(messages, budget));
  messages.forEach(message => { message.selected = chosen.has(message.id); });

  renderDraft();
  announce(`已按分类覆盖、消息条数、字节数整理选择。${$('draft-note').textContent}`);
});
$('draft-prev').addEventListener('click', () => { draftPage = Math.max(0, draftPage - 1); renderDraft(); });
$('draft-next').addEventListener('click', () => { draftPage += 1; renderDraft(); });
$('add-message').addEventListener('click', () => { if (messages.length < LIMITS.maxMessages) openEditor(); });
$('edit-form').addEventListener('submit', saveEditor);
$('message-text').addEventListener('input', validateEditor);
$('message-category').addEventListener('change', validateEditor);
$('edit-close').addEventListener('click', () => $('edit-dialog').close());
$('delete-message').addEventListener('click', () => {
  messages = messages.filter(message => message.id !== editingId);
  $('edit-dialog').close(); renderDraft(); $('add-message').focus({ preventScroll: true });
  announce('草稿中的消息已删除；已接收便笺保持不变。');
});
$('send').addEventListener('click', sendPacket);
$('edit-draft').addEventListener('click', () => {
  if (!draftInitialized && receiptData) {
    messages = receiptData.items.map((item, index) => ({ ...item, id: `m${index + 1}`, selected: true }));
    budget = receiptData.budget; nextId = messages.length + 1;
    draftInitialized = true;
  }
  goTo(2);
});
$('disconnect').addEventListener('click', () => {
  if (!receipt) return;
  disconnected = true; goTo(4);
  announce('模拟连接已结束。同一份分类消息仍在原位。');
});
for (const [direction, step] of [['prev', -1], ['next', 1]]) {
  $(`received-${direction}`).addEventListener('click', () => {
    receiptPage = Math.max(0, Math.min(receiptPages.length - 1, receiptPage + step));
    renderReceipt(); announce(`消息第 ${receiptPage + 1} 页，共 ${receiptPages.length} 页。`);
  });
}
$('download').addEventListener('click', downloadReceipt);
for (const id of ['about-open', 'capacity-help']) $(id).addEventListener('click', () => $('about-dialog').showModal());
for (const id of ['about-close', 'about-done']) $(id).addEventListener('click', () => $('about-dialog').close());
$('forget-open').addEventListener('click', () => {
  $('about-dialog').close(); $('forget-error').textContent = ''; $('forget-dialog').showModal();
});
$('forget-cancel').addEventListener('click', () => { $('forget-dialog').close(); titleFor(scene).focus({ preventScroll: true }); });
$('forget-confirm').addEventListener('click', () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
    if (localStorage.getItem(STORAGE_KEY) !== null) throw new Error('Storage did not clear');
  } catch { $('forget-error').textContent = '无法清除本机存储。请在浏览器设置中清除本站记录。'; return; }
  receipt = null; receiptData = null; receiptPages = []; receiptPage = 0; receiptNeedsLayout = true;
  disconnected = false; restored = false; storageState = 'empty';
  $('received-messages').replaceChildren(); $('forget-dialog').close();
  renderDraft(); goTo(draftInitialized ? 2 : 1);
  announce('本机接收记录已清除，草稿仍保留。');
});
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
  if (['edit-dialog', 'about-dialog', 'forget-dialog'].some(id => $(id).open)) return;
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const next = event.key === 'ArrowLeft' ? scene - 1 : event.key === 'ArrowRight' ? scene + 1 : scene;
  if (next !== scene && canVisit(next)) { event.preventDefault(); goTo(next); }
});
motionPreference?.addEventListener?.('change', event => {
  reducedMotion = event.matches;
  if (reducedMotion) goTo(scene, { focus: false, motion: false });
});
let resizeScheduled = false;
function scheduleLayout() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  window.requestAnimationFrame(() => { resizeScheduled = false; updateLayout(); });
}
window.addEventListener('resize', scheduleLayout);
window.visualViewport?.addEventListener('resize', scheduleLayout);
document.fonts?.ready?.then(scheduleLayout);
restoreReceipt();
updateLayout();
goTo(1, { focus: false, motion: false });
revealIntro();

