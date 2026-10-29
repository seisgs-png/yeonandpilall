/* 연앤필 총관리 대시보드 — 읽기 전용
 * 데이터: Apps Script 웹앱(JSON) → 화면 렌더링
 * 수정은 각 카드의 [수정] 버튼으로 구글 시트에서 한다.
 */
(function () {
  'use strict';

  var CFG = window.CONFIG || {};
  var KEY = { token: 'yf_token', cache: 'yf_cache', todo: 'yf_todo_filter', idea: 'yf_idea_filter' };
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  var state = {
    data: null,        // 마지막으로 받은 응답
    loading: false,
    failed: false,     // 마지막 요청 실패 여부
    showPast: false,
    gateError: ''
  };

  var $app = document.getElementById('app');
  var $title = document.getElementById('page-title');
  var $banner = document.getElementById('banner');
  var $tabbar = document.getElementById('tabbar');

  /* ---------- 저장소 (실패해도 동작) ---------- */
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } }
  function remove(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } }

  /* ---------- 유틸 ---------- */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeHref(u) {
    u = String(u || '').trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }
  function ymd(d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function todayStr() { return ymd(new Date()); }
  function daysFromToday(s) {
    var d = parseYmd(s); if (!d) return null;
    var t = parseYmd(todayStr());
    return Math.round((d - t) / 86400000);
  }
  function fmtDate(s) {
    var d = parseYmd(s); if (!d) return esc(s);
    var md = (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEK[d.getDay()] + ')';
    return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '/' + md;
  }
  function dLabel(s) {
    var n = daysFromToday(s);
    if (n === null) return '';
    if (n === 0) return '오늘';
    if (n === 1) return '내일';
    if (n > 0) return 'D-' + n;
    return Math.abs(n) + '일 지남';
  }
  function won(n) {
    n = Number(n) || 0;
    return n.toLocaleString('ko-KR') + '원';
  }
  function ago(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return '';
    var min = Math.floor((Date.now() - t) / 60000);
    if (min < 1) return '방금 갱신';
    if (min < 60) return min + '분 전 갱신';
    var h = Math.floor(min / 60);
    if (h < 24) return h + '시간 전 갱신';
    return Math.floor(h / 24) + '일 전 갱신';
  }
  function rows(tab) { return (state.data && state.data.data && state.data.data[tab]) || []; }
  function members() { return (state.data && state.data.members) || ['멤버1', '멤버2']; }
  function links() { return (state.data && state.data.links) || {}; }
  function byId(tab, idKey) {
    var map = {}; idKey = idKey || 'ID';
    rows(tab).forEach(function (r) { map[r[idKey]] = r; });
    return map;
  }
  function sortSchedule(a, b) {
    return (a['날짜'] + (a['시작시간'] || '99:99')).localeCompare(b['날짜'] + (b['시작시간'] || '99:99'));
  }

  function editLink(tab, row) {
    var l = links(), gids = (state.data && state.data.gids) || {};
    if (!safeHref(l.sheet) || gids[tab] === undefined) return '';
    var base = l.sheet.split('#')[0];
    var href = base + '#gid=' + gids[tab] + (row ? '&range=A' + row : '');
    return '<a class="edit" href="' + esc(href) + '" target="_blank" rel="noopener">수정</a>';
  }
  function sheetTabHref(tab) {
    var l = links(), gids = (state.data && state.data.gids) || {};
    if (!safeHref(l.sheet)) return '';
    return l.sheet.split('#')[0] + (gids[tab] !== undefined ? '#gid=' + gids[tab] : '');
  }
  function linkBtn(url, label, cls) {
    var h = safeHref(url); if (!h) return '';
    return '<a class="btn small ' + (cls || '') + '" href="' + esc(h) + '" target="_blank" rel="noopener">' + esc(label) + '</a>';
  }
  function empty(text) { return '<div class="empty">' + esc(text) + '</div>'; }
  function sectionTitle(text, moreHref, moreLabel) {
    return '<div class="section-title"><span>' + esc(text) + '</span>' +
      (moreHref ? '<a href="' + esc(moreHref) + '">' + esc(moreLabel || '전체') + ' ›</a>' : '') + '</div>';
  }
  function chips(options, current, attr) {
    return '<div class="chips" role="group">' + options.map(function (o) {
      return '<button class="chip" type="button" data-' + attr + '="' + esc(o) + '" aria-pressed="' + (o === current) + '">' + esc(o) + '</button>';
    }).join('') + '</div>';
  }

  /* ---------- 데이터 ---------- */
  function apiUrl(token, nocache) {
    var u = CFG.APPS_SCRIPT_URL || '';
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token) +
      '&scope=member' + (nocache ? '&nocache=1' : '') + '&_=' + Date.now();
  }

  function request(token, nocache) {
    return fetch(apiUrl(token, nocache), { method: 'GET', redirect: 'follow', cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  function refresh(nocache) {
    var token = load(KEY.token);
    if (!token) { render(); return; }
    state.loading = true;
    renderStatus();
    request(token, nocache).then(function (json) {
      state.loading = false;
      if (!json || json.ok !== true) {
        if (json && json.error === 'unauthorized') {
          remove(KEY.token);
          state.gateError = '토큰이 바뀌었거나 맞지 않아요. 다시 입력해 주세요.';
          render();
          return;
        }
        throw new Error((json && json.message) || 'server');
      }
      state.data = json;
      state.failed = false;
      save(KEY.cache, JSON.stringify(json));
      render();
    }).catch(function () {
      state.loading = false;
      state.failed = true;
      render();
    });
  }

  /* ---------- 공통 화면 요소 ---------- */
  function renderBanner() {
    if (state.failed && state.data) {
      var sheet = safeHref(links().sheet);
      $banner.innerHTML = '<span>최신 데이터를 못 불러왔어요. 마지막 내용을 보여주고 있어요.</span>' +
        (sheet ? '<a href="' + esc(sheet) + '" target="_blank" rel="noopener">시트 열기</a>' : '');
      $banner.hidden = false;
    } else {
      $banner.hidden = true;
      $banner.innerHTML = '';
    }
  }

  function statusHtml() {
    var when = state.data ? ago(state.data.updatedAt) : '';
    return '<div class="footer-status" id="status">' +
      (state.loading ? '<span><span class="spinner"></span> 불러오는 중</span>' : '<span>' + esc(when) + '</span>') +
      '<button class="btn small" type="button" data-action="refresh"' + (state.loading ? ' disabled' : '') + '>새로고침</button></div>';
  }
  function renderStatus() {
    var el = document.getElementById('status');
    if (el) el.outerHTML = statusHtml();
  }

  /* ---------- 카드 ---------- */
  function scheduleCard(r, venues) {
    var kind = r['종류'] || '기타';
    var venue = r['공연장ID'] && venues[r['공연장ID']] ? venues[r['공연장ID']]['이름'] : '';
    var time = [];
    if (r['시작시간']) time.push('<span>시작 <b>' + esc(r['시작시간']) + '</b></span>');
    if (r['집합시간']) time.push('<span>집합 <b>' + esc(r['집합시간']) + '</b></span>');
    return '<div class="card kind-' + esc(kind) + '">' + editLink('일정', r._row) +
      '<div class="card-head"><span class="badge ' + esc(kind) + '">' + esc(kind) + '</span>' +
      '<span class="card-title">' + fmtDate(r['날짜']) + '</span>' +
      '<span class="badge soft">' + esc(dLabel(r['날짜'])) + '</span></div>' +
      (time.length ? '<div class="row">' + time.join('') + '</div>' : '') +
      (r['장소'] || venue ? '<div class="card-sub">' + esc(r['장소'] || venue) + (r['장소'] && venue && r['장소'] !== venue ? ' · ' + esc(venue) : '') + '</div>' : '') +
      (r['메모'] ? '<div class="card-body">' + esc(r['메모']) + '</div>' : '') +
      '</div>';
  }

  function todoCard(r) {
    var done = r['상태'] === '완료';
    var n = daysFromToday(r['마감일']);
    var overdue = !done && n !== null && n < 0;
    var meta = [];
    if (r['담당']) meta.push('<span><b>' + esc(r['담당']) + '</b></span>');
    if (r['마감일']) meta.push('<span>' + fmtDate(r['마감일']) + ' · ' + esc(dLabel(r['마감일'])) + '</span>');
    if (r['관련ID']) meta.push('<span>' + esc(r['관련ID']) + '</span>');
    return '<div class="card' + (overdue ? ' overdue' : '') + (done ? ' dim' : '') + '">' + editLink('할일', r._row) +
      '<div class="card-head">' +
      (overdue ? '<span class="badge danger">마감 지남</span>' : '') +
      (r['우선순위'] === '높음' && !done ? '<span class="badge 공연">높음</span>' : '') +
      (r['상태'] === '진행' ? '<span class="badge 합주">진행</span>' : '') +
      '</div>' +
      '<div class="card-title" style="margin-top:4px">' + esc(r['내용']) + '</div>' +
      (meta.length ? '<div class="row">' + meta.join('') + '</div>' : '') +
      '</div>';
  }

  function meetingCard(r, open) {
    return '<details class="card"' + (open ? ' open' : '') + '><summary>' + editLink('회의록', r._row) +
      '<div class="card-head"><span class="badge 회의">' + fmtDate(r['날짜']) + '</span></div>' +
      '<div class="card-title" style="margin-top:6px">' + esc(r['안건']) + '</div>' +
      (r['결정사항'] ? '<div class="card-sub clamp2">' + esc(r['결정사항']) + '</div>' : '') +
      '<div class="more-hint">눌러서 펼치기</div></summary>' +
      (r['결정사항'] ? '<div class="card-body"><b>결정사항</b>\n' + esc(r['결정사항']) + '</div>' : '') +
      (safeHref(r['문서링크']) ? '<div class="btns">' + linkBtn(r['문서링크'], '회의록 문서') + '</div>' : '') +
      '</details>';
  }

  function moneyCard(r) {
    var income = r['구분'] === '수입';
    var done = String(r['정산완료']).toUpperCase() === 'O';
    var meta = [fmtDate(r['날짜'])];
    if (r['낸사람']) meta.push(esc(r['낸사람']));
    if (r['관련ID']) meta.push(esc(r['관련ID']));
    return '<div class="card' + (done ? ' dim' : '') + '">' + editLink('정산', r._row) +
      '<div class="amount-line"><span class="card-title">' + esc(r['항목'] || r['구분']) + '</span>' +
      '<span class="' + (income ? 'plus' : 'minus') + '">' + (income ? '+' : '−') + won(r['금액']) + '</span></div>' +
      '<div class="row"><span class="badge soft">' + esc(r['구분']) + '</span><span>' + meta.join(' · ') + '</span>' +
      (done ? '<span>정산완료</span>' : '') + '</div>' +
      (safeHref(r['영수증링크']) ? '<div class="btns">' + linkBtn(r['영수증링크'], '영수증') + '</div>' : '') +
      '</div>';
  }

  function moneySummary() {
    var s = (state.data && state.data.summary) || {};
    var m = members();
    var needTransfer = Number(s.transferAmount) > 0;
    return '<div class="card money-hero">' + (sheetTabHref('정산요약') ? '<a class="edit" href="' + esc(sheetTabHref('정산요약')) + '" target="_blank" rel="noopener">시트</a>' : '') +
      '<div class="money-label">공용 자금 잔액 (미정산 기준)</div>' +
      '<div class="money-big">' + won(s.commonBalance) + '</div>' +
      '<div class="money-grid">' +
      '<div><span class="money-label">이번 달 수입</span><b class="plus">' + won(s.monthIncome) + '</b></div>' +
      '<div><span class="money-label">이번 달 지출</span><b class="minus">' + won(s.monthExpense) + '</b></div>' +
      '<div><span class="money-label">' + esc(m[0]) + ' 개인 부담</span><b>' + won(s.burden1) + '</b></div>' +
      '<div><span class="money-label">' + esc(m[1]) + ' 개인 부담</span><b>' + won(s.burden2) + '</b></div>' +
      '</div>' +
      '<div class="transfer">' + (needTransfer
        ? esc(s.transferText) + ' <span class="amt">' + won(s.transferAmount) + '</span>'
        : '정산할 금액 없음') + '</div>' +
      '</div>';
  }

  function venueCard(r) {
    var phone = /^[0-9\-\s+]{9,}$/.test(String(r['담당자연락처'] || '').trim());
    var contact = r['담당자연락처']
      ? (phone ? '<a href="tel:' + esc(String(r['담당자연락처']).replace(/[^0-9+]/g, '')) + '">' + esc(r['담당자연락처']) + '</a>' : esc(r['담당자연락처']))
      : '';
    var sub = [r['지역'], r['수용인원'] !== '' && r['수용인원'] !== undefined ? r['수용인원'] + '명' : '', r['재섭외']].filter(Boolean).map(esc).join(' · ');
    return '<details class="card"><summary>' + editLink('공연장', r._row) +
      '<div class="card-title">' + esc(r['이름']) + '</div>' +
      (sub ? '<div class="card-sub">' + sub + '</div>' : '') +
      '<div class="more-hint">눌러서 펼치기</div></summary>' +
      '<div class="card-body">' +
      (r['장비'] ? '<b>장비</b> ' + esc(r['장비']) + '\n' : '') +
      (r['조건'] ? '<b>조건</b> ' + esc(r['조건']) + '\n' : '') +
      (contact ? '<b>담당</b> ' + contact + '\n' : '') +
      (r['공연이력'] ? '<b>이력</b> ' + esc(r['공연이력']) : '') +
      '</div></details>';
  }

  function youtubeId(url) {
    var m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/.exec(String(url || ''));
    return m ? m[1] : '';
  }

  function ideaCard(r) {
    var href = safeHref(r['링크']);
    var yt = youtubeId(href);
    var media = '';
    if (yt) {
      media = '<a class="thumb" href="' + esc(href) + '" target="_blank" rel="noopener" aria-label="영상 열기">' +
        '<img loading="lazy" alt="" src="https://img.youtube.com/vi/' + esc(yt) + '/hqdefault.jpg"></a>';
    } else if (href) {
      media = '<div class="btns">' + linkBtn(href, '링크 열기', 'block') + '</div>';
    }
    return '<div class="card">' + editLink('아이디어', r._row) +
      '<div class="card-head">' + (r['분류'] ? '<span class="badge">' + esc(r['분류']) + '</span>' : '') +
      (r['상태'] ? '<span class="badge soft">' + esc(r['상태']) + '</span>' : '') + '</div>' +
      '<div class="card-title" style="margin-top:6px">' + esc(r['제목']) + '</div>' +
      (r['제안자'] ? '<div class="card-sub">' + esc(r['제안자']) + '</div>' : '') +
      (r['메모'] ? '<div class="card-body">' + esc(r['메모']) + '</div>' : '') +
      media + '</div>';
  }

  /* ---------- 화면 ---------- */
  var views = {};

  views.home = function () {
    var today = todayStr();
    var venues = byId('공연장');
    var next = rows('일정').filter(function (r) { return r['날짜'] && r['날짜'] >= today; }).sort(sortSchedule).slice(0, 3);

    var filter = currentTodoFilter();
    var todos = filterTodos(rows('할일'), filter).filter(function (r) {
      if (r['상태'] === '완료') return false;
      var n = daysFromToday(r['마감일']);
      return n !== null && n <= 7;
    }).sort(function (a, b) { return a['마감일'].localeCompare(b['마감일']); });
    var noDate = filterTodos(rows('할일'), filter).filter(function (r) { return r['상태'] !== '완료' && !r['마감일']; }).length;

    var meetings = rows('회의록').slice().sort(function (a, b) { return String(b['날짜']).localeCompare(String(a['날짜'])); }).slice(0, 2);
    var l = links();

    var h = '';
    h += sectionTitle('다음 일정', '#/schedule');
    h += next.length ? next.map(function (r) { return scheduleCard(r, venues); }).join('') : empty('잡힌 일정 없음');

    h += sectionTitle('할일 · 마감 지남 / 7일 안', '#/todo');
    h += todoChips(filter);
    h += todos.length ? todos.map(todoCard).join('') : empty('급한 할일 없음');
    if (noDate) h += '<div class="card-sub" style="margin:-2px 4px 6px"><a href="#/todo">마감일 없는 할일 ' + noDate + '개 ›</a></div>';

    h += sectionTitle('정산', '#/money', '내역');
    h += moneySummary();

    h += sectionTitle('최근 결정사항', '#/meetings');
    h += meetings.length ? meetings.map(function (r) { return meetingCard(r, false); }).join('') : empty('회의록 없음');

    var shortcuts = [linkBtn(l.sheet, '시트 열기'), linkBtn(l.drive, '드라이브 폴더'), linkBtn(l.etc, '기타 링크')].filter(Boolean);
    if (shortcuts.length) {
      h += sectionTitle('바로가기');
      h += '<div class="btns" style="margin-top:0">' + shortcuts.join('') + '</div>';
    }
    return h;
  };

  views.schedule = function () {
    var today = todayStr();
    var venues = byId('공연장');
    var all = rows('일정').filter(function (r) { return r['날짜']; });
    var upcoming = all.filter(function (r) { return r['날짜'] >= today; }).sort(sortSchedule);
    var past = all.filter(function (r) { return r['날짜'] < today; }).sort(sortSchedule).reverse();
    var h = sectionTitle('다가오는 일정 ' + upcoming.length + '개');
    h += upcoming.length ? upcoming.map(function (r) { return scheduleCard(r, venues); }).join('') : empty('잡힌 일정 없음');
    h += '<div class="btns"><button class="btn block" type="button" data-action="toggle-past">' +
      (state.showPast ? '지난 일정 숨기기' : '지난 일정 보기 (' + past.length + ')') + '</button></div>';
    if (state.showPast) {
      h += sectionTitle('지난 일정');
      h += past.length ? past.map(function (r) { return scheduleCard(r, venues); }).join('') : empty('지난 일정 없음');
    }
    return h;
  };

  function currentTodoFilter() {
    var f = load(KEY.todo) || '전체';
    var opts = ['전체', members()[0], members()[1], '같이'];
    return opts.indexOf(f) >= 0 ? f : '전체';
  }
  function todoChips(filter) {
    return chips(['전체', members()[0], members()[1], '같이'], filter, 'todo');
  }
  function filterTodos(list, f) {
    if (f === '전체') return list;
    return list.filter(function (r) { return r['담당'] === f; });
  }

  views.todo = function () {
    var filter = currentTodoFilter();
    var list = filterTodos(rows('할일'), filter);
    var order = function (a, b) {
      var x = a['마감일'] || '9999', y = b['마감일'] || '9999';
      return x.localeCompare(y);
    };
    var groups = [
      ['할일', list.filter(function (r) { return r['상태'] !== '진행' && r['상태'] !== '완료'; }).sort(order)],
      ['진행', list.filter(function (r) { return r['상태'] === '진행'; }).sort(order)],
      ['완료', list.filter(function (r) { return r['상태'] === '완료'; }).sort(order).reverse()]
    ];
    var h = todoChips(filter);
    groups.forEach(function (g) {
      if (g[0] === '완료') {
        h += '<details><summary class="section-title" style="cursor:pointer">완료 ' + g[1].length + '개 ›</summary>' +
          (g[1].length ? g[1].map(todoCard).join('') : empty('완료한 할일 없음')) + '</details>';
      } else {
        h += sectionTitle(g[0] + ' ' + g[1].length + '개');
        h += g[1].length ? g[1].map(todoCard).join('') : empty(g[0] === '할일' ? '남은 할일 없음' : '진행 중인 일 없음');
      }
    });
    return h;
  };

  views.money = function () {
    var list = rows('정산').slice().sort(function (a, b) {
      var c = String(b['날짜']).localeCompare(String(a['날짜']));
      return c !== 0 ? c : b._row - a._row;
    });
    var h = sectionTitle('요약');
    h += moneySummary();
    h += sectionTitle('내역 ' + list.length + '건');
    h += list.length ? list.map(moneyCard).join('') : empty('정산 내역 없음');
    return h;
  };

  views.meetings = function () {
    var list = rows('회의록').slice().sort(function (a, b) { return String(b['날짜']).localeCompare(String(a['날짜'])); });
    return sectionTitle('회의록 ' + list.length + '건') +
      (list.length ? list.map(function (r) { return meetingCard(r, false); }).join('') : empty('회의록 없음'));
  };

  views.venues = function () {
    var list = rows('공연장').slice().sort(function (a, b) {
      return String(b['재섭외'] || '').length - String(a['재섭외'] || '').length || String(a['이름']).localeCompare(String(b['이름']));
    });
    return sectionTitle('공연장 ' + list.length + '곳') +
      (list.length ? list.map(venueCard).join('') : empty('등록된 공연장 없음'));
  };

  views.ideas = function () {
    var opts = ['전체', '뮤비', '콘텐츠', '굿즈', '공연'];
    var f = load(KEY.idea) || '전체';
    if (opts.indexOf(f) < 0) f = '전체';
    var list = rows('아이디어').filter(function (r) { return f === '전체' || r['분류'] === f; })
      .sort(function (a, b) { return b._row - a._row; });
    return chips(opts, f, 'idea') +
      (list.length ? list.map(ideaCard).join('') : empty('아이디어 없음'));
  };

  views.setlist = function () {
    var today = todayStr();
    var gigs = byId('일정');
    var songs = byId('곡', '곡ID');
    var groups = {};
    rows('세트리스트').forEach(function (r) {
      var k = r['공연ID'] || '(공연ID 없음)';
      (groups[k] = groups[k] || []).push(r);
    });
    var keys = Object.keys(groups).sort(function (a, b) {
      var da = gigs[a] ? gigs[a]['날짜'] : '', db = gigs[b] ? gigs[b]['날짜'] : '';
      var fa = da >= today, fb = db >= today;
      if (fa !== fb) return fa ? -1 : 1;
      return fa ? da.localeCompare(db) : db.localeCompare(da);
    });
    if (!keys.length) return empty('세트리스트 없음');

    return keys.map(function (k) {
      var g = gigs[k];
      var list = groups[k].slice().sort(function (a, b) { return (Number(a['순서']) || 0) - (Number(b['순서']) || 0); });
      var head = g ? fmtDate(g['날짜']) + ' · ' + esc(g['장소'] || g['종류']) : esc(k);
      return sectionTitle('') .replace('<span></span>', '<span>' + head + '</span>') +
        '<div class="card">' + (sheetTabHref('세트리스트') ? '<a class="edit" href="' + esc(sheetTabHref('세트리스트')) + '" target="_blank" rel="noopener">수정</a>' : '') +
        list.map(function (r) {
          var s = songs[r['곡ID']] || {};
          var meta = [s['키'], s['BPM'] ? s['BPM'] + ' BPM' : '', s['길이']].filter(Boolean).map(esc).join(' · ');
          var btns = [linkBtn(s['악보링크'], '악보'), linkBtn(s['음원링크'], '음원')].filter(Boolean).join('');
          return '<div class="song"><div class="song-no">' + esc(r['순서']) + '</div><div class="song-main">' +
            '<div class="card-title">' + esc(s['곡명'] || r['곡명'] || r['곡ID']) + '</div>' +
            (meta ? '<div class="card-sub">' + meta + '</div>' : '') +
            (r['파트메모'] ? '<div class="card-body">' + esc(r['파트메모']) + '</div>' : '') +
            (btns ? '<div class="btns">' + btns + '</div>' : '') +
            '</div></div>';
        }).join('') + '</div>';
    }).join('');
  };

  views.more = function () {
    var l = links();
    var h = sectionTitle('기록');
    h += '<div class="card menu">' +
      '<a href="#/meetings">회의록 <span class="arrow">›</span></a>' +
      '<a href="#/setlist">세트리스트 <span class="arrow">›</span></a>' +
      '<a href="#/venues">공연장 <span class="arrow">›</span></a>' +
      '<a href="#/ideas">아이디어 <span class="arrow">›</span></a>' +
      '</div>';
    var ext = [
      [l.sheet, '구글 시트'], [l.drive, '드라이브 폴더'], [l.etc, '기타 링크']
    ].filter(function (x) { return safeHref(x[0]); });
    if (ext.length) {
      h += sectionTitle('바로가기');
      h += '<div class="card menu">' + ext.map(function (x) {
        return '<a href="' + esc(safeHref(x[0])) + '" target="_blank" rel="noopener">' + esc(x[1]) + ' <span class="arrow">↗</span></a>';
      }).join('') + '</div>';
    }
    h += sectionTitle('설정');
    h += '<button class="btn block" type="button" data-action="reset-token">토큰 다시 입력</button>';
    return h;
  };

  views.gate = function () {
    return '<div class="gate"><h1>' + esc(CFG.BAND_NAME || '연앤필') + ' 대시보드</h1>' +
      '<p>처음 한 번만 토큰을 입력하면 이 폰에 저장돼요.</p>' +
      '<form id="gate-form" autocomplete="off">' +
      '<input class="input" id="token-input" type="password" inputmode="text" placeholder="토큰 붙여넣기" aria-label="토큰" required>' +
      '<div class="error-text" id="gate-error">' + esc(state.gateError) + '</div>' +
      '<button class="btn primary block" type="submit" id="gate-submit">확인</button>' +
      '</form></div>';
  };

  var ROUTES = {
    '': { view: 'home', title: '', tab: 'home' },
    'schedule': { view: 'schedule', title: '일정', tab: 'schedule' },
    'todo': { view: 'todo', title: '할일', tab: 'todo' },
    'money': { view: 'money', title: '정산', tab: 'money' },
    'more': { view: 'more', title: '더보기', tab: 'more' },
    'meetings': { view: 'meetings', title: '회의록', tab: 'more' },
    'venues': { view: 'venues', title: '공연장', tab: 'more' },
    'ideas': { view: 'ideas', title: '아이디어', tab: 'more' },
    'setlist': { view: 'setlist', title: '세트리스트', tab: 'more' }
  };

  function currentRoute() {
    var key = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return ROUTES[key] || ROUTES[''];
  }

  function render() {
    if (!load(KEY.token)) {
      $tabbar.hidden = true;
      $banner.hidden = true;
      $title.textContent = '';
      $app.innerHTML = views.gate();
      return;
    }
    $tabbar.hidden = false;
    var route = currentRoute();
    $title.textContent = route.title;
    Array.prototype.forEach.call($tabbar.querySelectorAll('a'), function (a) {
      a.classList.toggle('active', a.getAttribute('data-tab') === route.tab);
    });
    renderBanner();

    if (!state.data) {
      if (state.failed) {
        $app.innerHTML = '<div class="empty" style="margin-top:20px">데이터를 불러오지 못했어요.<br>인터넷 연결이나 Apps Script 배포 주소를 확인해 주세요.</div>' +
          '<button class="btn primary block" type="button" data-action="refresh">다시 시도</button>';
      } else {
        $app.innerHTML = '<div class="empty" style="margin-top:20px"><span class="spinner"></span> 불러오는 중</div>';
      }
      return;
    }
    $app.innerHTML = views[route.view]() + statusHtml();
  }

  /* ---------- 이벤트 ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action],[data-todo],[data-idea]');
    if (!t) return;
    if (t.hasAttribute('data-todo')) { save(KEY.todo, t.getAttribute('data-todo')); render(); return; }
    if (t.hasAttribute('data-idea')) { save(KEY.idea, t.getAttribute('data-idea')); render(); return; }
    var a = t.getAttribute('data-action');
    if (a === 'refresh') refresh(true);
    else if (a === 'toggle-past') { state.showPast = !state.showPast; render(); }
    else if (a === 'reset-token') {
      if (confirm('저장된 토큰을 지우고 다시 입력할까요?')) {
        remove(KEY.token); remove(KEY.cache); state.data = null; state.gateError = ''; location.hash = '#/'; render();
      }
    }
  });

  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'gate-form') return;
    e.preventDefault();
    var input = document.getElementById('token-input');
    var btn = document.getElementById('gate-submit');
    var err = document.getElementById('gate-error');
    var token = input.value.trim();
    if (!token) return;
    btn.disabled = true; btn.textContent = '확인 중…'; err.textContent = '';
    request(token, true).then(function (json) {
      if (json && json.ok === true) {
        save(KEY.token, token);
        save(KEY.cache, JSON.stringify(json));
        state.data = json; state.failed = false; state.gateError = '';
        render();
      } else {
        err.textContent = json && json.error === 'unauthorized' ? '토큰이 맞지 않아요.' : '서버에서 오류가 났어요. 잠시 후 다시 시도해 주세요.';
        btn.disabled = false; btn.textContent = '확인';
      }
    }).catch(function () {
      err.textContent = '연결에 실패했어요. config.js의 웹앱 주소와 인터넷 연결을 확인해 주세요.';
      btn.disabled = false; btn.textContent = '확인';
    });
  });

  window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });

  // 앱으로 다시 돌아왔을 때(폰 홈 화면) 5분 넘었으면 자동 갱신
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !state.data || state.loading) return;
    var t = Date.parse(state.data.updatedAt);
    if (isNaN(t) || Date.now() - t > 5 * 60000) refresh(false);
  });

  /* ---------- 시작 ---------- */
  (function init() {
    var cached = load(KEY.cache);
    if (cached) { try { state.data = JSON.parse(cached); } catch (e) { state.data = null; } }
    render();
    if (load(KEY.token)) refresh(false);
  })();
})();
