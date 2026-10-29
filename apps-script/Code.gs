/**
 * 연앤필 총관리 — Apps Script 웹앱
 *
 * 시트에 연결된 스크립트(확장 프로그램 > Apps Script)에 이 파일 내용을 그대로 붙여넣는다.
 * 토큰은 코드에 쓰지 않는다. 프로젝트 설정 > 스크립트 속성에 저장한다.
 *   TOKEN_MEMBER  : 멤버 2명용 (필수)
 *   TOKEN_SESSION : 세션 전용 창용 (2단계, 없으면 session 요청은 전부 거부)
 *
 * 요청: GET {웹앱주소}?token=...&scope=member[&nocache=1]
 */

const EXPORT_TABS = ['일정', '할일', '회의록', '정산', '공연장', '아이디어', '곡', '세트리스트'];
const ID_HEADERS = ['ID', '곡ID'];
const DATE_HEADERS = ['날짜', '마감일'];
const TIME_HEADERS = ['시작시간', '집합시간'];
const NUMBER_HEADERS = ['금액', '수용인원', '순서', 'BPM'];
const CACHE_SECONDS = 60;

function doGet(e) {
  const p = (e && e.parameter) || {};
  const scope = p.scope === 'session' ? 'session' : 'member';
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty(scope === 'session' ? 'TOKEN_SESSION' : 'TOKEN_MEMBER');

  if (!expected || !p.token || p.token !== expected) {
    return jsonOut_({ ok: false, error: 'unauthorized' });
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'resp_' + scope;
  if (p.nocache !== '1') {
    const cached = cache.get(cacheKey);
    if (cached) return textOut_(cached);
  }

  let body;
  try {
    body = JSON.stringify(scope === 'session' ? buildSession_() : buildMember_());
  } catch (err) {
    return jsonOut_({ ok: false, error: 'server', message: String(err && err.message || err) });
  }

  try { cache.put(cacheKey, body, CACHE_SECONDS); } catch (err) { /* 100KB 넘으면 캐시 생략 */ }
  return textOut_(body);
}

/* ---------- 멤버용 응답 ---------- */

function buildMember_() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();

  const data = {};
  const gids = {};
  EXPORT_TABS.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) { data[name] = []; return; }
    gids[name] = sheet.getSheetId();
    data[name] = readTab_(sheet, tz);
  });

  const setting = ss.getSheetByName('설정');
  const members = setting
    ? [setting.getRange('B4').getDisplayValue().trim(), setting.getRange('B5').getDisplayValue().trim()]
    : ['멤버1', '멤버2'];
  const links = {
    sheet: ss.getUrl(),
    drive: setting ? safeUrl_(setting.getRange('B11').getDisplayValue()) : '',
    etc: setting ? safeUrl_(setting.getRange('B12').getDisplayValue()) : ''
  };

  return {
    ok: true,
    updatedAt: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    members: members,
    links: links,
    gids: gids,
    data: data,
    summary: readSummary_(ss)
  };
}

function readSummary_(ss) {
  const sheet = ss.getSheetByName('정산요약');
  const empty = { monthIncome: 0, monthExpense: 0, commonBalance: 0, burden1: 0, burden2: 0, transferText: '', transferAmount: 0 };
  if (!sheet) return empty;
  const v = sheet.getRange('B4:B14').getValues().map(function (r) { return r[0]; });
  // v[0]=B4 ... v[10]=B14
  return {
    monthIncome: toNumber_(v[0]),
    monthExpense: toNumber_(v[1]),
    commonBalance: toNumber_(v[4]),
    burden1: toNumber_(v[5]),
    burden2: toNumber_(v[6]),
    transferText: String(v[9] || '').trim(),
    transferAmount: toNumber_(v[10])
  };
}

/* ---------- 세션용 응답 (2단계) ---------- */

function buildSession_() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const isOpen = function (r) { return String(r['세션공개']).toUpperCase() === 'O'; };
  const read = function (name) {
    const s = ss.getSheetByName(name);
    return s ? readTab_(s, tz) : [];
  };

  const schedule = read('일정')
    .filter(function (r) { return isOpen(r) && r['날짜'] && r['날짜'] >= today; })
    .map(function (r) { return pick_(r, ['ID', '종류', '날짜', '시작시간', '집합시간', '장소', '공연장ID']); });

  const songs = {};
  read('곡').forEach(function (s) { songs[s['곡ID']] = s; });

  const setlist = read('세트리스트')
    .filter(isOpen)
    .map(function (r) {
      const s = songs[r['곡ID']] || {};
      return {
        ID: r['ID'], 공연ID: r['공연ID'], 순서: r['순서'], 곡ID: r['곡ID'], 파트메모: r['파트메모'],
        곡명: s['곡명'] || r['곡명'] || '', 키: s['키'] || '', BPM: s['BPM'] || '', 길이: s['길이'] || '',
        악보링크: s['악보링크'] || '', 음원링크: s['음원링크'] || ''
      };
    });

  const venues = read('공연장')
    .filter(isOpen)
    .map(function (r) { return pick_(r, ['ID', '이름', '지역']); });

  return {
    ok: true,
    updatedAt: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    data: { 일정: schedule, 세트리스트: setlist, 공연장: venues }
  };
}

/* ---------- 공통 ---------- */

function readTab_(sheet, tz) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const idIndex = headers.findIndex(function (h) { return ID_HEADERS.indexOf(h) >= 0; });
  const rows = [];

  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (idIndex >= 0 && String(raw[idIndex]).trim() === '') continue;
    const obj = {};
    headers.forEach(function (h, c) {
      if (!h) return;
      obj[h] = convert_(h, raw[c], tz);
    });
    obj._row = i + 1;
    rows.push(obj);
  }
  return rows;
}

function convert_(header, v, tz) {
  if (v === '' || v === null || v === undefined) return '';

  if (TIME_HEADERS.indexOf(header) >= 0) {
    if (isDate_(v)) return Utilities.formatDate(v, tz, 'HH:mm');
    return normalizeTime_(String(v));
  }
  if (DATE_HEADERS.indexOf(header) >= 0) {
    if (isDate_(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return normalizeDate_(String(v));
  }
  if (NUMBER_HEADERS.indexOf(header) >= 0) {
    const n = toNumber_(v);
    return n === null ? String(v).trim() : n;
  }
  if (isDate_(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return String(v).trim();
}

// 텍스트로 입력된 시간 보정: "19:30", "7:30", "오후 7:30", "7:30 PM"
function normalizeTime_(s) {
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return s.trim();
  let h = Number(m[1]);
  if (/(오후|pm)/i.test(s) && h < 12) h += 12;
  if (/(오전|am)/i.test(s) && h === 12) h = 0;
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}

// 텍스트로 입력된 날짜 보정: "2026-11-5", "2026.11.05", "2026/11/05"
function normalizeDate_(s) {
  const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return s.trim();
  const pad = function (x) { return (Number(x) < 10 ? '0' : '') + Number(x); };
  return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[,원\s]/g, ''));
  return isNaN(n) || String(v).trim() === '' ? null : n;
}

function pick_(obj, keys) {
  const out = {};
  keys.forEach(function (k) { out[k] = obj[k] === undefined ? '' : obj[k]; });
  return out;
}

function safeUrl_(s) {
  s = String(s || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function jsonOut_(obj) { return textOut_(JSON.stringify(obj)); }
function textOut_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 설치 도우미 ---------- */

/**
 * 편집기에서 이 함수를 한 번 실행하면 TOKEN_MEMBER가 없을 때 새로 만들어
 * 실행 로그(보기 > 로그)에 보여준다. 이미 있으면 기존 값을 보여준다.
 */
function setupToken() {
  const props = PropertiesService.getScriptProperties();
  let t = props.getProperty('TOKEN_MEMBER');
  if (!t) {
    t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('TOKEN_MEMBER', t);
  }
  Logger.log('TOKEN_MEMBER = ' + t);
}

/** 배포 전에 응답 모양을 확인하는 테스트. 실행 로그에 JSON 앞부분이 찍힌다. */
function testBuild() {
  const s = JSON.stringify(buildMember_(), null, 2);
  Logger.log(s.slice(0, 4000));
  Logger.log('전체 길이: ' + s.length + '자');
}
