// 확장프로그램을 진짜로 띄워서 사이트마다 위장 화면이 어떻게 나오는지 재는 도구예요.
// content.js 를 페이지에 넣어 보는 것과 달리, 실제로 쓰는 것과 같은 경로로 돌아가요.
//
//   node tools/run-ext.mjs                 모두
//   node tools/run-ext.mjs 사람인 엔카      이름에 걸리는 것만
//   node tools/run-ext.mjs --url <주소> --key <도메인>
//
// playwright 가 필요해요: npm i -D playwright  (또는 PLAYWRIGHT=<경로>)

import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

// 켜 둘 사이트와 열어 볼 주소. 둘째 칸은 사이트 키(도메인)예요.
const SITES = [
  ['사람인 검색', 'saramin.co.kr', 'https://www.saramin.co.kr/zf_user/search?searchword=개발자'],
  ['사람인 직업별', 'saramin.co.kr', 'https://www.saramin.co.kr/zf_user/jobs/list/job-category'],
  ['잡코리아 검색', 'jobkorea.co.kr', 'https://www.jobkorea.co.kr/Search/?stext=개발자'],
  ['원티드 목록', 'wanted.co.kr', 'https://www.wanted.co.kr/wdlist/518'],
  ['SK엔카 목록', 'encar.com', 'https://www.encar.com/dc/dc_carsearchlist.do?carType=kor'],
  ['K Car 검색', 'kcar.com', 'https://www.kcar.com/bc/search'],
  ['트립닷컴 항공', 'trip.com', 'https://kr.trip.com/flights/seoul-to-tokyo/tickets-sel-tyo?ddate=2026-12-10'],
];

async function loadPlaywright() {
  const tries = [
    process.env.PLAYWRIGHT,
    'playwright',
    path.join(homedir(), 'ClaudeProjects/store-apps/node_modules/playwright/index.js'),
  ].filter(Boolean);
  for (const t of tries) {
    try { const m = await import(t); return m.chromium || m.default?.chromium; } catch {}
  }
  console.error('playwright 를 찾지 못했어요. npm i -D playwright 하거나 PLAYWRIGHT=<경로> 로 알려 주세요.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const url = flag('--url');
const sites = url
  ? [['직접 지정', flag('--key') || new URL(url).hostname.split('.').slice(-2).join('.'), url]]
  : (argv.length ? SITES.filter(([n]) => argv.some((a) => n.includes(a))) : SITES);
if (!sites.length) { console.error('그 이름에 걸리는 사이트가 없어요.'); process.exit(1); }

const chromium = await loadPlaywright();
const profile = await mkdtemp(path.join(tmpdir(), 'mm-run-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, locale: 'ko-KR', viewport: { width: 1280, height: 950 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
// 열어 볼 사이트를 미리 켜 둬요 (패널을 손으로 누르는 것과 같은 효과)
await sw.evaluate(async (keys) => {
  const o = {}; for (const k of keys) o['mmOn:' + k] = true;
  await chrome.storage.local.set(o);
}, [...new Set(sites.map((s) => s[1]))]);

const page = ctx.pages()[0] || await ctx.newPage();
for (const [name, , site] of sites) {
  try {
    await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(Number(process.env.WAIT || 9000));
    const r = await page.evaluate(() => {
      const h = document.getElementById('mm-host');
      if (!h) return { on: false };
      const sr = h.shadowRoot;
      const head = [...sr.querySelectorAll('tr.hdr td')].map((t) => t.textContent.trim());
      const rows = [...sr.querySelectorAll('tbody tr')];
      const cells = (tr) => [...tr.querySelectorAll('td')].map((t) => t.textContent.trim());
      return {
        on: true,
        view: sr.querySelector('.loading') ? '불러오는 중'
          : sr.querySelector('.sheet') ? '목록'
          : sr.querySelector('.read-view') ? '상세'
          : sr.querySelector('.empty') ? '빈 화면' : '?',
        head, rows: rows.length,
        filled: head.map((_, i) => rows.filter((tr) => cells(tr)[i]).length),
        sample: rows.slice(0, 2).map((tr) => cells(tr).map((c) => c.slice(0, 18))),
      };
    });
    if (!r.on) { console.log(`\n■ ${name}\n  위장 화면이 안 떴어요 (꺼져 있거나 목록을 못 찾음)`); continue; }
    console.log(`\n■ ${name} — ${r.view} · ${r.rows}줄`);
    if (r.head.length) {
      console.log('  칸   ' + r.head.map((h, i) => `${h} ${r.filled[i]}/${r.rows}`).join(' · '));
      r.sample.forEach((s) => console.log('  줄   ' + s.join(' | ')));
    }
  } catch (e) {
    console.log(`\n■ ${name}\n  실패: ${String(e).slice(0, 100)}`);
  }
}
await ctx.close();
await rm(profile, { recursive: true, force: true });
