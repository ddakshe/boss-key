/* 메일함 모드 (테스트) — 범용 버전
 * 1) extract: 처음 보는 사이트에서도 "같은 모양 카드가 반복되는 목록"을 찾아
 *    제목·가격·할인율·평점·리뷰 수·날짜·시간·이미지·링크를 읽어요.
 * 2) templates: 읽은 항목을 메일함 / 스프레드시트 / 결재함 모양으로 그려요.
 * 원래 페이지는 밑에 그대로 두고 위에 덮어요. 서버로 아무것도 보내지 않아요.
 */
(() => {
  // 다른 페이지 안의 작은 창(광고 등)에서는 아무것도 안 해요.
  // 예외: 우리가 미리보기용으로 뒤에서 연 상품 페이지(이름이 mm-pv:로 시작)에서는 읽기만 해서 돌려줘요.
  const IS_TOP = window.top === window;
  if (!IS_TOP && !/^mm-pv:/.test(window.name)) return;
  if (window.__mmLoaded) return;
  window.__mmLoaded = true;

  // ---------- 저장소 (확장프로그램이 아닐 때는 localStorage로 대신) ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(key, def) {
      if (hasChrome) {
        const o = await chrome.storage.local.get(key);
        return o[key] === undefined ? def : o[key];
      }
      try { const v = localStorage.getItem('__mm_' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
    },
    async set(key, val) {
      if (hasChrome) return chrome.storage.local.set({ [key]: val });
      try { localStorage.setItem('__mm_' + key, JSON.stringify(val)); } catch {}
    },
  };

  // 사이트 키: 도메인 단위로 묶어요 (www.coupang.com · mc.coupang.com → coupang.com)
  const siteKeyOf = (hostname) => {
    const p = hostname.split('.');
    const two = /^(co|or|go|ne|ac|com|net|org)\.(kr|uk|jp|au|nz|br|in|cn|tw|hk|sg)$/.test(p.slice(-2).join('.'));
    return p.slice(two ? -3 : -2).join('.');
  };
  const ORIGIN = siteKeyOf(location.hostname);
  let origTitle = document.title; // 우리가 탭 제목을 바꾸기 전 원래 제목
  const state = {
    on: false,
    template: 'sheet',  // mail | sheet | approval
    pv: null,           // 미리보기 팝업에 띄운 항목 id
    openRv: new Set(),  // 목록에서 리뷰를 펼친 항목 id
    strength: 'normal', // weak | normal | strong
    sort: 'default',    // default | price | rating | date
    wheel: true,        // 원래 화면에서 휠 → 위장 화면 (진짜 스크롤은 Shift+휠)
    folder: 'inbox',    // inbox | starred
    items: [],
    detail: null,
    starred: {},
    seen: {},
  };

  // ---------- 작은 도우미 ----------
  // 화면 낭독기용 숨은 이름표('브랜드명', '상품명' 등)가 앞에 붙는 사이트가 있어서 떼어내요.
  const SR_PREFIX = /^(브랜드명|상품명|판매자명?|판매가|할인가|정상가|할인율|가격|평점|리뷰수|구매수)\s*[:：]?\s*/;
  const SR_SUFFIX = /\s*(새\s*창\s*또는\s*새\s*탭에서\s*열림|새\s*창\s*열림|Opens in a new (window|tab)( or tab)?|\(new window\))\s*$/i;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').replace(/\s*(Image|사진|이미지)\s*\d+\s*(of|\/)\s*\d+/gi, '').trim().replace(SR_PREFIX, '').replace(SR_SUFFIX, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (s) => { const n = parseFloat(String(s).replace(/,/g, '')); return isNaN(n) ? null : n; };
  let curNow = '원';
  const won = (n, cur = curNow) => n == null ? '' : (cur === '원' ? n.toLocaleString('ko-KR') + '원' : cur + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }));
  const count = (n, plus) => {
    if (n == null) return '';
    const s = n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '만' : n.toLocaleString('ko-KR');
    return s + (plus ? '+' : '');
  };
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

  // 읽기 대상 문서: 평소엔 이 페이지, 미리보기 때는 뒤에서 불러온 상품 페이지
  let DOC = document;
  const withDoc = (d, fn) => { const prev = DOC; DOC = d; try { return fn(); } finally { DOC = prev; } };

  // ---------- 1. 반복 카드 목록 찾기 ----------
  function sigOf(el) {
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/)[0] || '';
    // CSS 모듈의 해시 꼬리(__Qd6sv 등)와 숫자를 지워서 같은 종류끼리 묶어요.
    return el.tagName + '.' + cls.replace(/__[A-Za-z0-9_-]+$/, '').replace(/\d+/g, '');
  }

  // 가격: 1,234원 / ₩1,234 / $12.99 / US $12.99 / €9,99 / £5.00
  const PRICE_RE = /(?:₩\s*)?(\d{1,3}(?:,\d{3})+|\d{4,})\s*원|₩\s*(\d{1,3}(?:,\d{3})+|\d{4,})|(US\s*\$|C\$|A\$|AU\$|NZ\$|HK\$|S\$|KRW|USD|EUR|GBP|JPY|CNY|RMB|[$€£¥])\s?(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/;
  const PRICE_G = new RegExp(PRICE_RE.source, 'g');
  const CUR = { KRW: '원', USD: '$', 'US$': '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', RMB: '¥' };
  const priceOf = (m) => {
    if (m[1] || m[2]) return { v: num(m[1] || m[2]), cur: '원' };
    const code = m[3].replace(/\s+/g, '');
    const cur = CUR[code] || (/\$$/.test(code) ? '$' : code);
    let t = m[4];
    if (cur === '€' && /,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); // 9.999,99 €
    let v = num(t);
    if (cur === '원' && v != null) v = Math.round(v);
    return { v, cur };
  };

  function looksLikeCard(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) return false;
    const hasLink = el.tagName === 'A' || el.querySelector('a[href]') || (el.querySelector('img') && el.querySelector('button,[role="button"]'));
    const t = el.innerText || '';
    return hasLink && t.length > 4 && t.length < 1500;
  }

  function findCards() {
    let best = null;
    const found = [];
    const all = DOC.body.querySelectorAll('*');
    for (const el of all) {
      if (el.id === 'mm-host') continue;
      const kids = el.children;
      if (kids.length < 3) continue;
      const groups = new Map();
      for (const k of kids) {
        const s = sigOf(k);
        if (!groups.has(s)) groups.set(s, []);
        groups.get(s).push(k);
      }
      for (const members of groups.values()) {
        if (members.length < 3) continue;
        const cards = members.filter(looksLikeCard);
        if (cards.length < 3) continue;
        let withImg = 0, withNum = 0, area = 0, multi = 0;
        for (const c of cards) {
          // 카드 하나에 가격이 여러 개면 상품 여러 개를 묶은 '줄'이에요 (무신사처럼 줄 단위로 그리는 격자)
          if ((c.innerText.match(PRICE_G) || []).length >= 3) multi++;
          if (c.querySelector('img') || /background-image/.test(c.innerHTML.slice(0, 3000))) withImg++;
          const t = c.innerText;
          if (PRICE_RE.test(t) || /\d\.\d|\d+%|\d{1,2}:\d{2}/.test(t)) withNum++;
          const r = c.getBoundingClientRect();
          area += Math.min(r.width * r.height, 400000);
        }
        // 이미지와 숫자(가격·평점·시간)가 있는 카드가 많을수록 점수가 높아요. 메뉴 목록은 여기서 걸러져요.
        const score = cards.length * (area / cards.length) * (0.2 + withImg / cards.length) * (0.1 + withNum / cards.length) * (multi > cards.length / 2 ? 0.05 : 1);
        found.push({ score, cards, numRatio: withNum / cards.length });
      }
    }
    // 홈 화면처럼 묶음이 여러 개면, 충분히 큰 묶음을 위에서부터 합쳐요.
    // 다른 묶음의 카드 안에 들어 있거나 감싸는 묶음은 건너뛰어요 (중복 방지).
    found.sort((a, b) => b.score - a.score);
    best = found[0];
    if (!best || best.score <= 50000) return [];
    const chosen = [];
    for (const g of found.slice(0, 40)) {
      if (chosen.length >= 40) break;
      if (g !== best && (g.score < best.score * 0.08 || g.numRatio < 0.5)) continue;
      const overlap = chosen.some((c) => c.cards.some((x) => g.cards.some((y) => x.contains(y) || y.contains(x))));
      if (!overlap) chosen.push(g);
    }
    // 화면 위에서 아래 순서로 정렬
    return chosen.flatMap((g) => g.cards).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  // ---------- 2. 카드 하나에서 값 읽기 ----------
  function isStrike(el) {
    if (el.closest('del,s,strike')) return true;
    const d = getComputedStyle(el).textDecorationLine || '';
    return d.includes('line-through');
  }

  function pickImage(root) {
    let best = null, bestArea = 0;
    for (const img of root.querySelectorAll('img')) {
      const r = img.getBoundingClientRect();
      const a = r.width * r.height;
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
      if (!src || src.startsWith('data:image/gif')) continue;
      if (a > bestArea) { bestArea = a; best = src; }
    }
    if (!best) {
      const bg = [...root.querySelectorAll('*')].slice(0, 80).map((e) => getComputedStyle(e).backgroundImage).find((b) => b && b.startsWith('url('));
      if (bg) best = bg.slice(4, -1).replace(/["']/g, '');
    }
    return best;
  }

  function pickLink(card) {
    const a = card.tagName === 'A' ? card : (card.closest('a[href]') || card.querySelector('a[href]'));
    if (!a) return null;
    const h = a.getAttribute('href') || '';
    if (!h || h.startsWith('javascript') || h === '#') return null;
    try { return new URL(h, location.href).href; } catch { return null; }
  }

  function parseDate(text) {
    const now = new Date();
    const mk = (m, d) => { const x = new Date(now.getFullYear(), m - 1, d); if (x < now - 1000 * 3600 * 24 * 60) x.setFullYear(x.getFullYear() + 1); return x; };
    let m;
    const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    if ((m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i))) return mk(MON[m[1].slice(0, 3).toLowerCase()], +m[2]);
    if ((m = text.match(/\b(today|tomorrow)\b/i))) { const x = new Date(now); x.setDate(x.getDate() + (/tomorrow/i.test(m[1]) ? 1 : 0)); return x; }
    if ((m = text.match(/(오늘|내일|모레)(?!의|\s*의|드림|출발|ON|특가|만|의\s*집)/))) { const x = new Date(now); x.setDate(x.getDate() + { 오늘: 0, 내일: 1, 모레: 2 }[m[1]]); return x; }
    if ((m = text.match(/(20\d{2})[.\-/]\s?(\d{1,2})[.\-/]\s?(\d{1,2})/))) return new Date(+m[1], +m[2] - 1, +m[3]);
    if ((m = text.match(/(?:^|[^\d])(\d{2})\.(\d{1,2})\.(\d{1,2})(?!\d)/))) return new Date(2000 + +m[1], +m[2] - 1, +m[3]); // 26.12.03
    if ((m = text.match(/(\d{1,2})월\s*(\d{1,2})일/))) return mk(+m[1], +m[2]);
    if ((m = text.match(/(?:^|[^\d.,])(\d{1,2})[./](\d{1,2})\s*\(?[월화수목금토일]/))) return mk(+m[1], +m[2]);
    return null;
  }

  // 별점을 숫자 말고 다른 방법으로 그리는 사이트들 (리뷰 하나하나의 별점이 주로 이래요)
  function starRating(root) {
    const all = [root, ...root.querySelectorAll('*')].slice(0, 400);
    const starish = (e) => /star|rating|rate|score|grade|별/i.test(String(e.className?.baseVal ?? e.className ?? '') + ' ' + (e.id || ''));
    let m;
    // 1) data-rating="5", data-score="4.5" 같은 속성
    for (const e of all) {
      for (const a of ['data-rating', 'data-score', 'data-rate', 'data-star', 'data-stars', 'data-value', 'data-grade', 'rating', 'score']) {
        const v = e.getAttribute?.(a);
        if (v != null && /^\d(\.\d+)?$/.test(v.trim()) && (!/^(data-value|rating|score)$/.test(a) || starish(e) || /star|rating|review/i.test(e.tagName))) return +v;
      }
    }
    // 2) 화면 낭독용 글: '별 5개 중 4개', '5점 만점에 4점', '4 out of 5', '별점 4점', '4 stars', 'Rated 4'
    const said = all.map((e) => [e.getAttribute?.('aria-label'), e.getAttribute?.('title'), e.getAttribute?.('alt'), e.children?.length ? '' : e.textContent].filter(Boolean).join(' ')).join(' | ');
    if ((m = said.match(/별\s*5\s*개\s*중\s*(\d(?:\.\d)?)\s*개/))) return +m[1];
    if ((m = said.match(/5\s*점\s*만점(?:에|\s*중)?\s*(\d(?:\.\d)?)\s*점?/))) return +m[1];
    if ((m = said.match(/(\d(?:\.\d)?)\s*(?:\/|out of)\s*5(?:\.0)?\b/i))) return +m[1];
    if ((m = said.match(/(?:별점|평점|rated|rating)\s*:?\s*(\d(?:\.\d)?)\s*(?:점|stars?)?(?![\d,])/i))) return +m[1];
    if ((m = said.match(/(\d(?:\.\d)?)\s*(?:stars?|점)\b/i)) && +m[1] <= 5) return +m[1];
    // 3) class 이름에 점수: star-5, rating_4, score40, rate-45
    for (const e of all) {
      const c = String(e.className?.baseVal ?? e.className ?? '');
      if ((m = c.match(/(?:star|rating|rate|score|grade)s?[-_]?(\d{1,2})(?![\d])/i))) {
        const n = +m[1];
        if (n <= 5) return n;
        if (n % 10 === 0 && n <= 50) return n / 10;     // 40 → 4.0
        if (n <= 10) return n / 2;                       // 10점 만점
        if (n <= 50) return n / 10;                      // 45 → 4.5
      }
    }
    // 4) 별 막대 너비 (%)
    for (const e of all) {
      if (!starish(e) && !starish(e.parentElement || e)) continue;
      const w = (e.getAttribute?.('style') || '').match(/width:\s*([\d.]+)%/);
      if (w) return Math.round(+w[1] / 2) / 10;
    }
    // 5) 채워진 별 아이콘 개수 / ★ 글자 개수
    const filled = all.filter((e) => /star/i.test(String(e.className?.baseVal ?? e.className ?? '')) && /(^|[-_\s])(on|fill(ed)?|full|active|checked|selected|yellow|orange|gold)([-_\s]|$)/i.test(String(e.className?.baseVal ?? e.className ?? ''))).length;
    if (filled >= 1 && filled <= 5) return filled;
    const t = norm(root.textContent || '');
    if ((m = t.match(/(★+)(☆*)/)) && m[1].length + m[2].length === 5) return m[1].length;
    return null;
  }

  // 배송 종류 이름 (원래 이름, 위장 이름)
  const SHIP_TYPES = [
    [/로켓\s*프레시|rocket[_-]?fresh|logo[_-]?fresh/i, '로켓프레시'],
    [/판매자\s*로켓|rocket[_-]?merchant/i, '판매자로켓'],
    [/로켓\s*직구|rocket[_-]?(global|jikgu|direct)|logo[_-]?jikgu/i, '로켓직구'],
    [/로켓\s*설치|rocket[_-]?install/i, '로켓설치'],
    [/로켓\s*배송|로켓\s*와우|logo[_-]?rocket|rocket[_-]?(filter|delivery|wow|badge)/i, '로켓배송'],
    [/와우\s*(회원|전용|할인)/, '와우회원'],
    [/새벽\s*(배송|도착)/, '새벽배송'],
    [/샛별\s*배송/, '샛별배송'],
    [/당일\s*(배송|도착)|오늘\s*도착|오늘\s*드림|오늘\s*\([^)]{1,3}\)\s*도착/, '오늘도착'],
    [/오늘\s*출발|당일\s*발송|당일\s*출고/, '오늘출발'],
    [/스마일\s*배송/, '스마일배송'],
    [/쓱\s*배송|SSG\s*배송|쓱1day/i, '쓱배송'],
    [/슈팅\s*배송/, '슈팅배송'],
    [/N\s*배송|도착\s*보장|(오늘|내일)\s*ON\s*다?|도착\s*예정\s*보장/, '도착보장'],
    [/해외\s*(배송|직구|구매대행)|global\s*shipping|international\s*shipping/i, '해외배송'],
    [/\bprime\b/i, 'Prime'],
    [/same[- ]day/i, 'Same-day'],
    [/(next|one)[- ]day/i, 'Next-day'],
    [/free\s*returns?|무료\s*반품/i, '무료반품'],
  ];
  const SHIP_ALIAS = { 로켓배송: '특송', 판매자로켓: '위탁특송', 로켓프레시: '냉장특송', 로켓직구: '해외특송', 로켓설치: '설치특송', 와우회원: '우대',
    새벽배송: '새벽', 샛별배송: '새벽', 오늘도착: '당일', 오늘출발: '당일출고', 스마일배송: '자체특송', 쓱배송: '자체특송', 슈팅배송: '자체특송',
    도착보장: '납기보장', 해외배송: '해외', Prime: '특송', 'Same-day': '당일', 'Next-day': '익일', 무료반품: '반품무상' };
  const shipName = (n) => (state.labels === 'real' ? n : SHIP_ALIAS[n] || n);
  // 운임 칸: '특송 · 0' / 실제 이름 모드면 '로켓배송 · 무료'
  function shipCell(f) {
    const types = (f.shipTypes || []).filter((n) => n !== '무료반품').slice(0, 2).map(shipName);
    let fee = '';
    if (f.ship === 0) fee = state.labels === 'real' ? (f.shipCond ? '조건부 무료' : '무료') : (f.shipCond ? '0*' : '0');
    else if (f.ship != null) fee = f.ship.toLocaleString();
    return esc([...types, fee].filter(Boolean).join(' · '));
  }

  // 가격 요소 바로 앞에 붙은 글 (형제나 부모의 앞 글)
  function priceLabel(el) {
    let e = el;
    for (let i = 0; i < 3 && e; i++) {
      let pv = e.previousSibling;
      while (pv && pv.nodeType === 3 && !norm(pv.textContent)) pv = pv.previousSibling;
      if (pv) {
        // 앞 글에 다른 가격이 있으면 그 가격 뒤의 글만 이름표로 봐요 ('최고판매가 35,900원 | 판매가격' → '판매가격')
        let txt = norm(pv.textContent);
        const ms = [...txt.matchAll(new RegExp(PRICE_RE.source, 'g'))];
        if (ms.length) { const last = ms[ms.length - 1]; txt = txt.slice(last.index + last[0].length); }
        return txt.slice(-24) + ' ' + (el.getAttribute('aria-label') || '');
      }
      e = e.parentElement;
    }
    return el.getAttribute('aria-label') || '';
  }

  // 가격 바로 뒤 글: '10,000원 쿠폰', '1,400원 적립'이면 가격이 아니에요.
  function priceAfter(el) {
    for (let e = el, i = 0; i < 3 && e; i++, e = e.parentElement) {
      let nx = e.nextSibling;
      while (nx && nx.nodeType === 3 && !norm(nx.textContent)) nx = nx.nextSibling;
      if (nx) return norm(nx.textContent).slice(0, 12);
    }
    return '';
  }

  // 제목·판매자가 될 수 없는 글 (리뷰 수, 배지 등)
  const NOT_TITLE = /^(리뷰|(일반|공식|인증|브랜드)\s*상품|아이템\s*카드|후기|평점|별점|상품평|구매평|배송|무료\s*배송|배송비|찜|좋아요|쿠폰|광고|AD|Sponsored|품절|세일|특가|오늘\s*드림|오늘\s*출발|내일\s*도착|더\s*보기|자세히|장바구니|바로\s*구매|구매하기|\(?\d)/i;
  const BADGE_WORD = /^(Skip\s.{0,20}|.{0,10}건너뛰기|본문\s*바로\s*가기|Highly rated|Top rated|New at( \w+)?|Only at( \w+)?|Deal of the day|Clearance|Popular now|Preview seller|Star Seller|Bestseller|Etsy'?s Pick|More like this|Add to cart|게스트\s*선호|슈퍼\s*호스트|Guest\s*favou?rite|Superhost|최다\s*판매|추가\s*구매\s*선택|프라임.{0,10}|More buying choices|Prime.{0,12}|Climate Pledge.*|탄소.{0,6}|관련|Related|후원|후원\s*광고|종합\s*추천|아마존\s*추천|Amazon'?s?\s*Choice|Overall\s*Pick|Limited\s*time\s*deal|기간\s*한정\s*(딜|할인)|새\s*창\s*(에서\s*)?(이동|열기|열림)|opens? in (a )?new (window|tab)|최고|우수|매우\s*좋음|아주\s*좋음|좋음|훌륭함|만족|매우\s*만족|Exceptional|Excellent|Very good|Good|Wonderful|Superb|Fabulous|Pleasant|미리\s*보기|크게\s*보기|새\s*창\s*보기|바로\s*가기|더\s*보기|상세\s*보기|담기|장바구니\s*담기|멤버스\s*특가|일일\s*특가|컬리\s*온리|Kurly\s*Only|샛별\s*배송|택배\s*배송|판매자\s*배송|희소가치.*|첫구매.*|베스트|BEST|NEW|신상|신상품|HOT|단독|독점|한정|패션위크|올영픽|추천|인기|랭킹|MD\s*PICK|PICK|무료배송|오늘드림|쿠폰|세일|SALE|특가|타임특가|광고|AD|이벤트|기획|증정|1\+1|\d+\s*%|\d+위|TOP\s*\d+|Sponsored|Best Seller|Amazon's Choice|Overall Pick)$/i;

  // 줄 대부분이 같은 보낸이('겨울준비')면 그건 기획전 이름이에요. 그 줄들은 다음 짧은 줄(브랜드)을 써요.
  function fixSenders(items) {
    if (items.length < 6) return items;
    const cnt = {};
    for (const f of items) cnt[f.sender] = (cnt[f.sender] || 0) + 1;
    for (const [s, n] of Object.entries(cnt)) {
      const rows = items.filter((f) => f.sender === s && f.senderLine === s);
      if (n >= 4 && n >= items.length * 0.25 && rows.length === n && !rows.some((f) => f.title.includes(s))) rows.forEach((f) => { f.sender = f.senderT || f.sender; });
    }
    for (const k of Object.keys(cnt)) delete cnt[k];
    for (const f of items) cnt[f.sender] = (cnt[f.sender] || 0) + 1;
    for (const [s, n] of Object.entries(cnt)) {
      if (n < items.length * 0.3) continue;
      const alts = items.filter((f) => f.sender === s && f.sender2 && f.sender2 !== s);
      if (alts.length >= n * 0.6 && new Set(alts.map((f) => f.sender2)).size >= 3) alts.forEach((f) => { f.sender = f.sender2; });
    }
    return items;
  }

  function extractFields(root, opts = {}) {
    const text = norm(root.innerText);
    const f = { sales: null, salesPlus: false, title: '', sender: '', price: null, orig: null, discount: null, rating: null, ratingMax: 5, reviews: null, date: null, time: null, img: null, link: null, labels: [], soldOut: false, preview: '' };

    // 가격: '원'이나 '₩'이 붙은 짧은 덩어리. 취소선이면 원래 가격이에요.
    const prices = [];
    let m0;
    for (const el of root.querySelectorAll('*')) {
      const t = norm(el.textContent);
      if (t.length > 22 || !PRICE_RE.test(t)) continue;
      if ([...el.children].some((c) => PRICE_RE.test(norm(c.textContent)))) continue; // 가장 안쪽만
      const m = t.match(PRICE_RE);
      const { v, cur } = priceOf(m);
      // 가격 앞의 이름표: '판매가 40,883원', '정상가 49,900원', '배송비 3,000원'
      const lab = (t.replace(m[0], '') + ' ' + priceLabel(el)).trim();
      const ship = /배송비|택배비|운임|shipping|delivery|postage/i.test(lab);
      const origLab = /정상\s*가|정가|(?<![회특])원가(?!격)|할인\s*전|최고\s*판매가|소비자\s*가|권장|시중\s*가|원래\s*가|list\s*price|was\b|reg\.?\b|msrp|typical|retail/i.test(lab);
      const saleLab = /판매\s*가|할인\s*가|혜택\s*가|최종\s*가|적용\s*가|특가|sale|now\b|deal|your price/i.test(lab);
      if (v && (cur !== '원' || v >= 100)) prices.push({ v, cur, strike: isStrike(el) || origLab, sale: saleLab && !origLab, per: ship || /^(쿠폰|할인\s*쿠폰|적립|추가\s*할인|캐시|포인트|off\b)/i.test((t.slice(t.indexOf(m[0]) + m[0].length) || priceAfter(el)).trim()) || /적립|쿠폰\s*할인\s*금액|캐시|포인트|\/\s*(oz|ct|count|unit)|per\s|\d+\s*(g|ml|개)\s*당/i.test(t + ' ' + lab) });
      if (prices.length > 12) break;
    }
    if (!prices.length) {
      // '원' 글자 없이 숫자만 있는 사이트(롯데ON '최종가 143,100'): 이름표나 가격 칸 이름(class)으로 찾아요.
      const krw = /[가-힣]/.test(text);
      for (const mm of text.matchAll(/(최종\s*가|판매\s*가격?|할인\s*가|혜택\s*가|특가|정상\s*가|정가|가격)\s*:?\s*([\d]{1,3}(?:,\d{3})+|\d{4,})(?!\s*(?:개|건|명|점|%|원))/g)) {
        const v = num(mm[2]);
        if (v >= 100) prices.push({ v, cur: '원', strike: /정상|정가/.test(mm[1]), sale: !/정상|정가|^가격$/.test(mm[1]), per: false });
      }
      if (!prices.length && krw) {
        for (const el of root.querySelectorAll('[class*="price" i],[class*="prc" i],[class*="amount" i],[class*="cost" i]')) {
          const t = norm(el.textContent);
          if (!/^[\d]{1,3}(,\d{3})+$|^\d{4,}$/.test(t)) continue;
          prices.push({ v: num(t), cur: '원', strike: isStrike(el) || /origin|before|old|normal|regular|list|consumer/i.test(String(el.className)), sale: false, per: false });
          if (prices.length > 6) break;
        }
      }
      // 29CM '32% 66,550': 할인율 바로 뒤 숫자가 할인된 가격이에요.
      if (!prices.length && krw && (m0 = text.match(/\d{1,2}\s*%\s+(\d{1,3}(?:,\d{3})+)(?!\s*(?:개|건|명|점|%|원|\)))/))) prices.push({ v: num(m0[1]), cur: '원', strike: false, sale: true, per: false });
    }
    const real = prices.filter((p) => !p.strike && !p.per).sort((a, b) => b.sale - a.sale);
    if (real.length) { f.price = real[0].v; f.cur = real[0].cur; }
    else {
      // 모두 '원래 가격'처럼 보이면 가장 싼 것을 지금 가격으로
      const any = prices.filter((p) => !p.per).sort((a, b) => a.v - b.v)[0];
      if (any && prices.filter((p) => !p.per).length >= 2) { f.price = any.v; f.cur = any.cur; any.strike = false; any.used = true; }
    }
    // '38,000원 → 34,200원' : 화살표 앞이 원래 가격
    let arrow;
    if ((arrow = text.match(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원?\s*(?:→|➝|➔|->|⇒|▶)\s*(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/))) {
      const a = num(arrow[1]), b = num(arrow[2]);
      if (a > b) { f.price = b; f.cur = '원'; prices.push({ v: a, cur: '원', strike: true }); }
    }
    const struck = prices.filter((p) => p.strike && !p.used);
    if (struck.length) f.orig = Math.max(...struck.map((p) => p.v));

    let m;
    const discText = text.replace(/(예매율|점유율|적립률?|달성률?|좌석\s*점유|에그\s*지수|골든\s*에그|만족도|신선도|관람평|Tomatometer|Audience Score)\s*\??\s*[\d.]+\s*%/gi, '');
    if ((m = discText.match(/(\d{1,2})\s*%/))) f.discount = +m[1];
    else if (f.orig && f.price && f.orig > f.price) f.discount = Math.round((1 - f.price / f.orig) * 100);
    // 글의 첫 %가 카드 할인·적립 같은 다른 숫자일 수 있어요: 원래 가격과 지금 가격으로 셈한 값과 많이 다르면 셈한 값을 써요
    if (f.orig && f.price && f.orig > f.price) { const calc = Math.round((1 - f.price / f.orig) * 100); if (Math.abs(calc - (f.discount || 0)) > 3) f.discount = calc; }
    if (!f.orig && f.discount && f.price) {
      const lo = prices.filter((p) => !p.per && p.v < f.price).map((p) => p.v).sort((a, b) => b - a)[0];
      if (lo && Math.abs(1 - lo / f.price - f.discount / 100) < 0.03) { f.orig = f.price; f.price = lo; }
    }

    // 평점: aria-label 숫자, '평점/별점/★ 4.5', 또는 짧은 '4.5' 덩어리
    const aria = [...root.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).find((a) => /^(?:별점|평점)\s*\d(?:\.\d)?(?:점)?$|^\d\.\d$|^\d(?:\.\d)?점$/.test(norm(a))); // 맨 숫자 '1'은 사진 번호일 수 있어요
    if (aria) f.rating = num(aria.match(/\d(?:\.\d)?/)[0]);
    if (f.rating == null && (m = text.match(/(?:★|평점|별점)\s*(\d{1,2}(?:\.\d{1,2})?)/))) f.rating = num(m[1]);
    if (f.rating == null && (m = (text + ' ' + [...root.querySelectorAll('[aria-label],[title]')].map((e) => e.getAttribute('aria-label') || e.title).join(' ')).match(/([0-5](?:\.\d)?)\s*out of\s*5/i))) f.rating = num(m[1]);
    if (f.rating == null) {
      const sc = [...root.querySelectorAll('[class*="score" i],[class*="rating" i],[class*="grade" i]')].map((e) => norm(e.textContent)).find((t) => /^(10|\d)\.\d{1,2}$/.test(t));
      if (sc) f.rating = num(sc);
    }
    if (f.rating == null) {
      for (const el of root.querySelectorAll('span,em,strong,div,b')) {
        const t = norm(el.textContent);
        if (/^(10|\d)\.\d{1,2}$/.test(t) && !el.children.length) { f.rating = num(t); break; }
      }
    }
    if (f.rating == null) {
      // 별 모양 막대의 너비(%)로 평점을 그리는 사이트: width:90% → 4.5점
      const bar = root.querySelector('[class*="star" i] [style*="width"],[class*="rating" i] [style*="width"],[class*="star" i][style*="width"]');
      const w = bar && (bar.getAttribute('style') || '').match(/width:\s*([\d.]+)%/);
      if (w) f.rating = Math.round(num(w[1]) / 2) / 10;
    }
    if (f.rating == null) f.rating = starRating(root);
    // 카드 끝의 '4.8 (144)', '5 (144)' : 별 그림 옆 평점과 리뷰 수 (29CM·무신사)
    if (f.rating == null && (m = text.match(/(?:^|\s)([0-5](?:\.\d)?)\s*\(([\d,]+\+?)\)\s*$/))) { f.rating = num(m[1]); if (f.reviews == null) f.reviews = num(m[2]); }
    if (f.rating != null && f.rating > 5) f.ratingMax = 10;
    if (f.rating != null && (f.rating < 0 || f.rating > 10)) f.rating = null;

    // 리뷰 수
    if ((m = text.match(/(?:리뷰|후기|상품평)\s*(?:갯수|개수|수)\s*:?\s*\(?\s*([\d,]+)\s*(?:건|개)?/))) f.reviews = num(m[1]);
    else if ((m = text.match(/(?:리뷰|후기|상품평|평가|review)s?\s*\(?\s*([\d,]+)(?![\d,])(?!\s*[원%])/i))) f.reviews = num(m[1]);
    else if ((m = text.match(/([\d,]+)\s*(?:명|개|건)?\s*(?:의\s*)?(?:이용\s*|숙박\s*|투숙\s*)?(?:리뷰|후기|상품평|평가|참여)/))) f.reviews = num(m[1]);
    else if ((m = text.match(/([\d,.]+)\s*(K|M)?\+?\s*(?:global\s*)?(?:ratings?|reviews?|product ratings)/i))) f.reviews = num(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1000 : 1e6) : 1);
    else if ((m = text.match(/\(\s*([\d,.]+)\s*(만|천|K|M)?\+?\s*\)(?!\s*원)/i))) f.reviews = Math.round(num(m[1]) * ({ 만: 1e4, 천: 1e3, k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] || 1));
    // 속성에 든 리뷰 수 (Etsy review-count-text="(1.5k)")
    if (f.reviews == null) {
      const rc = root.querySelector('[review-count-text],[data-review-count],[data-reviews-count],[data-review-total]');
      const v = rc && (rc.getAttribute('review-count-text') || rc.getAttribute('data-review-count') || rc.getAttribute('data-reviews-count') || rc.getAttribute('data-review-total') || '');
      if ((m = v && v.match(/([\d.,]+)\s*(k|m|만|천)?/i))) f.reviews = Math.round(num(m[1]) * ({ k: 1e3, m: 1e6, 만: 1e4, 천: 1e3 }[(m[2] || '').toLowerCase()] || 1));
    }
    if (f.reviews != null && f.reviews === f.price) f.reviews = null;

    // 판매수: "1,234개 구매", "구매 1만+", "500명 예약", "누적판매 3,000"
    const unit = (n, u) => (n == null ? null : n * (u === '만' ? 10000 : u === '천' ? 1000 : 1));
    if ((m = text.match(/([\d,]+(?:\.\d)?)\s*(만|천)?\s*(\+)?\s*(?:개|건|명|회|장)?\s*(?:이상\s*)?(?:구매|판매|팔림|주문|예약|예매)(?!하기|\s*가능|\s*불가)/))) {
      f.sales = unit(num(m[1]), m[2]); f.salesPlus = !!m[3];
    } else if ((m = text.match(/(?:구매|판매|누적\s*판매|누적\s*관객|누적|주문|예약)\s*(?:수|건수|횟수)?\s*([\d,]+(?:\.\d)?)\s*(만|천)?\s*(\+)?/))) {
      f.sales = unit(num(m[1]), m[2]); f.salesPlus = !!m[3];
    }
    if (f.sales == null && (m = text.match(/([\d,.]+)\s*(K|M)?\s*(\+)?\s*(?:sold|bought)/i))) {
      f.sales = num(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1000 : 1e6) : 1); f.salesPlus = !!m[3];
    }
    if (f.sales != null && (!f.sales || f.sales === f.price || f.sales === f.reviews)) f.sales = null;

    f.date = parseDate(text);
    if ((m = text.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/))) f.time = `${m[1].padStart(2, '0')}:${m[2]}`;

    // 제목: 제목·이름 클래스나 h태그, 없으면 가장 긴 글 덩어리
    // 점수: h태그 > 제목·이름 클래스·이미지 설명 > strong. '공연기간', '장소', 날짜 범위 같은 설명 줄은 깎아요.
    const cand = [];
    const add = (t, s) => { t = norm(t); if (t) cand.push({ t, s }); };
    root.querySelectorAll('h1,h2,h3,h4,h5').forEach((e) => add(e.textContent, 3));
    // 객실·옵션 이름('스탠다드 트윈룸')보다 숙소·상품 이름이 먼저예요
    root.querySelectorAll('[class*="title" i],[class*="name" i],[class*="tit" i]').forEach((e) => add(e.textContent, /room|option|variant|sku|plan|객실/i.test(String(e.className)) ? 0.8 : 2));
    root.querySelectorAll('[data-testid*="name" i]').forEach((e) => add(e.textContent, 3));
    root.querySelectorAll('[data-testid*="title" i]').forEach((e) => add(e.textContent, 2.5));
    root.querySelectorAll('strong').forEach((e) => add(e.textContent, 1));
    root.querySelectorAll('a[href] b, a[href] strong').forEach((e) => add(e.textContent, 2));
    root.querySelectorAll('a[href]').forEach((e) => { if (!e.querySelector('img')) add(e.textContent, 0.5); });
    root.querySelectorAll('img[alt]').forEach((e) => add(e.alt, 2));
    const good = cand
      .filter(({ t, s }) => t.length >= (s >= 3 ? 2 : 4) && t.length <= 140 && !(PRICE_RE.test(t) && t.length < 25) && !/^\d/.test(t) && !NOT_TITLE.test(t))
      .filter(({ t }) => !/^[\[(【][^\])】]*[\])】]$/.test(t)) // '[국내도서]' 같은 말머리만 있는 글
      .filter(({ t }) => !/^\S{0,8}\s?(아이템|상품)\s*카드$/.test(t))
      .filter(({ t }) => !/\d+\s*장\s*중\s*\d+\s*번째|^(photo|image)?\s*\d+\s*(of|\/)\s*\d+/i.test(t))
      .filter(({ t }) => !/^((hotel|room|product|item|main|cover|thumb)\s*)?(overview\s*)?(picture|image|photo|img|thumbnail)$|^(상품|대표|숙소|객실)?\s*(이미지|사진|썸네일)$/i.test(t)) // G마켓 '스마일상품 아이템카드' (화면 낭독용 이름)
      .map(({ t, s }) => ({ t, s: s - (/^(공연기간|관람기간|기간|장소|일시|위치|주소|출발|도착)/.test(t) || /~/.test(t) ? 5 : 0)
        // 설명 문장('…산정됩니다.', 'Prices include taxes.')은 제목이 아니에요 (아고다 말풍선)
        - (t.length > 25 && /(니다|어요|해요|세요)\.?$|[a-z]\.$/.test(t) ? 6 : 0)
        - (PRICE_RE.test(t) ? 2 : 0) }));
    if (good.length) f.title = good.sort((a, b) => b.s - a.s || b.t.length - a.t.length)[0].t;
    if (!f.title) {
      const lines = (root.innerText || '').split('\n').map(norm).filter((t) => t.length >= 4 && !(PRICE_RE.test(t) && t.length < 25) && !NOT_TITLE.test(t) && !BADGE_WORD.test(t)
        && !(t.length > 25 && /(니다|어요|해요|세요)\.?$|[a-z]\.$/.test(t)) && !/^tooltip$/i.test(t));
      f.title = lines.sort((a, b) => b.length - a.length)[0] || '(제목 없음)';
    }
    // 화면 낭독용 '상품명' 앞에 붙은 배지·브랜드 글 떼기 ('공식상품너츠상품명 너츠 골전도…')
    if (/(상품명|제품명)\s*\S/.test(f.title)) f.title = f.title.replace(/^.*?(상품명|제품명)\s*/, '');
    f.title = f.title.replace(/\s*(포스터|poster|썸네일|thumbnail|대표\s*이미지|상품\s*이미지|이미지)$/i, '').replace(/\s*(더\s*보기|새\s*창\s*(에서\s*)?(이동|열기|열림)|새창열기|\(?opens? in (a )?new (window|tab)\)?)$/i, '');
    if (opts.detail) f.title = norm(titleElement()?.textContent) || pageTitle() || f.title;

    // 보낸 사람 자리: 브랜드·판매자·지역·극장 같은 짧은 글, 없으면 제목 첫 단어
    const senderEl = root.querySelector('[class*="brand" i],[class*="seller" i],[class*="store" i],[class*="mall" i],[class*="shop" i],[class*="location" i],[class*="area" i],[class*="place" i],[class*="venue" i],[class*="theater" i],[class*="airline" i],[class*="region" i]');
    // G마켓 '공식상품', '인증상품' 같은 화면 낭독용 말머리는 떼요
    const unbadge = (t) => t && t.replace(/^(?:[가-힣]{2,5}\s*상품(?=\s*\S|$)\s*)+/, '').replace(/^(스토어|판매자|상점|셀러|브랜드)(명|\s*이름)\s*:?\s*/, '').replace(/\s*(지도에서\s*(표시|보기)|지도\s*보기|show on map|view on map)$/i, '');
    let st = senderEl && unbadge(norm(senderEl.textContent));
    const okSender = (s) => s && s.length >= 2 && s.length <= 16 && s !== f.title && !/\d.*(원|%)|[%₩$€£¥]|^\d/.test(s) && !NOT_TITLE.test(s) && !BADGE_WORD.test(s)
      // 화면 낭독용 칸 이름 ('상품명', '가격정보', '판매가', '할인율')
      && !/^[,+·|]|[:：]$/.test(s) && !/^(제한된\s*시간|한정\s*시간|일반\s*가격|정가|가격)/.test(s) && !/색상|패턴|제품\s*페이지|colors?|options?|more\b/i.test(s)
      && !/찜\s*하기|순위|^찜$|wishlist|add to (list|favorites)/i.test(s)
      && !/번째\s*사진|장\s*중|수수료|한마디|신규\s*(숙소|등록)|무료\s*취소|취소\s*가능|free cancellation|new listing/i.test(s)
      && !/^(구매|판매|구매\s*수|판매\s*수|.*평점|상품명|제품명|가격\s*정보|판매\s*가|할인\s*율|할인률|원가|정보|최저가|.*최저가|.*정보)$/.test(s);
    // data-testid 제목 칸 (에어비앤비 '애월읍의 펜션'): 이름 칸을 제목으로 썼으면 이쪽이 보낸이 자리예요
    if (!okSender(st)) { const tt = norm(root.querySelector('[data-testid*="title" i]')?.textContent || ''); if (okSender(tt)) st = tt; }
    // 카드 맨 앞 짧은 줄이 브랜드인 사이트가 많아요 (오늘의집 '먼데이하우스', 무신사 '아워호프'). 배지 글은 건너뛰어요.
    const btnText = new Set([...root.querySelectorAll('button,[role="button"],[class*="badge" i],[class*="label" i],[class*="tag" i],[class*="btn" i],[class*="flag" i]')]
      .map((e) => unbadge(norm(e.textContent))).filter((t) => t && t.length <= 20));
    const shortLines = (root.innerText || '').split('\n').map((t) => unbadge(norm(t))).filter((t) => !btnText.has(t)).filter((t) => t && t.length <= 14 && okSender(t) && !/^[\d.,%()\s:+]+$/.test(t) && !/^tooltip$|\d|배송|도착|출발|할인|쿠폰|적립|혜택|포인트/i.test(t));
    f.sender2 = shortLines[1] || ''; // 첫 줄이 기획전 이름일 때 쓸 다음 줄 ('겨울준비' 다음 '노운베러')
    const firstLine = (root.innerText || '').split('\n').map((t) => unbadge(norm(t))).find((t) => t && !BADGE_WORD.test(t) && !NOT_TITLE.test(t) && !/^[\d.,%()\s:+]+$/.test(t));
    const fromTitle = f.title.replace(/^\s*[\[(【][^\])】]{0,20}[\])】]\s*/, '').split(/[\s,\[\]()]/).find((w) => w.length >= 2);
    // 책: '홍길동 (지은이)'
    // 예스24·교보: '박응용 저' (작가 칸)
    const authEls = [...root.querySelectorAll('[class*="auth" i],[class*="writer" i]')].map((e) => norm(e.textContent)).filter((t) => t && t.length <= 40);
    const authEl = (authEls.find((t) => /\s(저|저자|지음|글|공저|엮음)(\s|$)/.test(t)) || '').replace(/\s*(저|저자|지음|글|외|공저|엮음)(\s.*)?$/, '');
    const author = text.match(/([^\s|(),/]{1,12}(?:\s[^\s|(),/]{1,10})?)\s*\((?:지은이|저|글|엮은이|저자)\)/) || (authEl.length >= 2 && authEl.length <= 14 ? [authEl, authEl] : null);
    const seller = text.match(/(?:판매자|셀러|판매처|스토어|상점|seller|sold by|from shop)(?:명|\s*이름)?\s*:?\s*([^\s|·,]{2,14})/i)
      || text.match(/(?:^|[・·|]\s*|\s)By\s+([A-Z0-9][\w.&'-]{1,20})/);
    if (author && !okSender(st)) { f.sender = author[1].replace(/\s*(저자|저|지음)$/, '').slice(0, 14); }
    else if (seller && !okSender(st) && okSender(seller[1]) && !/정보|등급|배송|직접|평점|찜|문의/.test(seller[1])) { f.sender = seller[1]; }
    else f.sender = (okSender(st) ? st : okSender(firstLine) && firstLine.length <= 14 && firstLine !== f.title ? firstLine : (((f.senderLine = shortLines.find((t) => t !== f.title && !f.title.startsWith(t)))) || fromTitle || '업무팀')).slice(0, 14);
    f.senderT = fromTitle || '';

    // 미리보기: 숫자 아닌 짧은 글 몇 개 (배송·위치·좌석 등)
    const pv = (root.innerText || '').split('\n').map(norm)
      .filter((t) => t && t.length <= 30 && t !== f.title && t !== f.sender && !PRICE_RE.test(t) && !/^[\d.,%()\s:]+$/.test(t) && !/^(광고|AD)$/i.test(t) && !/적립|쿠폰|캐시|할인|반품|새 상품|포인트|%/.test(t));
    f.preview = [...new Set(pv)].slice(0, 4).join(' · ');

    if (/무료\s*배송|무료\s*취소|free\s*(shipping|delivery|returns|cancellation)/i.test(text)) f.labels.push('free');
    if (root.querySelector('img[src*="rocket" i],img[alt*="로켓"]') || /로켓/.test(text)) f.labels.push('fast');
    if (/(^|\s)(광고|AD|Sponsored)(\s|$)/.test(text)) f.labels.push('ad');

    // 배송 종류: 글자와 배지 그림(alt·파일 이름) 둘 다 봐요. 쿠팡은 로켓배송 종류를 그림으로만 보여줘요.
    const badges = [...root.querySelectorAll('img')].slice(0, 20).map((i) => (i.alt || '') + ' ' + [i.currentSrc, i.src, i.getAttribute('data-src'), i.getAttribute('srcset')].filter(Boolean).map((u) => u.split('?')[0].split('/').pop()).join(' ')).join(' ');
    const shipText = text + ' ' + badges;
    f.shipTypes = SHIP_TYPES.filter(([re]) => re.test(shipText)).map(([, n]) => n);
    if (f.shipTypes.some((n) => /^(판매자로켓|로켓프레시|로켓직구|로켓설치)$/.test(n))) f.shipTypes = f.shipTypes.filter((n) => n !== '로켓배송');
    // 배송비: 무료면 0, 금액이 적혀 있으면 그 금액, 모르면 비워 둬요.
    f.ship = null; f.shipCond = false;
    if (/조건부\s*무료/.test(text)) { f.ship = 0; f.shipCond = true; }
    else if (/무료\s*배송|배송비\s*:?\s*무료|free\s*(shipping|delivery)|ships?\s*free|envío gratis|livraison gratuite|kostenloser versand|送料無料/i.test(text)) f.ship = 0;
    else if ((m = text.match(/배송비\s*:?\s*\+?\s*([\d,]+)\s*원/)) || (m = text.match(/\+\s*([\d,]+)\s*원\s*(?:배송|택배)/)) || (m = text.match(/(?:택배|배송)\s*([\d,]+)\s*원/))) f.ship = num(m[1]);
    else if ((m = text.match(/\+?\s*(?:US\s*|C|A|AU)?(?:\$|€|£|KRW\s?)\s?([\d.,]+)\s*(?:shipping|delivery|postage|배송)/i)) || (m = text.match(/(?:shipping|delivery|postage)\s*:?\s*\+?\s*(?:US\s*)?(?:\$|€|£)\s?([\d.,]+)/i))) f.ship = num(m[1]);
    if (f.ship != null && f.price != null && f.ship >= f.price) f.ship = null;
    f.soldOut = /품절|매진|마감|예약\s*불가|일시\s*중단|out of stock|sold out|unavailable/i.test(text);

    f.img = pickImage(root);
    f.link = opts.detail ? (DOC.defaultView || window).location.href : pickLink(root);
    f.id = String(hash((f.link || '') + f.title));
    return f;
  }

  // ---------- 2-0. 사이트 메뉴 (주문·장바구니·찜·취소) ----------
  const MENU = {
    orders: /^(주문|주문\s*확인|주문\s*목록|주문\s*내역|주문\s*배송\s*조회|주문\/?배송|구매\s*내역|예약\s*내역|예매\s*내역|나의\s*예약|my\s*orders|your\s*orders|orders|purchase\s*history|my\s*trips|bookings|my\s*bookings)$/i,
    cart: /^(장바구니|카트|cart|basket|bag|shopping\s*cart)$/i,
    wish: /^(찜|찜\s*리스트|찜한\s*상품|찜\s*목록|관심\s*상품|위시\s*리스트|좋아요|wish\s*list|wishlist|saved|watchlist|favorites|lists)$/i,
    cancel: /^(취소\s*[·\/]?\s*반품(\s*[·\/]?\s*교환)?(\s*목록|\s*내역)?|취소\s*내역|반품\s*내역|returns|returns\s*&\s*orders|cancell?ations)$/i,
  };
  function siteMenu() {
    const out = {};
    for (const a of document.querySelectorAll('a[href]')) {
      if (host?.contains(a)) continue;
      const txt = norm(a.textContent);
      const aria = norm(a.getAttribute('aria-label') || a.title || '');
      if (!txt && !aria) continue;
      for (const [k, re] of Object.entries(MENU)) {
        // 글자가 있으면 정확히, 아이콘만 있는 링크는 aria-label에 들어 있는지로 찾아요.
        const loose = { orders: /orders|purchase history|주문/i, cart: /cart|basket|장바구니/i, wish: /watchlist|wish\s*list|찜/i, cancel: /returns|반품/i }[k];
        const hit = txt ? (txt.length <= 20 && re.test(txt)) : (aria.length <= 60 && loose.test(aria));
        if (!out[k] && hit) {
          try { out[k] = new URL(a.getAttribute('href'), location.href).href; } catch {}
        }
      }
    }
    out.home = location.origin + '/';
    return out;
  }
  const menuHere = (url) => { try { const u = new URL(url); return u.host === location.host && u.pathname === location.pathname; } catch { return false; } };
  const goFold = (k, label, menu, extra = '') => {
    const url = menu[k];
    if (!url) return `<a class="fold nf" title="이 사이트에서 찾지 못했어요">${label}</a>`;
    return `<a class="fold ${menuHere(url) ? 'on' : ''}" data-go="${esc(url)}">${label}${extra}</a>`;
  };

  // ---------- 2-1. 상세 페이지 ----------
  const BUY_RE = /^(바로\s*구매(하기)?|즉시\s*구매(하기)?|지금\s*구매(하기)?|구매하기|장바구니에\s*(추가|담기)|장바구니(\s*담기)?|예약하기|바로\s*예약(하기)?|예매하기|객실\s*선택|좌석\s*선택|예약\s*가능\s*객실\s*보기|선물하기|add to cart|add to basket|add to bag|buy it now|buy now|book now|reserve|select room|see availability)$/i;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  // 버튼이 상품 카드 목록 안에 있나? (검색 결과 카드마다 '장바구니' 버튼이 있는 사이트가 있어요)
  function inRepeatedCard(el) {
    for (let e = el, i = 0; e && e.parentElement && e !== DOC.body && i < 7; e = e.parentElement, i++) {
      const sig = sigOf(e);
      let n = 0;
      // 형제 4개 이상이 저마다 사진과 가격을 가진 '상품 카드'일 때만
      const bt = norm(el.textContent || el.value || '');
      for (const k of e.parentElement.children) {
        if (sigOf(k) !== sig || !k.querySelector('img')) continue;
        const same = bt && [...k.querySelectorAll('button,a,[role="button"]')].some((x) => norm(x.textContent) === bt);
        if ((PRICE_RE.test(k.innerText || '') || same) && ++n >= 4) return true;
      }
    }
    return false;
  }
  // 사이트 머리말(맨 위 메뉴 줄) 안인가? 'productDetailHeader'처럼 이름만 header인 본문 칸은 빼요.
  function inSiteHeader(b) {
    if (b.closest('header,nav,[role="banner"],[role="navigation"]')) return true;
    for (let e = b.parentElement; e && e !== DOC.body; e = e.parentElement) {
      const n = String(e.className || '') + ' ' + (e.id || '');
      if (!/(^|[\s_-])(header|gnb|global[-_]?nav|top[-_]?bar)([\s_-]|$)/i.test(n)) continue;
      const r = e.getBoundingClientRect();
      const top = r.top + ((DOC.defaultView || window).scrollY || 0);
      if (top < 160 && r.height < 260) return true;
    }
    return false;
  }
  function buyButton() {
    return [...DOC.querySelectorAll('button,a,input[type="submit"],[role="button"]')]
      .find((b) => !host?.contains(b) && BUY_RE.test(norm(b.textContent || b.value)) && visible(b) && !inRepeatedCard(b)
        // 머리말의 '장바구니' 메뉴 링크는 구매 버튼이 아니에요.
        && !inSiteHeader(b)
        && !(b.tagName === 'A' && /cart|basket|장바구니/i.test(b.getAttribute('href') || '') && /^장바구니$/.test(norm(b.textContent)))
        // 목록 위 '전체선택 · 장바구니 · 선물하기' 막대는 고른 상품을 한꺼번에 담는 버튼이에요 (교보문고)
        && !(() => { for (let e = b.parentElement, i = 0; e && i < 4; e = e.parentElement, i++) if (/^전체\s*선택|select all/i.test(norm(e.innerText || ''))) return true; return false; })()
        // 같은 검색 페이지로 가는 링크는 '즉시 구매만 보기' 같은 거르기 메뉴예요.
        && !(b.tagName === 'A' && b.pathname && b.pathname === (DOC.defaultView || window).location.pathname));
  }

  function pageTitle() {
    const og = norm(DOC.querySelector('meta[property="og:title"]')?.content || '');
    const tt = norm(DOC === document ? (saved?.title || origTitle || document.title) : DOC.title);
    const raw = og.length >= tt.length * 0.6 && og.length >= 10 ? og : tt;
    return raw.replace(/\s*[-|:]\s*[^-|:]{1,20}$/, '').replace(/^\[[^\]]{1,12}\]\s*/, (m) => m) || raw;
  }

  function titleElement() {
    // 상품명 글이 들어 있는 가장 안쪽 요소 (없으면 h1)
    const t = pageTitle();
    const key = t.slice(0, 20);
    if (key.length >= 6) {
      const hits = [...DOC.querySelectorAll('h1,h2,h3,h4,strong,div,span,p')]
        .filter((e) => !host?.contains(e) && e.children.length <= 3 && norm(e.textContent).includes(key) && visible(e));
      if (hits.length) return hits.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0];
    }
    return DOC.querySelector('h1');
  }

  function isDetailPage() {
    const t = pageTitle();
    return !!(t && t.length >= 4 && buyButton() && titleElement());
  }

  function detailRoot() {
    // 제목(h1)에서 위로 올라가며 가격과 큰 이미지를 함께 품는 덩어리를 찾아요.
    const h1 = titleElement();
    let el = h1;
    for (let i = 0; i < 12 && el && el !== DOC.body; i++) {
      el = el.parentElement;
      const hasPrice = PRICE_RE.test(el.innerText || '');
      const hasImg = [...el.querySelectorAll('img')].some((im) => im.getBoundingClientRect().width >= 200);
      if (hasPrice && hasImg) return el;
    }
    return h1?.closest('main,[role="main"],article') || DOC.body;
  }

  function findReviews() {
    // 리뷰 목록: 글이 길고, 날짜가 있고, 같은 모양으로 반복되는 덩어리
    const DATE_RE = /(20\d{2}|\d{2})[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}|\d+\s*(일|주|개월|달)\s*전|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2}|\d+\s*(days?|weeks?|months?|years?|hours?)\s*ago|지난\s*(\d+\s*)?(일|주|개월|달|년|해)|\d+\s*(시간|분|년)\s*전|어제|past\s*(\d+\s*)?(days?|weeks?|months?|year)|yesterday/i;
    let best = null;
    for (const el of DOC.body.querySelectorAll('*')) {
      if (el.id === 'mm-host' || el.children.length < 2) continue;
      const groups = new Map();
      for (const k of el.children) { const s = sigOf(k); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(k); }
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        const texts = members.map((x) => norm(x.innerText));
        // 날짜가 있거나, 이름(class)이 리뷰처럼 생긴 반복 덩어리
        const named = /review|rvw|fdbk|feedback|comment|후기|리뷰/i.test(String(members[0].className || ''));
        const ok = texts.filter((t) => t.length >= 30 && t.length <= 4000 && (DATE_RE.test(t) || named));
        if (ok.length < 2 || ok.length < members.length * 0.6) continue;
        const avg = ok.reduce((a, t) => a + t.length, 0) / ok.length;
        if (avg < 50) continue;
        const score = ok.length * avg;
        if (!best || score > best.score) best = { score, members: members.filter((x, i) => texts[i].length >= 30) };
      }
    }
    if (!best) return [];
    return best.members.slice(0, 30).map((r) => {
      const lines = (r.innerText || '').split('\n').map(norm).filter(Boolean);
      const author = lines.find((t) => /^[가-힣A-Za-z0-9_]{1,8}\*{1,}[가-힣A-Za-z0-9*]*$/.test(t) || /\*{2,}/.test(t) && t.length <= 16)
        || lines.find((t) => t.length >= 2 && t.length <= 10 && !DATE_RE.test(t) && !/^[\d.,\s]+$/.test(t)) || '익명';
      const f = extractFields(r);
      const body = lines.filter((t) => t !== author && t.length >= 8 && !DATE_RE.test(t)).sort((a, b) => b.length - a.length).slice(0, 3);
      const photos = [...new Set([...r.querySelectorAll('img')].filter((im) => im.getBoundingClientRect().width >= 40).map((im) => im.currentSrc || im.src))].slice(0, 4);
      const dm = (r.innerText || '').match(DATE_RE);
      return { author: author.slice(0, 16), rating: f.rating, ratingMax: f.ratingMax, date: parseDate(r.innerText) , dateText: dm ? dm[0] : '', body, photos };
    });
  }

  function extractDetail() {
    const isDetail = isDetailPage();
    const main = isDetail ? detailRoot() : (DOC.querySelector('main,[role="main"],article') || DOC.body);
    const f = extractFields(main, { detail: true });
    // 갤러리: 상품 사진들 → 첨부파일
    f.gallery = [...new Set([...main.querySelectorAll('img')].filter((im) => im.getBoundingClientRect().width >= 60 && im.getBoundingClientRect().height >= 60).map((im) => im.currentSrc || im.src).filter(Boolean))].slice(0, 8);
    // 핵심 내용: 상세 덩어리 안의 짧은 줄 (옵션·배송·위치·일정 등)
    f.facts = [...new Set((main.innerText || '').split('\n').map(norm))]
      .filter((t) => t.length >= 3 && t.length <= 60 && t !== f.title && !PRICE_RE.test(t) && !/^[\d.,%()\s:+]+$/.test(t) && !BUY_RE.test(t) && !/적립|쿠폰|캐시|광고|공유|신고|찜|보기|열기|닫기|더보기|카테고리|^홈|>|스토어|로그인|선택하세요|수량/.test(t))
      .slice(0, 12);
    // 본문: 페이지의 설명 문단
    const paras = [];
    (DOC.querySelector('main,[role="main"],article') || DOC.body).querySelectorAll('p,li,dd').forEach((e) => {
      if (host?.contains(e) || main.contains(e)) return;
      const t = norm(e.textContent);
      if (t.length >= 25 && t.length <= 400 && !paras.includes(t)) paras.push(t);
    });
    f.body = paras.slice(0, 12);
    f.isProduct = isDetail;
    if (isDetail) {
      f.reviews_list = findReviews();
      // 관련 상품: 상세 덩어리 밖의 카드 목록
      const seen = new Set();
      f.related = findCards().filter((c) => !main.contains(c) && !c.contains(main)).map((c) => extractFields(c))
        .filter((x) => x.title && x.title !== f.title && !seen.has(x.id) && seen.add(x.id)).slice(0, 12);
    } else { f.reviews_list = []; f.related = []; }
    return f;
  }

  const reviewHead = () => [...DOC.querySelectorAll('h2,h3,h4,button,a,div,span')]
      .find((e) => !host?.contains(e) && /^(상품평|상품\s*리뷰|리뷰|후기|이용\s*후기|관람\s*후기|구매\s*후기|customer reviews|reviews|ratings and reviews)(\s*\(?[\d,]+\)?)?$/i.test(norm(e.textContent)) && visible(e));
  const reviewMore = () => [...DOC.querySelectorAll('button,a')].find((b) => !host?.contains(b) && /^(리뷰\s*)?(더\s*보기|더보기|more|see more reviews|show more|load more)$/i.test(norm(b.textContent)) && visible(b));

  // ---------- 2-2. 미리보기: 상품 페이지를 이 탭 뒤에서 몰래 열어 읽어요 (누를 때만, 한 번에 하나씩) ----------
  const previews = new Map(); // id → { status: 'loading' | 'done' | 'fail', data, note }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let pvFrame = null, pvChain = Promise.resolve();
  function queuePreview(item, force = false) {
    const cur = previews.get(item.id);
    if (!force && cur && cur.status !== 'fail') return pvChain;
    previews.set(item.id, { status: 'loading', data: cur?.data || item });
    pvChain = pvChain.then(() => fetchPreview(item)).catch(() => {});
    return pvChain;
  }
  async function fetchPreview(item) {
    render();
    let note = '';
    try {
      const u = new URL(item.link, location.href);
      const fr = pvFrame = document.createElement('iframe');
      fr.id = 'mm-pv-frame';
      fr.name = 'mm-pv:' + item.id;
      // 상품 페이지가 우리 탭을 다른 곳으로 보내거나 새 창을 띄우지 못하게 막아요.
      fr.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      fr.setAttribute('aria-hidden', 'true');
      fr.tabIndex = -1;
      fr.style.cssText = `position:fixed;left:0;top:0;width:${Math.max(1200, innerWidth)}px;height:${innerHeight}px;border:0;opacity:0;pointer-events:none;z-index:2147483646`;
      const loaded = new Promise((res) => { fr.onload = res; setTimeout(res, 12000); });
      fr.src = u.href;
      document.documentElement.appendChild(fr);
      await loaded;
      let d = null;
      try { d = fr.contentDocument; } catch {}
      if (d && (!d.body || d.location.href === 'about:blank')) d = null;
      let data;
      if (d) data = await readPreviewDoc(d, fr.contentWindow);
      else if (hasChrome) {
        // 주소가 달라 직접 못 읽으면, 그 페이지 안에 들어간 이 확장프로그램이 읽어서 보내 줘요.
        data = await new Promise((res, rej) => {
          const to = setTimeout(() => { removeEventListener('message', on); rej(new Error('이 사이트는 미리보기를 막아 둬서 못 불러와요. 열기로 보세요.')); }, 15000);
          function on(e) {
            if (e.source !== fr.contentWindow || e.data?.__mm !== 'pv' || e.data.id !== item.id) return;
            clearTimeout(to); removeEventListener('message', on);
            e.data.data ? res(e.data.data) : rej(new Error('상품 정보를 읽지 못했어요. 열기로 보세요.'));
          }
          addEventListener('message', on);
        });
      } else throw new Error('다른 주소의 상품이라 미리보기를 못 불러와요. 열기로 보세요.');
      const keep = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)));
      data = { ...item, ...keep, title: item.title || data.title, id: item.id, link: item.link, isProduct: true, related: [], reviews_list: data.reviews_list || [] };
      if (!data.reviews_list.length) note = '리뷰를 찾지 못했어요. 열기로 들어가서 보시거나 ⟳로 다시 불러와 보세요.';
      previews.set(item.id, { status: 'done', data, note });
    } catch (err) {
      previews.set(item.id, { status: 'fail', data: { ...item, isProduct: true, related: [], reviews_list: [] }, note: err.message || '불러오지 못했어요.' });
    } finally {
      pvFrame?.remove(); pvFrame = null;
    }
    render();
  }
  // 상품 페이지 하나를 읽어요: 상세 내용 + 리뷰 (리뷰가 늦게 뜨면 숨은 페이지만 내려서 불러와요)
  async function readPreviewDoc(d, w) {
    await sleep(1200);
    const data = withDoc(d, () => extractDetail());
    if (!data.reviews_list.length) {
      for (let k = 1; k <= 4; k++) { w.scrollTo(0, d.documentElement.scrollHeight * k / 4); await sleep(450); }
      const head = withDoc(d, reviewHead);
      if (head) { head.scrollIntoView({ block: 'start' }); if (/^(BUTTON|A)$/.test(head.tagName)) head.click(); await sleep(1000); }
      withDoc(d, reviewMore)?.click();
      await sleep(1200);
      data.reviews_list = withDoc(d, findReviews);
    }
    return data;
  }
  async function runPreviewWorker() {
    // 미리보기용 숨은 창 안: 다 뜨면 읽어서 부모 탭에 보내고 끝.
    if (document.readyState !== 'complete') await new Promise((r) => addEventListener('load', r, { once: true }));
    let data = null;
    try { data = await readPreviewDoc(document, window); data.related = []; } catch {}
    try { parent.postMessage({ __mm: 'pv', id: window.name.slice(6), data }, '*'); } catch {}
  }

  const findItem = (id) => state.items.find((x) => x.id === id) || state.detail?.related?.find((x) => x.id === id) || state.starred[id];
  function openPreview(item) {
    state.pv = item.id;
    state.seen[item.id] = 1; store.set('mmSeen', state.seen);
    queuePreview(item);
    render();
  }
  function closePreview() { state.pv = null; render(); }
  function previewHtml(t) {
    const item = state.pv && findItem(state.pv);
    if (!item) return '';
    const p = previews.get(item.id) || { status: 'loading', data: item };
    const loading = p.status === 'loading';
    return `<div class="modal" data-act="close-pv"><div class="mbox" data-box>
      <div class="mhead"><b>${esc(t.name)} · 미리보기</b><span class="sp"></span>
        ${loading ? '<span class="spin">불러오는 중…</span>' : '<button data-act="pv-reload" title="다시 불러오기">⟳</button>'}
        <button data-act="pv-open" title="이 탭에서 열기">열기 ↗</button>
        <button data-act="pv-newtab" title="새 탭에서 열기">새 탭</button>
        <button data-act="close-pv" title="닫기 (Esc)">✕</button></div>
      ${p.note ? `<div class="mnote">${esc(p.note)}</div>` : ''}
      <div class="mbody">${t.detail(p.data)}</div></div></div>`;
  }

  // 목록 안에서 리뷰 펼치기: 리뷰 칸(💬 / 거래수 / 의견)을 누르면 그 줄 아래에 리뷰가 펼쳐져요.
  function rvLine(r) {
    const score = r.rating == null ? '' : (weakMode() ? `★${r.rating}` : disguise.clock(r));
    const when = r.date ? (state.template === 'mail' ? disguise.day(r.date) : ymd(r.date)) : (r.dateText || '');
    return `<div class="rvl"><b>${esc(r.author)}</b><span class="rvm">${esc(score)} ${esc(when)}</span><span class="rvt">${esc((r.body || []).join(' · ') || '(내용 없음)')}</span></div>`;
  }
  function inlineReviews() {
    for (const id of state.openRv) {
      const row = [...root.querySelectorAll('.main [data-id]')].find((x) => x.dataset.id === id && !x.closest('.modal'));
      if (!row) continue;
      const p = previews.get(id);
      let inner;
      if (!p || p.status === 'loading') inner = '<div class="rvl dim">리뷰 불러오는 중…</div>';
      else if (!p.data.reviews_list?.length) inner = `<div class="rvl dim">${esc(p.note || '리뷰를 찾지 못했어요.')}</div>`;
      else inner = p.data.reviews_list.slice(0, 5).map(rvLine).join('') + (p.data.reviews_list.length > 5 ? `<div class="rvl dim" data-rvmore="${esc(id)}">… ${p.data.reviews_list.length - 5}개 더 (눌러서 미리보기)</div>` : '');
      const box = row.tagName === 'TR'
        ? Object.assign(document.createElement('tr'), { className: 'xrow', innerHTML: `<td colspan="${row.children.length}">${inner}</td>` })
        : Object.assign(document.createElement('div'), { className: 'xrow', innerHTML: inner });
      row.after(box);
      row.classList.add('rvopen');
    }
  }
  function toggleRv(item) {
    if (state.openRv.has(item.id)) state.openRv.delete(item.id);
    else { state.openRv.add(item.id); queuePreview(item); }
    render();
  }
  function openAllRv() {
    // 화면 위쪽 10개만, 하나씩 차례로 불러와요.
    const list = visibleItems(sorted(state.items)).filter((f) => f.link).slice(0, 10);
    list.forEach((f) => { state.openRv.add(f.id); queuePreview(f); });
    render();
  }

  // ---------- 2-3. 진짜 이름: 위장한 메뉴·칸 이름에 마우스를 올리면 진짜 이름이 보이고, '원래 문구' 모드면 바로 바꿔 보여줘요 ----------
  const REAL = {
    // 메일함
    '받은편지함': '지금 보는 목록', '별표편지함': '별표한 상품', '중요편지함': '찜 목록', '보낸편지함': '주문·배송 목록',
    '임시보관함': '장바구니', '휴지통': '취소·반품', '전체보관함': '사이트 홈', '편지쓰기': '사이트 홈',
    '업무': '빠른배송', '공유': '무료배송', '참조': '광고',
    // 스프레드시트
    '발주내역': '지금 보는 목록', '출고': '주문·배송 목록', '임시': '장바구니', '관심': '찜 목록', '반품': '취소·반품', '요약': '사이트 홈',
    'No': '순서', '거래처': '판매자', '품목': '상품명', '단가': '가격', '할인(%)': '할인율(%)', '가중치': '평점',
    '거래수': '리뷰 수', '출고수': '판매수', '납기': '도착일', '비고': '상품 정보', '운임': '배송비·배송 종류',
    // 결재함
    '새 결재 진행': '사이트 홈', '결재 대기 문서': '지금 보는 목록', '중요 문서': '별표한 상품', '관심 문서': '찜 목록',
    '임시 저장 문서': '장바구니', '기안 문서함': '주문·배송 목록', '반려 문서함': '취소·반품', '전체 문서': '사이트 홈',
    '문서번호': '상품 번호', '제목': '상품명', '기안부서': '판매자', '금액': '가격', '의견': '리뷰 수', '조회': '판매수',
    '기안일': '도착일', '조정': '할인율(%)', '기안': '판매자', '첨부': '사진', '결재 의견': '리뷰',
  };
  function labelize() {
    const els = root.querySelectorAll('.fold, .compose, .tabs span, .hdr td, .appr thead th, td.k, .appr-info th, .lab, h4.sec');
    for (const el of els) {
      const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (!tn) continue;
      const raw = tn.textContent;
      const m = raw.match(/^(\s*[^\p{L}\p{N}(]*\s*)(.*?)(\d*)(\s*)$/u);
      if (!m) continue;
      // 예: '📥 받은편지함 ', '비고3', '의견2', '할인(%)'
      const key = m[2].trim();
      const name = m[3] && key === '의견' ? '리뷰' : REAL[key];
      if (!name) continue;
      if (state.labels === 'real') { el.title = `위장 이름: ${key}`; tn.textContent = m[1] + name + (m[3] ? ' ' + m[3] : '') + m[4]; }
      else el.title = `진짜: ${name}`;
    }
  }

  // ---------- 2-4. 사이트 정렬: 사이트가 가진 정렬 메뉴(추천순·낮은가격순·Best Match…)를 그대로 써요 ----------
  const SORT_RE = /^(.{1,10}\s?순|정확도|추천|랭킹|인기|최적\s*일치|곧\s*종료|새로\s*등록.*|best match|relevance|relevant|featured|recommended|most popular|popular|newest( arrivals)?|newly listed|ending soonest|time:.{0,20}|price.{0,30}(lowest|highest|low to high|high to low)|(lowest|highest) price.*|price:? (low|high).*|top rated|customer rating|avg\.? customer review|best ?sellers?|best selling|most reviews?|distance.*|가격.{0,20}(낮은|높은|최저|최고).*)$/i;
  const isOn = (e) => !!e && (e.matches('[aria-selected="true"],[aria-current]:not([aria-current="false"]),[aria-checked="true"],[aria-pressed="true"]')
    || /(^|[\s_-])(on|active|selected|current|checked|is-active|is-selected|is-checked|sel)([\s_-]|$)/i.test(String(e.className || ''))
    || !!e.querySelector?.('input:checked'));
  function siteSorts() {
    // 1) <select>로 된 정렬
    for (const sel of document.querySelectorAll('select')) {
      if (host?.contains(sel)) continue;
      const opts = [...sel.options];
      if (opts.filter((o) => SORT_RE.test(norm(o.text))).length < 3) continue;
      return opts.map((o) => ({ label: norm(o.text), on: o.selected, pick: () => { sel.value = o.value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); } }));
    }
    // 2) 링크·버튼 묶음으로 된 정렬 (숨은 드롭다운 안에 있어도 괜찮아요)
    const cands = [...document.querySelectorAll('a,button,label,[role="option"],[role="tab"],[role="radio"],[role="menuitem"],[role="menuitemradio"],li')]
      .filter((e) => !host?.contains(e) && e.children.length <= 4 && norm(e.textContent).length <= 24 && SORT_RE.test(norm(e.textContent)))
      // li 안에 링크·버튼이 있으면 안쪽 것을 써요
      .filter((e, _, arr) => !(e.tagName === 'LI' && arr.some((x) => x !== e && e.contains(x))));
    const groups = new Map();
    for (const e of cands) {
      const g = e.closest('ul,ol,[role="listbox"],[role="tablist"],[role="radiogroup"],[role="menu"]') || e.parentElement?.parentElement || e.parentElement;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    let best = null;
    for (const list of groups.values()) {
      const uniq = [...new Map(list.map((e) => [norm(e.textContent), e])).values()];
      if (uniq.length >= 3 && (!best || uniq.length > best.length)) best = uniq;
    }
    if (!best) return null;
    const out = best.map((e) => ({ label: norm(e.textContent), on: isOn(e) || isOn(e.parentElement), pick: () => e.click() }));
    {
      // 드롭다운 머리에 '지금 정렬' 글자가 보이면 그게 가장 정확해요.
      const shown = [...document.querySelectorAll('button,a,span,em,strong,div')]
        .find((e) => !host?.contains(e) && !best.some((b) => b.contains(e) || e.contains(b)) && !e.children.length && visible(e) && out.some((o) => o.label === norm(e.textContent)));
      if (shown) out.forEach((o) => { o.on = o.label === norm(shown.textContent); });
    }
    // 여러 메뉴 앞에 붙은 같은 낱말(대개 사이트 이름: '11번가 랭킹순', '11번가 인기순')은 위장할 때 빼요.
    const firsts = out.map((o) => o.label.split(' ')[0]).filter((w, i, a) => a.indexOf(w) !== i && out.some((o) => o.label.startsWith(w + ' ')));
    out.brand = firsts[0] || '';
    return out;
  }
  // 위장 모드에서는 정렬 이름도 업무 말로 바꿔 보여줘요 (마우스를 올리면 원래 이름)
  const SORT_WORDS = [[/낮은\s*가격|가격\s*낮은|최저가?/g, '금액 낮은'], [/높은\s*가격|가격\s*높은|최고가/g, '금액 높은'], [/가격/g, '금액'],
    [/판매\s*(량|많은)?|구매\s*많은|많이\s*팔린/g, '출고 많은'], [/리뷰|후기|상품평/g, '의견'], [/평점|별점|만족도/g, '가중치'],
    [/랭킹/g, '순위'], [/인기/g, '관심 많은'], [/추천|정확도|최적\s*일치/g, '기본'], [/최신|신상품|새로\s*등록/g, '최근 등록'], [/할인/g, '조정'],
    [/best match|relevance|featured|recommended|most popular|popular/gi, '기본'], [/price/gi, '금액'], [/newly listed|newest( arrivals)?/gi, '최근 등록'],
    [/top rated|customer rating|avg\.? customer review/gi, '가중치'], [/best ?sellers?|best selling/gi, '출고 많은'], [/most reviews?/gi, '의견 많은']];
  const siteName = () => [document.querySelector('meta[property="og:site_name"]')?.content, document.querySelector('meta[name="application-name"]')?.content,
    (origTitle.split(/\s[-|:·]\s/).pop() || '').split(/\s/)[0]].map((x) => norm(x || '')).filter((x) => x.length >= 2);
  const sortName = (t) => {
    if (state.labels === 'real') return t;
    for (const sn of [...siteName(), state.sorts?.brand].filter(Boolean)) t = t.split(sn).join(''); // '11번가 랭킹순' → '랭킹순' (사이트 이름은 숨겨요)
    return norm(SORT_WORDS.reduce((a, [re, w]) => a.replace(re, w), t)) || t;
  };

  function loadReviews() {
    // 사용자가 누를 때만: 원래 페이지의 리뷰 영역으로 내려가 '더보기'를 눌러요.
    const head = reviewHead();
    if (head) { head.scrollIntoView({ block: 'start' }); if (/^(BUTTON|A)$/.test(head.tagName)) head.click(); }
    else window.scrollTo(0, document.documentElement.scrollHeight * 0.6);
    setTimeout(() => {
      const more = reviewMore();
      more?.click();
      setTimeout(scan, 1200);
    }, 900);
  }

  // ---------- 3. 숫자 위장 ----------
  const disguise = {
    size(p, cur = curNow) { // 가격 → 첨부파일 크기 (1KB = 1,000원, 외화는 1KB = 1달러)
      if (p == null) return '';
      if (cur !== '원') p = p * 1000;
      if (p >= 1e6) return (p / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'MB';
      return (p / 1e3).toFixed(2).replace(/\.?0+$/, '') + 'KB';
    },
    clock(f) { // 평점 → 받은 시간 (4.8점 → 오후 4:48), 평점이 없고 실제 시간이 있으면 그 시간
      if (f.rating != null) {
        const r = f.ratingMax === 10 ? f.rating / 2 : f.rating;
        const h = Math.floor(r), d = Math.round((r - h) * 10);
        return `오후 ${h || 12}:${String(h * 10 + d).padStart(2, '0')}`;
      }
      if (f.time) { const [h, mm] = f.time.split(':').map(Number); return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(mm).padStart(2, '0')}`; }
      return '';
    },
    day(d) { return d ? `${d.getMonth() + 1}월 ${d.getDate()}일` : ''; },
    real(f) {
      const parts = [];
      if (f.price != null) parts.push(won(f.price, f.cur) + (f.orig ? ` (정가 ${won(f.orig, f.cur)})` : ''));
      if (f.discount) parts.push(`${f.discount}% 할인`);
      if (f.ship != null || f.shipTypes?.length) parts.push(['배송', ...(f.shipTypes || []), f.ship === 0 ? (f.shipCond ? '조건부 무료' : '무료') : f.ship != null ? won(f.ship, f.cur) : ''].filter(Boolean).join(' '));
      if (f.rating != null) parts.push(`평점 ${f.rating}${f.ratingMax === 10 ? '/10' : ''}`);
      if (f.reviews != null) parts.push(`리뷰 ${f.reviews.toLocaleString()}개`);
      if (f.sales != null) parts.push(`판매 ${count(f.sales, f.salesPlus)}`);
      if (f.date) parts.push(`날짜 ${f.date.getMonth() + 1}/${f.date.getDate()}`);
      if (f.time) parts.push(`시간 ${f.time}`);
      return parts.join(' · ') || '숫자 정보 없음';
    },
  };

  // ---------- 4. 템플릿 ----------
  const LABEL = { fast: ['업무', '#1a73e8'], free: ['공유', '#188038'], ad: ['참조', '#80868b'] };
  const labelHtml = (f) => {
    const types = (f.shipTypes || []).filter((n) => n !== '무료반품').slice(0, 2);
    const base = (f.labels || []).filter((l) => !(l === 'fast' && types.length)).map((l) => `<span class="lab" style="--c:${LABEL[l][1]}">${LABEL[l][0]}</span>`);
    return base.join('') + types.map((n) => `<span class="lab" style="--c:#5f6368" title="${esc(n)}">${esc(shipName(n))}</span>`).join('');
  };
  const thumb = (f, cls = 'th') => f.img && state.strength !== 'strong'
    ? `<img class="${cls}" src="${esc(f.img)}" data-big="${esc(f.img)}" alt="">`
    : (f.img ? `<span class="clip" data-big="${esc(f.img)}">📎</span>` : '');
  const tip = (f) => esc(f.title + '\n' + disguise.real(f));
  const weakMode = () => state.strength === 'weak';
  // 목록의 '지표' 칸: 리뷰 수·판매수 (숫자 그대로 모드에서는 평점까지 그대로)
  const metric = (f) => {
    const p = [];
    if (weakMode()) {
      if (f.rating != null) p.push(`<b class="mr">★${f.rating}</b>`);
      if (f.reviews != null) p.push(`<span data-rv="${f.id}" title="눌러서 리뷰 펼치기">리뷰 ${count(f.reviews)}</span>`);
      if (f.sales != null) p.push(`판매 ${count(f.sales, f.salesPlus)}`);
    } else {
      if (f.reviews != null) p.push(`<span data-rv="${f.id}" title="눌러서 리뷰 펼치기">💬 ${count(f.reviews)}</span>`);
      if (f.sales != null) p.push(`<span title="판매">👁 ${count(f.sales, f.salesPlus)}</span>`);
    }
    return p.join(' ');
  };
  const ymd = (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
  const factsFor = (f) => (f.facts || []).filter((x) => weakMode() || !/리뷰|후기|상품평|구매|판매|평점|별점|★/.test(x));
  const gallery = (f) => (f.gallery && f.gallery.length ? f.gallery : (f.img ? [f.img] : []));
  const visibleItems = (arr) => (state.ads === 'hide' ? arr.filter((f) => !(f.labels || []).includes('ad')) : arr);
  const relatedBlock = (f, title, listFn) => {
    const rel = visibleItems(f.related || []);
    if (!rel.length || state.related === 'hide') return '';
    return state.related === 'collapse'
      ? `<details class="rel"><summary>${title} ${rel.length}</summary>${listFn(rel)}</details>`
      : `<div class="rel"><h4>${title} ${rel.length}</h4>${listFn(rel)}</div>`;
  };
  const showReviews = (f) => f.isProduct && state.reviews !== 'hide';
  const starBtn = (f) => `<span class="star ${state.starred[f.id] ? 'on' : ''}" data-star="${f.id}">${state.starred[f.id] ? '★' : '☆'}</span>`;

  const sheetTabs = () => {
    const m = state.menu || {};
    const tab = (k, label) => (m[k] ? `<span class="${menuHere(m[k]) ? 'on' : ''}" data-go="${esc(m[k])}">${label}</span>` : '');
    const anyOn = ['orders', 'cart', 'wish', 'cancel'].some((k) => m[k] && menuHere(m[k]));
    return `<div class="tabs"><span class="${anyOn ? '' : 'on'}">발주내역</span>${tab('orders', '출고')}${tab('cart', '임시')}${tab('wish', '관심')}${tab('cancel', '반품')}<span data-go="${esc(m.home || '/')}">요약</span><span>+</span></div>`;
  };

  const templates = {
    mail: {
      name: '메일함',
      tabTitle: (n) => `받은편지함 (${n}) - 메일`,
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="6" width="28" height="20" rx="3" fill="#4a7bd0"/><path d="M3 8l13 10L29 8" stroke="#fff" stroke-width="2.5" fill="none"/></svg>',
      // 받은편지함=지금 목록, 별표=내 별표(이 PC), 전체=사이트 홈, 보낸=주문·배송, 임시=장바구니, 중요=찜, 휴지통=취소·반품
      sidebar: (n, s, m) => `
        <button class="compose" data-go="${esc(m.home)}">✏️ 편지쓰기</button>
        <a class="fold ${state.folder === 'inbox' ? 'on' : ''}" data-folder="inbox">📥 받은편지함 <b>${n || ''}</b></a>
        <a class="fold ${state.folder === 'starred' ? 'on' : ''}" data-folder="starred">⭐ 별표편지함 <b>${s}</b></a>
        ${goFold('wish', '🏷️ 중요편지함', m)}
        ${goFold('orders', '📤 보낸편지함', m)}
        ${goFold('cart', '📝 임시보관함', m)}
        ${goFold('cancel', '🗑️ 휴지통', m)}
        <a class="fold" data-go="${esc(m.home)}">📁 전체보관함</a>
        <div class="fold-h">라벨</div><a class="fold">🔵 업무</a><a class="fold">🟢 공유</a><a class="fold">⚪ 참조</a>`,
      list(items) {
        const weak = weakMode();
        return `<div class="mail">${items.map((f) => {
          const subj = `${f.discount ? `<span class="pre">[${f.discount}]</span> ` : ''}<span class="sub">${esc(f.title)}</span>${f.preview ? `<span class="pv"> — ${esc(f.preview)}</span>` : ''}`;
          return `<div class="row ${state.seen[f.id] ? 'read' : ''} ${f.soldOut ? 'dim' : ''}" data-id="${f.id}" title="${tip(f)}">
            <input type="checkbox" class="ck">${starBtn(f)}
            <span class="snd">${esc(f.sender)}</span>
            <span class="subj">${labelHtml(f)}${subj}</span>
            <span class="met">${metric(f)}</span>
            <span class="att">${thumb(f)}${weak ? `<i class="realp">${won(f.price)}</i>` : (f.price != null ? `<i>${disguise.size(f.price)}</i>` : '')}</span>
            <span class="dt">${disguise.day(f.date)}</span>
            <span class="tm">${weak ? (f.time || '') : disguise.clock(f)}</span>
          </div>`;
        }).join('')}</div>`;
      },
      detail(f) {
        const weak = weakMode();
        const g = gallery(f);
        const atts = g.map((src, i) => `<div class="attc" data-big="${esc(src)}">${state.strength === 'strong' ? '<span class="fi">🖼</span>' : `<img src="${esc(src)}" data-big="${esc(src)}" alt="">`}
            <div class="an"><b>IMG_${1001 + i}.jpg</b><small>${i === 0 && f.price != null ? (weak ? won(f.price) : disguise.size(f.price)) : '이미지'}</small></div></div>`).join('');
        const replies = (f.reviews_list || []).map((r) => `<div class="reply">
            <div class="av">${esc((r.author || '?')[0])}</div>
            <div class="rb"><div class="rh"><b>${esc(r.author)}</b><span>${r.date ? disguise.day(r.date) : esc(r.dateText)} ${r.rating != null ? (weak ? '★' + r.rating : disguise.clock(r)) : ''}</span></div>
            ${r.body.map((p) => `<p>${esc(p)}</p>`).join('')}
            ${r.photos.length ? `<div class="rp">${r.photos.map((src) => state.strength === 'strong' ? `<span class="clip" data-big="${esc(src)}">📎</span>` : `<img class="th" src="${esc(src)}" data-big="${esc(src)}" alt="">`).join('')}</div>` : ''}</div></div>`).join('');
        return `<div class="read-view">
          <div class="rv-bar"><button data-act="back">← 받은편지함</button><span class="sp"></span>${starBtn(f)}<button>보관</button><button>삭제</button></div>
          <h2>${f.discount ? `<span class="pre">[${f.discount}]</span> ` : ''}${esc(f.title)} ${labelHtml(f)}</h2>
          <div class="from"><div class="av big">${esc((f.sender || '?')[0])}</div>
            <div class="who"><b>${esc(f.sender)}</b> <span class="addr">&lt;noreply@team.local&gt;</span><div class="to">받는사람: 나 · 참조: 구매팀</div></div>
            <div class="when">${disguise.day(f.date) || '오늘'} ${weak ? (f.rating != null ? '★' + f.rating : '') : disguise.clock(f)}<div class="met">${metric(f)}</div></div></div>
          <div class="body">
            <p>안녕하세요, ${esc(f.sender)}입니다.</p><p>요청하신 건 관련 내용 공유드립니다.</p>
            ${weak && f.price != null ? `<p><b>${won(f.price)}</b>${f.orig ? ` <s>${won(f.orig)}</s>` : ''}${f.discount ? ` (${f.discount}% 할인)` : ''}</p>` : ''}
            ${factsFor(f).length ? `<ul>${factsFor(f).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
            ${(f.body || []).map((p) => `<p>${esc(p)}</p>`).join('')}
            <p>확인 부탁드립니다.<br>감사합니다.</p>
          </div>
          ${atts ? `<div class="atts"><div class="atts-h">첨부 ${g.length}개${f.price != null && !weak ? ' · ' + disguise.size(f.price) : ''}</div><div class="attg">${atts}</div></div>` : ''}
          <div class="reply-bar"><button>↩ 답장</button><button>↪ 전달</button></div>
          ${showReviews(f) ? `<div class="replies"><h4>답장 ${(f.reviews_list || []).length}${f.reviews != null ? ` <small>/ 전체 ${count(f.reviews)}</small>` : ''}</h4>
            ${replies || '<p class="none">아직 불러온 답장이 없어요.</p>'}
            <button class="morebtn" data-act="reviews">이전 답장 더 보기</button></div>` : ''}
          ${relatedBlock(f, '관련 메일', (x) => templates.mail.list(x))}
        </div>`;
      },
    },

    sheet: {
      name: '스프레드시트',
      tabTitle: () => '2026 발주내역_최종.xlsx - 스프레드시트',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="4" y="3" width="24" height="26" rx="2" fill="#2e8b57"/><path d="M9 10h14M9 15h14M9 20h14M16 8v16" stroke="#fff" stroke-width="2"/></svg>',
      sidebar: () => '',
      list(items) {
        const cols = ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
        const head = ['No', '거래처', '품목', '단가', '운임', '할인(%)', '가중치', '거래수', '출고수', '납기'];
        const weak = weakMode();
        return `<div class="sheet"><div class="fx"><span>fx</span><input value="=SUMPRODUCT(D2:D${items.length + 1},(1-E2:E${items.length + 1}/100))" readonly></div>
          <table><colgroup><col style="width:40px"><col style="width:44px"><col style="width:120px"><col><col style="width:90px"><col style="width:96px"><col style="width:66px"><col style="width:62px"><col style="width:74px"><col style="width:74px"><col style="width:96px"></colgroup>
          <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>
          <tr class="hdr"><th>1</th>${head.map((h) => `<td>${h}</td>`).join('')}</tr></thead><tbody>
          ${items.map((f, i) => `<tr class="${f.soldOut ? 'dim' : ''}" data-id="${f.id}" title="${tip(f)}"><th>${i + 2}</th>
            <td>${i + 1}</td><td>${esc(f.sender)}</td><td class="item">${thumb(f, 'th s')}${esc(f.title)}</td>
            <td class="n">${f.price != null ? (weak ? won(f.price) : f.price.toLocaleString()) : ''}</td>
            <td>${shipCell(f)}</td>
            <td class="n">${f.discount ?? ''}</td><td class="n">${f.rating ?? ''}</td>
            <td class="n" data-rv="${f.id}" title="눌러서 의견 펼치기">${f.reviews != null ? f.reviews.toLocaleString() : '▸'}</td>
            <td class="n">${f.sales != null ? count(f.sales, f.salesPlus) : ''}</td>
            <td>${f.date ? ymd(f.date) : (f.time || '')}</td></tr>`).join('')}
          </tbody></table>${sheetTabs()}</div>`;
      },
      detail(f) {
        const rows = [['품목', f.title], ['거래처', f.sender], ['단가', f.price?.toLocaleString()], ['운임', shipCell(f)], ['할인(%)', f.discount], ['가중치', f.rating], ['거래수', f.reviews?.toLocaleString()], ['출고수', f.sales != null ? count(f.sales, f.salesPlus) : ''], ['납기', ymd(f.date)],
          ...factsFor(f).map((p, i) => [`비고${i + 1}`, p]),
          ...(state.reviews === 'hide' ? [] : (f.reviews_list || [])).map((r, i) => [`의견${i + 1}`, `${r.author} | ${r.rating ?? ''} | ${r.body.join(' ')}`])];
        const g = gallery(f);
        return `<div class="sheet"><div class="fx"><span>fx</span><input value="=VLOOKUP(B1,발주내역!A:I,3,FALSE)" readonly></div>
          <table><colgroup><col style="width:40px"><col style="width:120px"><col></colgroup><thead><tr><th></th><th>A</th><th>B</th></tr></thead><tbody>
          ${rows.map((r, i) => `<tr><th>${i + 1}</th><td class="k">${esc(r[0])}</td><td>${i === 0 ? g.map((src) => thumb({ img: src }, 'th s')).join('') : ''}${esc(r[1] ?? '')}</td></tr>`).join('')}
          </tbody></table>
          <div class="sheet-act"><button data-act="back">← 발주내역</button>${showReviews(f) ? '<button data-act="reviews">의견 더 불러오기</button>' : ''}</div>
          ${relatedBlock(f, '관련 품목', (x) => templates.sheet.list(x))}</div>`;
      },
    },

    approval: {
      name: '결재함',
      tabTitle: (n) => `결재 대기 (${n}) - 전자결재`,
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="5" y="3" width="22" height="26" rx="2" fill="#6b5bd6"/><path d="M10 17l4 4 8-9" stroke="#fff" stroke-width="3" fill="none"/></svg>',
      sidebar: (n, s, m) => `
        <button class="compose" data-go="${esc(m.home)}">📝 새 결재 진행</button>
        <div class="fold-h">결재하기</div>
        <a class="fold ${state.folder === 'inbox' ? 'on' : ''}" data-folder="inbox">결재 대기 문서 <b>${n || ''}</b></a>
        <a class="fold ${state.folder === 'starred' ? 'on' : ''}" data-folder="starred">중요 문서 <b>${s}</b></a>
        ${goFold('wish', '관심 문서', m)}
        ${goFold('cart', '임시 저장 문서', m)}
        <div class="fold-h">개인 문서함</div>
        ${goFold('orders', '기안 문서함', m)}
        ${goFold('cancel', '반려 문서함', m)}
        <a class="fold" data-go="${esc(m.home)}">전체 문서</a>`,
      list(items) {
        const weak = weakMode();
        const st = (f) => f.soldOut ? '<span class="stt done">반려</span>' : (state.seen[f.id] ? '<span class="stt ing">진행</span>' : '<span class="stt new">대기</span>');
        return `<div class="appr"><table><thead><tr><th></th><th>문서번호</th><th>제목</th><th>기안부서</th><th>금액</th><th>운임</th><th>의견</th><th>조회</th><th>기안일</th><th>상태</th></tr></thead><tbody>
          ${items.map((f) => `<tr class="${state.seen[f.id] ? 'read' : ''}" data-id="${f.id}" title="${tip(f)}">
            <td>${starBtn(f)}</td>
            <td class="mono">구매-${String(f.id).slice(0, 4)}-${String(f.id).slice(-4)}</td>
            <td class="tt">${thumb(f, 'th s')}[구매요청] ${esc(f.title)}${f.discount ? ` <em>(조정 ${f.discount}%)</em>` : ''}</td>
            <td>${esc(f.sender)}</td>
            <td class="n">${f.price != null ? (weak ? won(f.price) : f.price.toLocaleString()) : '-'}</td>
            <td>${shipCell(f)}</td>
            <td class="n" data-rv="${f.id}" title="눌러서 의견 펼치기">${f.reviews != null ? count(f.reviews) : '▸'}</td>
            <td class="n">${f.sales != null ? count(f.sales, f.salesPlus) : ''}</td>
            <td>${f.date ? disguise.day(f.date) : ''} ${f.rating != null ? `<small>${weak ? '★' + f.rating : disguise.clock(f)}</small>` : ''}</td>
            <td>${st(f)}</td></tr>`).join('')}</tbody></table></div>`;
      },
      detail(f) {
        const weak = weakMode();
        const opinions = (f.reviews_list || []).map((r) => `<tr><td>${esc(r.author)}</td><td>${r.date ? disguise.day(r.date) : esc(r.dateText)} ${r.rating != null ? `<small>${weak ? '★' + r.rating : disguise.clock(r)}</small>` : ''}</td><td class="op">${esc(r.body.join(' '))} ${r.photos.map((src) => thumb({ img: src }, 'th s')).join('')}</td></tr>`).join('');
        return `<div class="read-view">
          <div class="rv-bar"><button data-act="back">← 결재 대기 문서</button><span class="sp"></span>${starBtn(f)}<button>결재</button><button>반려</button></div>
          <h2>[구매요청] ${esc(f.title)}</h2>
          <table class="appr-line"><tr><th>기안</th><th>검토</th><th>승인</th></tr><tr><td>${esc(f.sender)}</td><td>대기</td><td>대기</td></tr></table>
          <table class="appr-info"><tr><th>금액</th><td>${f.price != null ? (weak ? won(f.price) : f.price.toLocaleString()) : '-'}</td><th>조정</th><td>${f.discount ?? 0}%</td></tr>
            <tr><th>의견</th><td>${f.reviews != null ? count(f.reviews) : '-'}</td><th>조회</th><td>${f.sales != null ? count(f.sales, f.salesPlus) : '-'}</td></tr>
            <tr><th>기안일</th><td>${disguise.day(f.date) || '-'} ${weak ? (f.rating != null ? '★' + f.rating : '') : disguise.clock(f)}</td><th>첨부</th><td>${gallery(f).map((src) => thumb({ img: src }, 'th s')).join('')}</td></tr></table>
          <div class="body">${factsFor(f).length ? `<ul>${factsFor(f).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${(f.body || []).map((p) => `<p>${esc(p)}</p>`).join('')}</div>
          ${showReviews(f) ? `<h4 class="sec">결재 의견 ${(f.reviews_list || []).length}</h4><div class="appr"><table><tbody>${opinions || '<tr><td>아직 불러온 의견이 없어요.</td></tr>'}</tbody></table></div><button class="morebtn" data-act="reviews">의견 더 불러오기</button>` : ''}
          ${relatedBlock(f, '관련 문서', (x) => templates.approval.list(x))}
        </div>`;
      },
    },
  };

  // ---------- 5. 화면 그리기 ----------
  let host, root, saved = null;

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .app{position:fixed;inset:0;z-index:2147483647;background:#f6f8fc;color:#202124;font:13px/1.4 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;display:grid;grid-template-columns:220px 1fr;grid-template-rows:56px 1fr}
  .app.nosb{grid-template-columns:0 1fr}
  .top{grid-column:1/3;display:flex;align-items:center;gap:12px;padding:0 16px;background:#f6f8fc}
  .logo{display:flex;align-items:center;gap:8px;font-size:18px;color:#5f6368;width:200px}
  .logo svg{width:28px;height:28px}
  .search{flex:1;max-width:680px;display:flex;align-items:center;background:#e9eef6;border-radius:24px;padding:0 14px;height:44px}
  .search input{flex:1;border:0;background:transparent;font:inherit;font-size:15px;outline:none;padding:0 8px}
  .off{border:0;background:none;font-size:18px;color:#5f6368;cursor:pointer;padding:4px 8px;border-radius:50%}.off:hover{background:#e8eaed}
  select{font:inherit;border:1px solid #dadce0;border-radius:6px;background:#fff;padding:5px 6px;color:#3c4043}
  .side{padding:8px 8px 8px 12px;overflow:auto}
  .compose{background:#c2e7ff;border:0;border-radius:16px;padding:16px 22px;font:inherit;font-size:14px;margin:0 0 12px;cursor:default}
  .fold{display:flex;justify-content:space-between;padding:6px 14px;border-radius:0 16px 16px 0;color:#202124;cursor:pointer;text-decoration:none}
  .fold.on{background:#d3e3fd;font-weight:700}
  .fold.nf{color:#9aa0a6;cursor:default}
  .compose[data-go]{cursor:pointer}
  .tabs span[data-go]{cursor:pointer}.tabs span[data-go]:hover{background:#e8eaed}
  .fold-h{padding:14px 14px 4px;font-size:12px;color:#5f6368}
  .main{background:#fff;border-radius:16px;margin:0 16px 16px 0;overflow:auto;position:relative}
  .bar{position:sticky;top:0;background:#fff;display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid #eee;z-index:2;color:#5f6368}
  .bar .sp{flex:1}
  .bar button{border:0;background:none;font:inherit;color:#5f6368;cursor:pointer;padding:4px 8px;border-radius:4px}
  .bar button:hover{background:#f1f3f4}
  .row{display:grid;grid-template-columns:22px 22px 150px 1fr calc(var(--th,20px) + 108px) 100px 56px 66px;align-items:center;gap:6px;padding:4px 14px;min-height:40px;border-bottom:1px solid #f1f3f4;cursor:pointer;font-weight:700;background:#fff}
  .row.read{font-weight:400;background:#f2f6fc}
  .row:hover{box-shadow:inset 1px 0 #dadce0,inset -1px 0 #dadce0,0 1px 2px rgba(60,64,67,.3);z-index:1;position:relative}
  .row>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .snd i{font-style:normal;color:#5f6368;font-weight:400}
  .pv{color:#5f6368;font-weight:400}
  .pre{color:#5f6368}
  .star{color:#c4c7c5;cursor:pointer;font-size:16px}.star.on{color:#f4b400}
  .lab{display:inline-block;font-size:11px;font-weight:400;color:#fff;background:var(--c);border-radius:4px;padding:0 5px;margin-right:6px;line-height:16px}
  .att{display:flex;align-items:center;gap:6px;justify-content:flex-end;color:#5f6368;font-weight:400}.att i{font-style:normal}
  .dt,.tm{text-align:right;font-size:12px}
  .th{width:var(--th,20px);height:var(--th,20px);object-fit:cover;border-radius:3px;filter:grayscale(1);opacity:.55;border:1px solid #ddd}
  .th.s{width:calc(var(--th,20px) - 4px);height:calc(var(--th,20px) - 4px);vertical-align:middle;margin-right:6px}
  .th2{width:18px;height:18px;object-fit:cover;filter:grayscale(1);opacity:.6;vertical-align:-4px}
  .clip{cursor:zoom-in}
  .dim{opacity:.45}
  .modal{position:fixed;inset:0;z-index:5;background:rgba(32,33,36,.38);display:grid;place-items:center}
  .mbox{width:min(1040px,90vw);height:86vh;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden}
  .mhead{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #e3e3e3;background:#f8f9fa;color:#3c4043}
  .mhead .sp{flex:1}.mhead button{border:1px solid #dadce0;background:#fff;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer}.mhead button:hover{background:#f1f3f4}
  .spin{color:#5f6368;font-size:12px;padding:0 6px}
  .mnote{padding:6px 14px;background:#fef7e0;color:#7a5a00;font-size:12px}
  .mbody{flex:1;overflow:auto;padding:12px}
  .mbody .rel{display:none}
  [data-rv]{cursor:pointer;text-decoration:underline dotted #9aa0a6;text-underline-offset:3px}[data-rv]:hover{color:#1a73e8}
  .rvopen [data-rv]{color:#1a73e8;font-weight:700}
  div.xrow{padding:4px 14px 8px 64px;background:#fbfbfb;border-bottom:1px solid #f1f3f4;font-weight:400}
  tr.xrow td{background:#fbfbfb!important;white-space:normal!important;padding:4px 10px 6px 48px!important;height:auto!important}
  .rvl{display:flex;gap:10px;align-items:baseline;padding:2px 0;font-size:12px;color:#3c4043;line-height:1.5}
  .rvl b{flex:none;min-width:70px;font-weight:700}.rvm{flex:none;color:#5f6368;min-width:110px}.rvt{flex:1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .rvl.dim{color:#80868b}[data-rvmore]{cursor:pointer}
  .pop{position:fixed;z-index:9;pointer-events:none;background:#fff;border:1px solid #dadce0;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:6px;display:none}
  .pop img{display:block;max-width:var(--zoom,320px);max-height:var(--zoom,320px);object-fit:contain}
  .pop .cap{max-width:var(--zoom,320px);font-size:12px;color:#3c4043;padding:6px 2px 0;white-space:pre-line}
  .more{padding:18px;text-align:center;color:#5f6368}
  .more button{border:1px solid #dadce0;background:#fff;border-radius:16px;padding:6px 16px;font:inherit;cursor:pointer;margin:0 4px}
  .empty{padding:60px;text-align:center;color:#5f6368}
  .read-view{padding:20px 28px}.read-view h2{font-size:22px;font-weight:400;margin:4px 0 14px}
  .meta{color:#5f6368;margin-bottom:18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .att2{border:1px solid #dadce0;border-radius:6px;padding:3px 8px}
  .body p{margin:0 0 10px;max-width:820px}
  .reply-bar{margin:14px 0 6px}
  .reply-bar button{border:1px solid #747775;border-radius:18px;background:#fff;padding:8px 20px;margin-right:8px;font:inherit}
  .met{font-size:12px;color:#5f6368;font-weight:400;text-align:right}.met span{margin-left:8px}.mr{color:#e37400}
  .rv-bar{display:flex;align-items:center;gap:6px;margin:-8px -12px 10px;padding:6px 8px;border-bottom:1px solid #f1f3f4;position:sticky;top:0;background:#fff;z-index:2}
  .rv-bar .sp{flex:1}.rv-bar button{border:0;background:none;font:inherit;color:#444;padding:6px 10px;border-radius:6px;cursor:pointer}.rv-bar button:hover{background:#f1f3f4}
  .from{display:flex;align-items:flex-start;gap:12px;margin-bottom:18px}
  .av{flex:none;width:32px;height:32px;border-radius:50%;background:#e8eaed;color:#3c4043;display:grid;place-items:center;font-weight:700;font-size:13px}
  .av.big{width:40px;height:40px;background:#c2e7ff;color:#0b57d0;font-size:16px}
  .who{flex:1}.addr{color:#5f6368;font-size:12px}.to{color:#5f6368;font-size:12px;margin-top:2px}
  .when{color:#5f6368;font-size:12px;text-align:right;white-space:nowrap}.when .met{margin-top:4px}
  .body ul{margin:0 0 12px;padding-left:20px;color:#3c4043}.body li{margin:2px 0}
  .atts{border-top:1px solid #f1f3f4;padding-top:12px;margin-top:8px}.atts-h{color:#5f6368;font-size:12px;margin-bottom:8px}
  .attg{display:flex;flex-wrap:wrap;gap:8px}
  .attc{display:flex;align-items:center;gap:8px;border:1px solid #dadce0;border-radius:8px;padding:6px 10px 6px 6px;cursor:zoom-in;min-width:180px}
  .attc img{width:calc(var(--th,20px) + 14px);height:calc(var(--th,20px) + 14px);object-fit:cover;border-radius:4px;filter:grayscale(1);opacity:.6}
  .attc .fi{font-size:22px;width:34px;text-align:center}
  .an b{display:block;font-weight:400;font-size:12px}.an small{color:#5f6368;font-size:11px}
  .replies{border-top:1px solid #f1f3f4;margin-top:14px;padding-top:6px}
  .replies h4,.rel h4,.sec{font-size:14px;font-weight:700;margin:12px 0 8px}.replies h4 small{font-weight:400;color:#5f6368}
  .reply{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #f1f3f4}
  .rb{flex:1}.rh{display:flex;justify-content:space-between;color:#5f6368;font-size:12px;margin-bottom:4px}.rh b{color:#202124;font-size:13px}
  .rb p{margin:0 0 4px;max-width:820px}.rp{display:flex;gap:6px;margin-top:4px}
  .none{color:#5f6368}
  .morebtn{border:1px solid #dadce0;background:#fff;border-radius:16px;padding:6px 16px;font:inherit;cursor:pointer;margin:10px 0}
  details.rel summary{cursor:pointer;padding:10px 28px;color:#5f6368;font-size:13px}details.rel[open] summary{font-weight:700;color:#202124}
  .rel{margin:18px -28px 0;border-top:8px solid #f6f8fc;padding-top:4px}.rel h4{padding:0 28px}
  .sheet-act{padding:8px;display:flex;gap:6px}.sheet-act button{border:1px solid #dadce0;background:#fff;border-radius:4px;padding:4px 10px;font:inherit;cursor:pointer}
  .appr-info{border-collapse:collapse;margin:0 0 14px;width:100%;max-width:760px}.appr-info th{background:#f4f5f8;width:90px;text-align:left}.appr-info th,.appr-info td{border:1px solid #e3e3e3;padding:6px 10px}
  .op{white-space:normal!important}
  /* 스프레드시트 */
  .sheet{font:12px Arial,"Malgun Gothic",sans-serif}
  .fx{display:flex;align-items:center;border-bottom:1px solid #e0e0e0;padding:4px 8px;gap:8px;color:#5f6368}.fx input{flex:1;border:0;font:inherit;outline:none}
  .sheet table{border-collapse:collapse;width:100%;table-layout:fixed}
  .sheet th{background:#f8f9fa;color:#5f6368;font-weight:400;border:1px solid #e0e0e0;width:40px;height:22px}
  .sheet thead tr:first-child th:nth-child(n+2){width:auto}
  .sheet td{border:1px solid #e2e2e2;padding:2px 6px;height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sheet tr.hdr td{font-weight:700;background:#e6f4ea}
  .sheet td.n{text-align:right;font-variant-numeric:tabular-nums}
  .sheet td.item{width:40%}
  .sheet td.k{background:#f8f9fa;font-weight:700;width:120px}
  .sheet tbody tr{cursor:pointer}.sheet tbody tr:hover td{background:#e8f0fe}
  .tabs{position:sticky;bottom:0;background:#f8f9fa;border-top:1px solid #e0e0e0;padding:4px 8px;display:flex;gap:2px}
  .tabs span{padding:4px 14px;color:#5f6368}.tabs span.on{background:#fff;color:#188038;font-weight:700;border-bottom:2px solid #188038}
  /* 결재함 */
  .appr table{border-collapse:collapse;width:100%}
  .appr th{background:#f4f5f8;border-top:2px solid #6b5bd6;border-bottom:1px solid #ddd;padding:8px;font-weight:700;color:#444;text-align:left}
  .appr td{border-bottom:1px solid #eee;padding:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px}
  .appr tr{cursor:pointer}.appr tbody tr:hover td{background:#f5f3ff}
  .appr tr.read td{color:#666}
  .appr .mono{font-family:Consolas,monospace;color:#555}
  .appr td.n{text-align:right;font-variant-numeric:tabular-nums}
  .appr em{font-style:normal;color:#888}
  .stt{border-radius:10px;padding:1px 8px;font-size:11px}.stt.new{background:#fff1e6;color:#d9480f}.stt.ing{background:#e7f5ff;color:#1971c2}.stt.done{background:#f1f3f5;color:#868e96}
  .appr-line{border-collapse:collapse;margin:0 0 14px}.appr-line th,.appr-line td{border:1px solid #ccc;padding:6px 18px;text-align:center}
  `;

  function ensureHost() {
    // 사이트가 화면을 다시 그리면서 우리 화면을 떼어 버리면 다시 붙여요.
    if (host) { if (!host.isConnected) document.documentElement.appendChild(host); return; }
    host = document.createElement('div');
    host.id = 'mm-host';
    root = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
    root.addEventListener('click', onClick);
    root.addEventListener('mouseover', onHover);
    root.addEventListener('mousemove', onMove);
    root.addEventListener('mouseout', (e) => { if (e.target.dataset?.big) hidePop(); });
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('q')) doSearch(e.target.value); });
    root.addEventListener('scroll', onScroll, true);
  }

  function setTab(t) {
    if (!saved) saved = { title: document.title, icons: [...document.querySelectorAll('link[rel~="icon"]')].map((l) => [l, l.href]) };
    const want = t.tabTitle(state.items.filter((f) => !state.seen[f.id]).length || state.items.length || 3);
    if (document.title !== want) document.title = want;
    let link = document.getElementById('mm-favicon');
    if (!link) {
      saved.icons.forEach(([l]) => l.setAttribute('href', 'data:,'));
      link = document.createElement('link'); link.id = 'mm-favicon'; link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = 'data:image/svg+xml,' + encodeURIComponent(t.icon);
  }

  function restoreTab() {
    if (!saved) return;
    document.title = saved.title;
    saved.icons.forEach(([l, h]) => l.setAttribute('href', h));
    document.getElementById('mm-favicon')?.remove();
    saved = null;
  }

  function sorted(items) {
    const a = [...items];
    const key = { price: (f) => f.price ?? Infinity, rating: (f) => -(f.rating ?? -1), date: (f) => f.date?.getTime() ?? Infinity }[state.sort];
    return key ? a.sort((x, y) => key(x) - key(y)) : a;
  }

  function render() {
    if (!state.on) return;
    ensureHost();
    const t = templates[state.template];
    const starredList = Object.values(state.starred);
    const showing = state.folder === 'starred' ? starredList.map((s) => ({ ...s, date: s.date ? new Date(s.date) : null })) : visibleItems(sorted(state.items));
    state.menu = siteMenu();
    state.sorts = siteSorts();
    // 사이트가 '지금 정렬'을 표시하지 않으면, 이 탭에서 마지막으로 고른 정렬을 보여줘요.
    try {
      const last = JSON.parse(sessionStorage.getItem('__mm_sort:' + location.pathname) || 'null');
      if (state.sorts && last && last.from !== location.href && state.sorts.some((o) => o.label === last.label)) {
        state.sorts.forEach((o) => { o.on = o.label === last.label; });
      }
    } catch {}
    const sb = t.sidebar(state.items.length, starredList.length, state.menu);
    const mainScroll = root.querySelector('.main')?.scrollTop || 0;
    const pvScroll = root.querySelector('.mbody')?.scrollTop || 0;
    const qVal = root.querySelector('.q')?.value;
    const nextLink = findNext();

    let content;
    if (state.folder !== 'starred' && !state.items.length && state.detail) content = t.detail(state.detail);
    else if (!showing.length) content = `<div class="empty">${state.folder === 'starred' ? '별표한 항목이 없어요.' : '이 페이지에서 목록을 찾지 못했어요. 스크롤하거나 새로고침하면 다시 찾아요.'}</div>`;
    else content = t.list(showing) + (state.folder === 'inbox' ? `<div class="more">${showing.length}개 · <button data-act="loadmore">더 불러오기</button>${nextLink ? '<button data-act="next">다음 페이지 ›</button>' : ''}</div>` : '');

    root.innerHTML = `<style>${CSS}</style>
      <div class="app ${sb ? '' : 'nosb'}" style="--th:${state.thumb}px;--zoom:${state.zoom}px">
        <div class="top"><div class="logo">${t.icon}<span>${t.name}</span></div>
          <div class="search">🔍<input class="q" placeholder="${t.name}에서 검색" value="${esc(qVal ?? currentQuery())}"></div>
          <select data-set="template">${Object.entries(templates).map(([k, v]) => `<option value="${k}" ${k === state.template ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
          <select data-set="strength"><option value="weak" ${state.strength === 'weak' ? 'selected' : ''}>숫자 그대로</option><option value="normal" ${state.strength === 'normal' ? 'selected' : ''}>숫자 위장</option><option value="strong" ${state.strength === 'strong' ? 'selected' : ''}>이미지도 숨김</option></select>
          <select data-set="wheel" title="원래 화면에서 휠을 굴리면 바로 이 화면으로 바뀌어요. 진짜 스크롤은 Shift+휠."><option value="1" ${state.wheel ? 'selected' : ''}>휠 전환 켬</option><option value="" ${state.wheel ? '' : 'selected'}>휠 전환 끔</option></select>
          <button class="off" data-act="panel" title="설정 패널 열기 (Alt+Shift+S)">⚙</button>
          <button class="off" data-act="disarm" title="이 사이트에서 끄기">⏻</button>
        </div>
        <div class="side">${sb}</div>
        <div class="main"><div class="bar"><span>☐</span><button data-act="refresh">⟳</button>${state.items.length ? `<button data-act="rv-all" title="위쪽 10개의 리뷰를 차례로 불러와 펼쳐요">💬 ${state.template === 'mail' ? '답장' : '의견'} 펼치기</button>${state.openRv.size ? '<button data-act="rv-close">접기</button>' : ''}` : ''}<span class="sp"></span>
          ${state.sorts ? `<select data-set="sitesort" title="사이트의 정렬을 그대로 써요">${state.sorts.map((o, i) => `<option value="${i}" ${o.on ? 'selected' : ''} title="${esc(o.label)}">${esc(sortName(o.label))}</option>`).join('')}</select>` : ''}
          <select data-set="sort" ${state.sorts ? 'hidden' : ''}><option value="default">기본 정렬</option><option value="price" ${state.sort === 'price' ? 'selected' : ''}>${state.template === 'mail' ? '크기순' : '금액순'}</option><option value="rating" ${state.sort === 'rating' ? 'selected' : ''}>${state.template === 'mail' ? '시간순' : '가중치순'}</option><option value="date" ${state.sort === 'date' ? 'selected' : ''}>날짜순</option></select>
        </div>${content}</div>
        ${previewHtml(t)}
        <div class="pop"><img alt=""><div class="cap"></div></div>
      </div>`;
    inlineReviews();
    labelize();
    const m = root.querySelector('.main'); if (m) m.scrollTop = mainScroll;
    const mb = root.querySelector('.mbody'); if (mb) mb.scrollTop = pvScroll;
    setTab(t);
  }

  // ---------- 6. 동작 ----------
  function currentQuery() {
    const u = new URL(location.href);
    for (const k of ['q', 'query', 'keyword', 'searchKeyword', 'search', 'kwd']) if (u.searchParams.get(k)) return u.searchParams.get(k);
    return '';
  }

  function siteSearchInput() {
    return [...document.querySelectorAll('input[type="search"],input[name="q"],input[name="query"],input[name="keyword"],input[placeholder*="검색"],input[title*="검색"]')]
      .find((i) => !host?.contains(i) && i.offsetParent !== null) || document.querySelector('input[type="search"],input[name="q"],input[name="query"],input[name="keyword"]');
  }

  function doSearch(q) {
    q = norm(q); if (!q) return;
    const inp = siteSearchInput();
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, q);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      if (inp.form) { inp.form.requestSubmit ? inp.form.requestSubmit() : inp.form.submit(); return; }
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return;
    }
    const u = new URL(location.href);
    for (const k of ['q', 'query', 'keyword']) if (u.searchParams.has(k)) { u.searchParams.set(k, q); location.href = u.href; return; }
  }

  function findNext() {
    return document.querySelector('a[rel="next"]') || [...document.querySelectorAll('a,button')].find((a) => /^(다음|다음\s*페이지|next|›|>)$/i.test(norm(a.textContent)) && !host?.contains(a));
  }

  function loadMore() {
    // 사용자가 누를 때만: 원래 페이지를 맨 아래로 내려서 사이트가 다음 목록을 불러오게 해요.
    window.scrollTo(0, document.documentElement.scrollHeight);
    const btn = [...document.querySelectorAll('button,a')].find((b) => /^(더\s*보기|더보기|more|load more)$/i.test(norm(b.textContent)) && b.offsetParent !== null);
    if (btn) btn.click();
    setTimeout(scan, 1200);
  }

  async function onClick(e) {
    const s = e.target.closest('[data-star]');
    if (s) {
      e.stopPropagation();
      const id = s.dataset.star;
      if (state.starred[id]) delete state.starred[id];
      else {
        const f = state.items.find((x) => x.id === id) || state.detail?.related?.find((x) => x.id === id) || (state.detail?.id === id ? state.detail : null);
        if (f) state.starred[id] = { ...f, date: f.date ? f.date.getTime() : null, body: undefined, facts: undefined, gallery: undefined, reviews_list: undefined, related: undefined };
      }
      await store.set('mmStarred', state.starred); render(); return;
    }
    const go = e.target.closest('[data-go]');
    if (go) { location.href = go.dataset.go; return; }
    const f = e.target.closest('[data-folder]');
    if (f) { state.folder = f.dataset.folder; render(); return; }
    const actEl = e.target.closest('[data-act]');
    let act = actEl?.dataset.act;
    if (e.target.closest('.modal')) {
      // 미리보기 안: 바깥(어두운 곳)·✕·'목록으로'를 누르면 닫혀요.
      if (act === 'close-pv' && actEl.classList.contains('modal') && e.target.closest('[data-box]')) act = null;
      if (act === 'close-pv' || act === 'back') return closePreview();
      const it = state.pv && findItem(state.pv);
      if (act === 'pv-open' && it?.link) { location.href = it.link; return; }
      if (act === 'pv-newtab' && it?.link) { window.open(it.link, '_blank'); return; }
      if ((act === 'pv-reload' || act === 'reviews') && it) { queuePreview(it, true); return; }
      return; // 미리보기 안의 다른 곳은 아무 동작 없음
    }
    const rv = e.target.closest('[data-rv],[data-rvmore]');
    if (rv) {
      const it = findItem(rv.dataset.rv || rv.dataset.rvmore);
      if (it?.link) { if (rv.dataset.rvmore) openPreview(it); else toggleRv(it); }
      return;
    }
    if (e.target.closest('.xrow')) return;
    if (act === 'rv-all') return openAllRv();
    if (act === 'rv-close') { state.openRv.clear(); render(); return; }
    if (act === 'refresh') return scan();
    if (act === 'back') { history.back(); return; }
    if (act === 'reviews') return loadReviews();
    if (act === 'disarm') return disarm();
    if (act === 'panel') { if (hasChrome) chrome.runtime.sendMessage({ type: 'mm-open-panel' }).catch(() => {}); return; }
    if (act === 'loadmore') return loadMore();
    if (act === 'next') { findNext()?.click(); setTimeout(scan, 1500); return; }
    const row = e.target.closest('[data-id]');
    if (row && !e.target.classList.contains('ck')) {
      const id = row.dataset.id;
      const item = state.items.find((x) => x.id === id) || state.detail?.related?.find((x) => x.id === id) || state.starred[id];
      if (!item?.link) return;
      if (e.ctrlKey || e.metaKey) { state.seen[id] = 1; store.set('mmSeen', state.seen); window.open(item.link, '_blank'); return; }
      // 기본: 들어가지 않고 미리보기 팝업. (패널에서 '바로 열기'로 바꿀 수 있어요)
      if (state.rowClick !== 'open') return openPreview(item);
      state.seen[id] = 1; store.set('mmSeen', state.seen);
      location.href = item.link;
    }
  }

  async function onChange(e) {
    const k = e.target.dataset.set;
    if (!k) return;
    const v = k === 'wheel' ? !!e.target.value : e.target.value;
    if (k === 'sitesort') {
      // 사이트의 정렬 메뉴를 대신 눌러 줘요. 페이지가 바뀌면 다시 읽어요.
      const o = state.sorts?.[+v];
      try { if (o) sessionStorage.setItem('__mm_sort:' + location.pathname, JSON.stringify({ label: o.label, from: location.href })); } catch {}
      o?.pick();
      setTimeout(scan, 1500);
      return;
    }
    if (k === 'sort') state.sort = v; else await saveSetting(k, v);
    render();
  }

  function pop() { return root.querySelector('.pop'); }
  function onHover(e) {
    const el = e.target.closest('[data-big]');
    if (!el) return;
    const p = pop(); if (!p) return;
    p.querySelector('img').src = el.dataset.big;
    const row = el.closest('[data-id]');
    p.querySelector('.cap').textContent = row?.getAttribute('title') || '';
    p.style.display = 'block';
    onMove(e);
  }
  function onMove(e) {
    const p = pop(); if (!p || p.style.display !== 'block') return;
    const z = state.zoom + 20; const x = Math.max(8, Math.min(e.clientX + 18, innerWidth - z)), y = Math.max(8, Math.min(e.clientY + 12, innerHeight - z - 60));
    p.style.left = x + 'px'; p.style.top = Math.max(8, y) + 'px';
  }
  function hidePop() { const p = pop(); if (p) p.style.display = 'none'; }

  let scrollTimer;
  function onScroll(e) {
    const m = e.target;
    hidePop();
    if (!m.classList?.contains('main') || state.folder !== 'inbox') return;
    if (m.scrollTop + m.clientHeight > m.scrollHeight - 80) {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(loadMore, 300); // 목록 끝까지 내리면 원래 페이지도 같이 내려요
    }
  }

  // ---------- 7. 스캔 & 켜기/끄기 ----------
  function scan() {
    if (!state.on) return;
    if (isDetailPage()) {
      // 상세 페이지: 상품 하나를 메일 본문으로, 리뷰는 답장, 관련 상품은 관련 메일
      state.items = [];
      state.detail = extractDetail();
      curNow = state.detail.cur || '원';
      render();
      return;
    }
    const cards = findCards();
    const seen = new Set();
    state.items = fixSenders(cards.map((c) => extractFields(c)).filter((f) => f.title && !seen.has(f.id) && seen.add(f.id)));
    state.detail = state.items.length ? null : extractDetail();
    // 이 페이지의 통화 (가장 많이 나온 것)
    const cc = {}; state.items.forEach((f) => f.cur && (cc[f.cur] = (cc[f.cur] || 0) + 1));
    curNow = Object.keys(cc).sort((a, b) => cc[b] - cc[a])[0] || state.detail?.cur || '원';
    render();
  }

  // 설정: 전체 설정 위에 이 사이트만의 설정(있으면)을 덮어요.
  const CFG_KEYS = ['template', 'strength', 'wheel', 'related', 'ads', 'reviews', 'thumb', 'zoom', 'rowClick', 'labels', 'quickKey', 'escHide'];
  const globalCfg = { template: 'sheet', strength: 'normal', wheel: true, related: 'show', ads: 'show', reviews: 'show', thumb: 45, zoom: 380, rowClick: 'preview', labels: 'disguise', quickKey: 'Backquote', escHide: true };
  let siteCfg = null;
  function applyCfg() {
    const c = { ...globalCfg, ...(siteCfg || {}) };
    state.template = templates[c.template] ? c.template : 'sheet';
    state.strength = c.strength;
    state.wheel = c.wheel !== false;
    state.related = c.related || 'show'; // show | collapse | hide
    state.ads = c.ads || 'show';         // show | hide
    state.reviews = c.reviews || 'show'; // show | hide
    state.thumb = Math.min(120, Math.max(14, +c.thumb || 45)); // 목록 썸네일 px
    state.zoom = Math.min(700, Math.max(160, +c.zoom || 380));  // 마우스 올렸을 때 px
    state.rowClick = c.rowClick === 'open' ? 'open' : 'preview'; // 줄 클릭: 미리보기 | 바로 열기
    state.labels = c.labels === 'real' ? 'real' : 'disguise';   // 메뉴·칸 이름: 위장 | 원래 문구
    state.quickKey = c.quickKey === 'off' ? 'off' : 'Backquote'; // ` 키 하나로 전환
    state.escHide = c.escHide !== false;                          // Esc로 숨기기
  }
  async function saveSetting(k, v) {
    if (siteCfg) { siteCfg = { ...siteCfg, [k]: v }; await store.set('mmSite:' + ORIGIN, siteCfg); }
    else { globalCfg[k] = v; await store.set('mm_' + k, v); }
    applyCfg();
  }

  // armed = 이 사이트에서 켜 둠, state.on = 지금 위장 화면을 보여주는 중
  let armed = false;
  let mo, moTimer, titleTimer;

  function showDisguise() {
    if (state.on) return;
    state.on = true;
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    scan();
    mo = new MutationObserver((muts) => {
      if (host && !host.isConnected) { document.documentElement.appendChild(host); render(); }
      if (muts.every((m) => (host && host.contains(m.target)) || m.target === document.documentElement)) return;
      clearTimeout(moTimer); moTimer = setTimeout(scan, state.detail ? 1500 : 700);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    mo.observe(document.documentElement, { childList: true });
    titleTimer = setInterval(() => {
      if (!state.on) return;
      if (host && !host.isConnected) { document.documentElement.appendChild(host); render(); }
      setTab(templates[state.template]); // SPA가 제목을 바꿔도 다시 덮어요
    }, 1000);
  }

  function showReal() {
    if (!state.on) return;
    state.on = false;
    mo?.disconnect(); clearInterval(titleTimer); hidePop();
    host?.remove(); host = null; root = null;
    document.documentElement.style.removeProperty('overflow');
    restoreTab();
  }

  async function arm() { armed = true; await store.set('mmOn:' + ORIGIN, true); showDisguise(); }
  async function disarm() { armed = false; showReal(); await store.set('mmOn:' + ORIGIN, false); }

  // 단축키: 꺼져 있으면 켜고 위장 화면으로, 켜져 있으면 위장 화면 ↔ 원래 화면
  if (!IS_TOP) { runPreviewWorker(); return; }

  // 페이지를 옮기면(뒤로 가기, 주소만 바뀌는 사이트 포함) 켜 둔 사이트는 다시 위장 화면으로 시작해요.
  let lastHref = location.href;
  const backToDisguise = () => {
    if (!armed) return;
    state.pv = null; state.openRv.clear();
    if (!state.on) showDisguise(); else { ensureHost(); scan(); }
  };
  window.addEventListener('pageshow', (e) => { if (e.persisted) { lastHref = location.href; backToDisguise(); } });
  window.addEventListener('popstate', () => setTimeout(() => { lastHref = location.href; backToDisguise(); }, 50));
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; backToDisguise(); } }, 800);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.on && state.pv) closePreview(); }, true);
  // 빠른 키: 글자를 치는 중이 아닐 때 ` 키 하나로 위장 ↔ 원래, Esc는 원래 화면에서 바로 숨기기
  const typing = (e) => { const t = e.composedPath?.()[0] || e.target; return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); };
  document.addEventListener('keydown', (e) => {
    if (!armed || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || typing(e)) return;
    if (state.quickKey !== 'off' && e.code === 'Backquote') {
      e.preventDefault(); e.stopPropagation();
      if (state.on) showReal(); else showDisguise();
      return;
    }
    if (e.key === 'Escape' && state.escHide && !state.on) showDisguise();
  }, true);

  // 시험용(확장프로그램이 아닌 곳에 직접 넣었을 때만): 내부를 들여다볼 수 있게
  if (!hasChrome) window.__mmDebug = { findCards, extractFields, fixSenders, extractDetail, isDetailPage, siteSorts, siteMenu, state };

  window.__mmToggle = () => (!armed ? arm() : state.on ? showReal() : showDisguise());

  // 휠 전환 옵션: 원래 화면에서 그냥 휠을 굴리면 바로 위장 화면으로 바뀌어요.
  // 진짜 스크롤은 Shift+휠. 윈도우에서는 Shift+휠이 가로 스크롤이라 세로로 바꿔서 내려요.
  window.addEventListener('wheel', (e) => {
    if (!armed || state.on || !state.wheel) return;
    if (e.ctrlKey) return; // Ctrl+휠 확대/축소는 그대로
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      const d = e.deltaY || e.deltaX;
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1;
      window.scrollBy({ top: d * unit, left: 0, behavior: 'auto' });
    } else {
      showDisguise();
    }
  }, { capture: true, passive: false });

  if (hasChrome && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg?.type === 'mm-toggle') window.__mmToggle();
      // 사이드패널이 물어보면 지금 상태를 알려줘요.
      if (msg?.type === 'mm-status') reply({ site: ORIGIN, armed, showing: state.on, count: state.items.length });
      if (msg?.type === 'mm-view') { if (msg.disguise) showDisguise(); else showReal(); reply({ ok: true }); }
    });
  }

  // 사이드패널에서 설정을 바꾸면 storage가 바뀌고, 열려 있는 모든 탭이 바로 따라가요.
  if (hasChrome && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      const key = 'mmOn:' + ORIGIN;
      if (key in ch) {
        const v = !!ch[key].newValue;
        if (v && !armed) { armed = true; showDisguise(); }
        if (!v && armed) { armed = false; showReal(); }
      }
      let changed = false;
      for (const k of CFG_KEYS) if (ch['mm_' + k]) { globalCfg[k] = ch['mm_' + k].newValue; changed = true; }
      if (('mmSite:' + ORIGIN) in ch) { siteCfg = ch['mmSite:' + ORIGIN].newValue || null; changed = true; }
      if (changed) applyCfg();
      if (ch.mmStarred) state.starred = ch.mmStarred.newValue || {};
      if (changed && state.on) render();
    });
  }

  (async () => {
    for (const k of CFG_KEYS) globalCfg[k] = await store.get('mm_' + k, globalCfg[k]);
    siteCfg = await store.get('mmSite:' + ORIGIN, null);
    applyCfg();
    state.starred = await store.get('mmStarred', {});
    state.seen = await store.get('mmSeen', {});
    // 이 사이트에서 켜 둔 채로 다른 페이지로 넘어가면 위장 화면으로 바로 시작해요.
    if (await store.get('mmOn:' + ORIGIN, false)) arm();
  })();
})();
