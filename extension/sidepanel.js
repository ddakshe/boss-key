// 사이드패널: 지금 탭의 사이트를 켜고 끄고, 템플릿·숫자 위장·보여줄 것·휠 전환을 바꿔요.
// 설정은 chrome.storage에 저장하고, 각 탭의 content.js가 storage 변화를 보고 바로 따라가요.
// 공통 설정: mm_<키>,  이 사이트만의 설정: mmSite:<origin> = { 키: 값 }
const $ = (s) => document.querySelector(s);
const DEFAULTS = { template: 'sheet', strength: 'normal', wheel: true, related: 'show', ads: 'show', reviews: 'show', thumb: 45, zoom: 380, rowClick: 'preview', labels: 'disguise', quickKey: 'Backquote', escHide: true };
let current = { tabId: null, origin: null, supported: false, site: null };

const HINT = {
  weak: '가격·평점·리뷰 수·판매수를 그대로 보여줘요.',
  normal: '가격은 첨부 크기, 평점은 받은 시간처럼 바꿔요. 리뷰 수 💬, 판매수 👁. 마우스를 올리면 진짜 값이 보여요.',
  strong: '숫자 위장에 더해 썸네일도 📎 아이콘으로 숨겨요.',
};

// content.js와 같은 규칙: 도메인 단위 (www.coupang.com · mc.coupang.com → coupang.com)
const siteKeyOf = (hostname) => {
  const p = hostname.split('.');
  const two = /^(co|or|go|ne|ac|com|net|org)\.(kr|uk|jp|au|nz|br|in|cn|tw|hk|sg)$/.test(p.slice(-2).join('.'));
  return p.slice(two ? -3 : -2).join('.');
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function effective(all, site) {
  const g = {};
  for (const k of Object.keys(DEFAULTS)) g[k] = all['mm_' + k] ?? DEFAULTS[k];
  return { ...g, ...(site || {}) };
}

async function setOpt(k, v) {
  if (current.site && current.origin) {
    current.site = { ...current.site, [k]: v };
    await chrome.storage.local.set({ ['mmSite:' + current.origin]: current.site });
  } else {
    await chrome.storage.local.set({ ['mm_' + k]: v });
  }
}

async function refresh() {
  const tab = await activeTab();
  let origin = null;
  try { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol)) origin = siteKeyOf(u.hostname); } catch {}

  let status = null;
  if (origin && tab.id != null) {
    try { status = await chrome.tabs.sendMessage(tab.id, { type: 'mm-status' }); } catch {}
  }
  const all = await chrome.storage.local.get(null);
  const site = origin ? all['mmSite:' + origin] || null : null;
  current = { tabId: tab?.id ?? null, origin, supported: !!status, site };
  const armed = !!(origin && all['mmOn:' + origin]);

  $('#host').textContent = origin || '이 페이지';
  $('#armed').checked = armed;
  $('#armed').disabled = !current.supported;
  $('#unsupported').hidden = current.supported || !tab;
  $('#viewRow').hidden = !(armed && status);
  $('#overrideRow').hidden = !origin;
  $('#override').checked = !!site;
  $('#scope').textContent = site ? `${origin} 전용 설정` : '모든 사이트 공통 설정';
  $('#scope').classList.toggle('site', !!site);

  if (!current.supported) {
    $('#status').textContent = origin ? '페이지를 새로고침하면 쓸 수 있어요.' : '쓸 수 없는 페이지예요.';
  } else if (!armed) {
    $('#status').textContent = '꺼져 있어요.';
  } else {
    $('#status').textContent = status.showing
      ? (status.count ? `위장 중 · 항목 ${status.count}개` : '위장 중 · 상세 화면 또는 본문 모양')
      : '켜져 있어요 · 지금은 원래 화면';
  }
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', (b.dataset.view === 'disguise') === !!status?.showing));

  const cfg = effective(all, site);
  document.querySelectorAll('.tpl').forEach((b) => b.classList.toggle('on', b.dataset.tpl === cfg.template));
  document.querySelectorAll('.seg[data-key]').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === cfg[seg.dataset.key]));
  });
  $('#strengthHint').textContent = HINT[cfg.strength] || '';
  $('#wheel').checked = cfg.wheel !== false;
  $('#quickKey').checked = cfg.quickKey !== 'off';
  $('#escHide').checked = cfg.escHide !== false;
  for (const k of ['thumb', 'zoom']) {
    // 끌고 있는 중에는 값을 덮어쓰지 않아요.
    if (document.activeElement !== $('#' + k)) $('#' + k).value = cfg[k];
    $('#' + k + 'Out').textContent = $('#' + k).value + 'px';
  }

  const sites = Object.keys(all).filter((k) => k.startsWith('mmOn:') && all[k]).map((k) => k.slice(5));
  $('#siteCount').textContent = sites.length ? `${sites.length}` : '';
  $('#noSites').hidden = sites.length > 0;
  $('#sites').innerHTML = '';
  for (const s of sites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = s + (all['mmSite:' + s] ? ' · 전용 설정' : '');
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '이 사이트 끄기';
    del.addEventListener('click', async () => { await chrome.storage.local.set({ ['mmOn:' + s]: false }); });
    li.append(name, del);
    $('#sites').append(li);
  }

  const cmds = await chrome.commands.getAll();
  const c = cmds.find((x) => x.name === 'toggle-mailbox');
  $('#kbd').textContent = c?.shortcut || '설정 안 됨';
}

$('#armed').addEventListener('change', async (e) => {
  if (!current.origin) return;
  await chrome.storage.local.set({ ['mmOn:' + current.origin]: e.target.checked });
  setTimeout(refresh, 400);
});

$('#override').addEventListener('change', async (e) => {
  if (!current.origin) return;
  const key = 'mmSite:' + current.origin;
  if (e.target.checked) {
    // 지금 공통 설정을 복사해서 이 사이트 전용으로 시작해요.
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.set({ [key]: effective(all, null) });
  } else {
    await chrome.storage.local.remove(key);
  }
});

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', async () => {
  if (current.tabId == null) return;
  try { await chrome.tabs.sendMessage(current.tabId, { type: 'mm-view', disguise: b.dataset.view === 'disguise' }); } catch {}
  setTimeout(refresh, 300);
}));

document.querySelectorAll('.tpl').forEach((b) => b.addEventListener('click', () => setOpt('template', b.dataset.tpl)));
document.querySelectorAll('.seg[data-key] button').forEach((b) => b.addEventListener('click', () => setOpt(b.parentElement.dataset.key, b.dataset.v)));
$('#wheel').addEventListener('change', (e) => setOpt('wheel', e.target.checked));
$('#quickKey').addEventListener('change', (e) => setOpt('quickKey', e.target.checked ? 'Backquote' : 'off'));
$('#escHide').addEventListener('change', (e) => setOpt('escHide', e.target.checked));
// 슬라이더: 끄는 동안 바로바로 반영 (저장은 살짝 모아서)
for (const k of ['thumb', 'zoom']) {
  let t;
  $('#' + k).addEventListener('input', (e) => {
    $('#' + k + 'Out').textContent = e.target.value + 'px';
    clearTimeout(t);
    t = setTimeout(() => setOpt(k, +e.target.value), 60);
  });
}
$('#shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

chrome.storage.onChanged.addListener(() => refresh());
chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) refresh(); });
// 단축키로 화면을 바꿔도 패널 표시가 따라가게 가끔 다시 확인해요.
setInterval(refresh, 2000);
refresh();
