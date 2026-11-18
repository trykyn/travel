// 노션 연결 (양방향) / Abgleich mit Notion in beide Richtungen
//
// Notion ist das Original: 엄마 plant in Notion. Die App liest die Reiseseiten unter "여행" (Tabellen, Unterseiten,
// Zeilen-Seiten, Checklisten, Text) und schreibt Änderungen aus der App sofort zurück.
// 노션이 원본. 앱은 '여행' 아래 여행 페이지들(표, 하위 페이지, 줄 안 페이지, 체크리스트, 글)을 읽고,
// 앱에서 고친 것은 바로 노션에 다시 씀.
//
// - Lesen: beim Start, alle 3 Minuten und beim Öffnen einer Reise. Die Notion-Suche nach "zuletzt geändert"
//   zeigt, welche Reisen sich geändert haben; nur die werden neu gelesen.
//   읽기: 앱을 열 때, 3분마다, 여행을 열 때. 노션 검색으로 최근 바뀐 페이지를 찾아 그 여행만 다시 읽음.
// - Schreiben: Jede Änderung kommt in eine Warteschlange (localStorage, übersteht Offline) und geht dann nach Notion.
//   Nur Felder, die sich seit dem letzten Lesen geändert haben, werden geschickt (Formatierungen in Notion bleiben).
//   쓰기: 바뀐 것은 대기열(오프라인에서도 유지)에 넣었다가 노션에 보냄. 마지막으로 읽은 뒤 바뀐 칸만 보내서
//   노션의 다른 칸 서식은 그대로.
// - Nur in der App: Ort auf der Karte, "다녀옴", Buchungsnummer, Ausgaben, Vergleich, Reisedaten.
//   앱에만 있는 것: 지도 위치, 다녀옴, 예약번호, 지출, 비교 후보, 여행 날짜.
// - Der Notion-Schlüssel liegt nur im Worker (travel/worker), nie in der App.
//   노션 비밀 키는 서버(travel/worker)에만 있고 앱에는 없음.
(() => {
  'use strict';
  const NW = 'https://travel-notion.weekly-meals-reader.workers.dev';
  const ROOT = '08d74117-0c1e-46bb-8b69-0b1912c2b36f'; // 노션 '여행' 페이지
  const S = {
    state: 'off', err: '', progress: '', pulling: false, pushing: false,
    lastPull: store.get('notion:pull', 0), linked: store.get('notion:linked', false),
    outbox: store.get('notion:out', []), callouts: store.get('notion:callouts', {}), rootKids: new Set(store.get('notion:rootkids', [])),
  };

  // ---------- kleine Helfer / 도우미 ----------
  const plain = (r) => (r || []).map((x) => x.plain_text || '').join('');
  const rt = (s) => { s = String(s || ''); const out = []; for (let i = 0; i < s.length && out.length < 50; i += 1900) out.push({ type: 'text', text: { content: s.slice(i, i + 1900) } }); return out; };
  const cid = (id) => String(id || '').replace(/-/g, '').toLowerCase();
  const tidOf = (page) => 'n' + cid(page).slice(0, 12);
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const hash = (s) => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  class NErr extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
  const refresh = () => { render(); if (window.refreshSettings) window.refreshSettings(); };

  // ---------- Worker / 서버 ----------
  async function batch(calls) {
    const c = window.cloud;
    if (!c || !c.user || !c.idToken) throw new NErr('unauthorized');
    let r;
    try {
      r = await fetch(NW + '/notion', { method: 'POST', headers: { Authorization: 'Bearer ' + await c.idToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ calls }) });
    } catch { throw new NErr('net'); }
    if (!r.ok) { let e = 'net'; try { e = (await r.json()).error || e; } catch {} throw new NErr(e); }
    return (await r.json()).results || [];
  }
  async function call(method, path, body) {
    const [x] = await batch([{ method, path, body }]);
    if (!x || x.status >= 400) throw new NErr(x && x.status === 404 ? 'gone' : 'notion', x && x.data);
    return x.data;
  }
  async function many(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += 20) out.push(...await batch(calls.slice(i, i + 20)));
    return out;
  }
  // Alle Seiten einer Notion-Liste holen / 노션 목록을 끝까지 넘겨 가며 모두 가져오기
  async function paged(get, first) {
    const all = [];
    let d = first || await get(null);
    for (;;) { all.push(...d.results); if (!d.has_more) return all; d = await get(d.next_cursor); }
  }
  const children = (id) => paged((c) => call('GET', `blocks/${id}/children?page_size=100${c ? '&start_cursor=' + c : ''}`));
  async function childrenMany(ids) {
    const out = {};
    if (!ids.length) return out;
    const res = await many(ids.map((id) => ({ method: 'GET', path: `blocks/${id}/children?page_size=100` })));
    for (let i = 0; i < ids.length; i++) {
      const d = res[i] && res[i].status < 400 ? res[i].data : null;
      // 404 = keine Inhalte; andere Fehler (429 …) → abbrechen statt leer lesen / 404만 빈 내용, 다른 오류는 중단
      if (!d && res[i] && res[i].status !== 404) throw new NErr('notion', res[i].data);
      if (!d) { out[ids[i]] = []; continue; }
      out[ids[i]] = await paged((c) => call('GET', `blocks/${ids[i]}/children?page_size=100&start_cursor=${c}`), d);
    }
    return out;
  }
  const queryAll = (db) => paged((c) => call('POST', `databases/${db}/query`, { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'ascending' }], ...(c && { start_cursor: c }) }));

  // ---------- Notion lesen / 노션 읽기 ----------
  const CURF = { yen: 'JPY', won: 'KRW', euro: 'EUR', dollar: 'USD', pound: 'GBP', franc: 'CHF', koruna: 'CZK', yuan: 'CNY', baht: 'THB', forint: 'HUF', krona: 'SEK', zloty: 'PLN', lira: 'TRY' };
  // Spalten der Tabelle erkennen (엄마's Vorlage: 구분, Name, 시간, 주요내용, 일정, 예약, Dateien und Medien, 엔/원/Euro)
  // 표의 칸 찾기 (엄마 폼: 구분, Name, 시간, 주요내용, 일정, 예약, 파일, 엔/원/Euro)
  function schemaOf(db, grp) {
    const P = db.properties || {}, names = Object.keys(P);
    const of = (type, prefer = []) => prefer.find((n) => P[n] && P[n].type === type) || names.find((n) => P[n].type === type) || null;
    const named = (type, prefer) => prefer.find((n) => P[n] && P[n].type === type) || null;
    const s = {
      grp: grp || '', title: of('title'), cat: of('select', ['구분', '종류']), time: named('rich_text', ['시간', 'Zeit', 'Time']),
      notes: named('rich_text', ['주요내용', '내용', '메모', 'Notiz', 'Notes']), book: of('checkbox', ['예약']), files: of('files'), url: of('url'),
    };
    s.date = named('multi_select', ['일정', '날짜']) || named('date', ['일정', '날짜']) || of('date');
    s.dateType = s.date ? P[s.date].type : '';
    if (!s.notes) s.notes = names.find((n) => P[n].type === 'rich_text' && n !== s.time) || null;
    s.num = of('number', ['엔', '원', 'Euro', '유로', '가격', '금액', '비용']);
    s.cur = s.num ? CURF[(P[s.num].number || {}).format] || null : null;
    for (const n of names) if (P[n].type === 'formula') { const m = String((P[n].formula || {}).expression || '').match(/\*\s*([0-9.]+)/); if (m) s.rate = +m[1]; }
    if (s.dateType === 'multi_select') s.wd = ((P[s.date].multi_select || {}).options || []).some((o) => /일\s+[월화수목금토일]/.test(o.name));
    return s;
  }
  const parseKo = (name, year) => {
    const m = String(name).match(/(\d{1,2})월\s*(\d{1,2})일/);
    if (m && year) return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    const x = String(name).match(/^\d{4}-\d{2}-\d{2}/);
    return x ? x[0] : '';
  };
  function rowFields(row, s, year) {
    const P = row.properties || {}, v = (n) => (n ? P[n] : null);
    const f = {
      title: plain((v(s.title) || {}).title).trim(), ncat: ((v(s.cat) || {}).select || {}).name || '',
      time: plain((v(s.time) || {}).rich_text).trim(), notes: plain((v(s.notes) || {}).rich_text).trim(),
      booked: !!(v(s.book) || {}).checkbox, dn: [], links: [], num: null,
    };
    const d = v(s.date);
    if (d && d.type === 'multi_select') for (const o of d.multi_select) f.dn.push({ name: o.name, iso: parseKo(o.name, year), ko: /월/.test(o.name) });
    else if (d && d.type === 'date' && d.date) { f.dn.push({ name: '', iso: d.date.start.slice(0, 10) }); if (d.date.end) f.dn.push({ name: '', iso: d.date.end.slice(0, 10) }); }
    // Notion-eigene Dateien haben ablaufende Links → nur externe Links / 노션에 올린 파일 주소는 곧 만료돼서 외부 링크만
    if (v(s.files)) for (const x of v(s.files).files || []) if (x.type === 'external') f.links.push(x.external.url);
    if (v(s.url) && v(s.url).url) f.links.push(v(s.url).url);
    f.links = f.links.filter((u) => /^https?:\/\//i.test(u));
    const num = v(s.num);
    if (num && num.number != null) f.num = num.number;
    return f;
  }
  function lineOf(b) {
    const x = b[b.type] || {}, txt = plain(x.rich_text);
    switch (b.type) {
      case 'paragraph': case 'quote': case 'callout': case 'toggle': case 'code': return txt;
      case 'heading_1': case 'heading_2': case 'heading_3': return txt ? '\n■ ' + txt : null;
      case 'bulleted_list_item': return '• ' + txt;
      case 'numbered_list_item': return '· ' + txt;
      case 'bookmark': case 'embed': case 'link_preview': return [plain(x.caption), x.url].filter(Boolean).join(' ');
      case 'divider': return '';
      default: return null;
    }
  }
  // "M월 D일" kennt kein Jahr: liegen Dezember- und Januar-Tage zusammen, bekommt die kleinere Seite das Nachbarjahr
  // 'M월 D일'에는 연도가 없음: 12월과 1월이 같이 있으면 개수가 적은 쪽을 옆 해로 ('12월 29일'~'1월 2일' → 1월은 다음 해)
  function fixNewYear(out) {
    const ko = out.items.flatMap((x) => x.dn.filter((d) => d.ko && d.iso));
    const mo = (d) => +d.iso.slice(5, 7);
    const late = ko.filter((d) => mo(d) >= 11), early = ko.filter((d) => mo(d) <= 2);
    if (!late.length || !early.length) return;
    const shift = (d, k) => { d.iso = (+d.iso.slice(0, 4) + k) + d.iso.slice(4); };
    if (late.length >= early.length) early.forEach((d) => shift(d, 1)); else late.forEach((d) => shift(d, -1));
  }
  async function readTrip(page, year) {
    const p = await call('GET', `pages/${page}`);
    if (p.archived || p.in_trash) return { gone: true, page };
    const tp = Object.values(p.properties || {}).find((x) => x.type === 'title');
    const title = plain(tp && tp.title).trim();
    const out = {
      page: p.id, title, icon: p.icon && p.icon.type === 'emoji' ? p.icon.emoji : '',
      cover: p.cover && p.cover.type === 'external' ? p.cover.external.url : '',
      year: year || +((title.match(/(20\d\d)/) || [])[1] || 0) || +String(p.created_time).slice(0, 4),
      edited: p.last_edited_time, dbs: {}, db: null, pages: [p.id], grpPages: {}, grpSpans: {}, memo: [], gmemo: {}, items: [], checks: [],
    };
    // Nur die Reiseseite selbst darf "gelöscht" heißen; 404 weiter innen = diese Reise diesmal überspringen
    // 여행 페이지 자체만 '삭제됨'으로 봄. 안쪽 블록의 404는 이번에 이 여행만 건너뜀
    try { await walk(p.id, '', 0, out); } catch (e) { if (e.code === 'gone') throw new NErr('notion', e.detail); throw e; }
    fixNewYear(out);
    if (!out.db) out.db = Object.keys(out.dbs)[0] || null;
    return out;
  }
  // Memo je Seite: Text der Reiseseite → memo, Text einer Unterseite mit Tabelle → gmemo[Unterseite]
  // 메모는 페이지별: 여행 페이지 글 → memo, 표가 있는 하위 페이지 글 → gmemo[하위 페이지 이름]
  const memoOf = (out, grp) => (grp ? (out.gmemo[grp] = out.gmemo[grp] || []) : out.memo);
  async function walk(parent, grp, depth, out) {
    const mem = memoOf(out, grp);
    for (const b of await children(parent)) {
      if (b.type === 'child_database') { await readDb(b.id, grp, depth, out); continue; }
      if (b.type === 'child_page') {
        if (depth >= 3) continue;
        // Unterseite (서울여행, 가르다호 …): ihre Tabellen werden eine Gruppe, ihr Text kommt unter ihrem Namen ins Memo
        // 하위 페이지: 표는 그 이름의 묶음, 글은 메모에 그 이름 아래로
        const name = b.child_page.title || '';
        out.pages.push(b.id);
        out.grpPages[name] = b.id;
        const n0 = out.items.length;
        await walk(b.id, name, depth + 1, out);
        // Ohne Tabelle ist es keine eigene Reise: Text mit Überschrift ins Memo der Elternseite
        // 표가 없는 하위 페이지는 여행 묶음이 아님 → 글을 위 페이지 메모에 제목과 함께
        if (out.items.length === n0 && !out.items.some((x) => x.grp === name)) {
          const lines = out.gmemo[name] || [];
          delete out.gmemo[name]; delete out.grpPages[name];
          mem.push('', '■ ' + name, ...lines);
          for (const c of out.checks) if (c.grp === name) c.grp = grp; // Checkliste gehört dann zur Elternseite / 체크도 위 페이지로
        }
        continue;
      }
      if (b.type === 'to_do') { out.checks.push({ nid: b.id, text: plain(b.to_do.rich_text), done: !!b.to_do.checked, grp }); continue; }
      if (b.type === 'table') {
        for (const r of await children(b.id)) if (r.type === 'table_row') mem.push(r.table_row.cells.map((c) => plain(c).replace(/\n/g, ' ')).join(' | '));
        continue;
      }
      const line = lineOf(b);
      if (line != null) mem.push(line);
      if (b.has_children && b.type !== 'link_to_page') await walk(b.id, grp, depth, out);
    }
  }
  async function readDb(id, grp, depth, out) {
    let db;
    try { db = await call('GET', `databases/${id}`); } catch (e) {
      // verknüpfte Ansicht o. Ä. (404/400) überspringen; 429 oder Netzfehler → ganze Reise diesmal auslassen, sonst würden ihre Zeilen gelöscht
      // 링크된 보기(404/400)만 건너뜀. 429·네트워크 오류는 이 여행을 이번에 통째로 건너뜀 (안 그러면 그 표 일정이 지워짐)
      if (e.code === 'gone' || (e.detail && e.detail.status === 400)) return;
      throw e;
    }
    const s = schemaOf(db, grp);
    out.dbs[id] = s;
    if (!grp && !out.db) out.db = id;
    const rows = await queryAll(id);
    // Inhalt der Zeilen-Seiten (Wegbeschreibung, Flugoptionen, eine Tabelle darin …)
    // 줄 안 페이지 내용 (찾아가는 길, 항공편 메모, 그 안의 표 …)
    const bodies = await childrenMany(rows.map((r) => r.id));
    const nested = [];
    // Übersichts-Kalender auf der Reiseseite (Datumsspalte vom Typ "date", mindestens eine Zeile mit eigener Tabelle):
    // jede Zeile ist eine Teilreise mit ihrem Zeitraum – z. B. 서울여행 (mit Tabelle) und 부여, 안면도 (nur Text)
    // 여행 페이지의 개요 캘린더(날짜 칸이 date 형식이고, 표가 들어 있는 줄이 하나라도 있음): 줄마다 소여행, 줄의 기간이 소여행 기간
    const overview = depth === 0 && !grp && s.dateType === 'date' && rows.some((r) => (bodies[r.id] || []).some((k) => k.type === 'child_database'));
    if (overview) s.overview = true;
    rows.forEach((row, i) => {
      const f = rowFields(row, s, out.year);
      if (!f.title && !f.notes) return;
      if (overview && f.title) {
        const ds = f.dn.map((d) => d.iso).filter(Boolean).sort();
        if (ds.length) out.grpSpans[f.title] = [ds[0], ds[ds.length - 1]];
        out.grpPages[f.title] = row.id;
        out.pages.push(row.id);
        const kids = bodies[row.id] || [], lines = kids.filter((k) => k.type !== 'child_database').map(lineOf).filter(Boolean);
        if (kids.some((k) => k.type === 'child_database')) {
          for (const k of kids) if (k.type === 'child_database') nested.push([k.id, f.title]);
          if (lines.length) out.gmemo[f.title] = lines;
        } else {
          // Teilreise ohne eigene Tabelle: die Zeile selbst ist ihr einziger Eintrag (Text = Notiz) / 표 없는 소여행: 줄 자체가 그 소여행의 일정
          out.items.push({ nid: row.id, ndb: id, grp: f.title, order: i, nt: row.last_edited_time, ...f, dn: f.dn.slice(0, 1), body: lines.join('\n').trim().slice(0, 3000) });
          if (lines.length) out.gmemo[f.title] = lines;
        }
        return;
      }
      const body = [];
      for (const k of bodies[row.id] || []) {
        if (k.type === 'child_database') nested.push([k.id, f.title]);
        else { const l = lineOf(k); if (l) body.push(l); }
      }
      out.items.push({ nid: row.id, ndb: id, grp, order: i, nt: row.last_edited_time, ...f, body: body.join('\n').trim().slice(0, 3000) });
      if ((bodies[row.id] || []).some((k) => k.type === 'child_database') && body.length) out.gmemo[f.title] = body.slice();
      if ((bodies[row.id] || []).length) out.pages.push(row.id);
    });
    for (const [nid, name] of nested) if (depth < 2) await readDb(nid, name, depth + 1, out);
  }
  // Die Reiseliste unter "여행": Jahres-Kästen mit Unterseiten / '여행' 아래 연도 칸과 그 안의 여행 페이지
  async function readRoot() {
    const list = [], callouts = {}, kids = [];
    const take = (id, year) => { if (!list.some((x) => cid(x.page) === cid(id))) list.push({ page: id, year }); };
    const yearIn = (s) => +((String(s).match(/(20\d\d)/) || [])[1] || 0);
    async function scan(bs, year, box) {
      for (const b of bs) {
        const txt = plain((b[b.type] || {}).rich_text);
        if (b.type === 'child_page') { kids.push(cid(b.id)); take(b.id, year || yearIn(b.child_page.title)); continue; }
        if (b.type === 'link_to_page' && b.link_to_page.type === 'page_id') { take(b.link_to_page.page_id, year); continue; }
        if (/^(heading_\d|paragraph)$/.test(b.type) && /^\s*20\d\d\s*년?\s*$/.test(txt)) { year = yearIn(txt); if (box) callouts[year] = box; continue; }
        if (['callout', 'toggle', 'column_list', 'column', 'synced_block'].includes(b.type)) {
          const y = yearIn(txt) || (b.type === 'callout' ? 0 : year);
          kids.push(cid(b.id));
          if (b.type === 'callout' && y) callouts[y] = b.id;
          if (b.has_children) await scan(await children(b.id), y, b.type === 'callout' ? b.id : box);
        }
      }
    }
    await scan(await children(ROOT), 0, null);
    S.callouts = callouts; store.put('notion:callouts', callouts);
    S.rootKids = new Set(kids); store.put('notion:rootkids', kids);
    return list;
  }

  // ---------- Notion → App ----------
  const CATMAP = { 이동: 'move', 교통: 'move', 숙소: 'stay', 숙박: 'stay', 맛집: 'food', 끼니: 'food', 식사: 'food', 카페: 'cafe', 관광: 'see', 쇼핑: 'shop', 장보기: 'shop', 체험: 'see', 놀거리: 'see' };
  const STAYRE = /(호텔|hotel|resort|리조트|숙소|agroturismo|airbnb|에어비앤비|宿|yado|료칸|ryokan|apartment|아파트|체크인|check-in|글램핑|펜션|콘도)/i;
  function appCat(r) {
    let c = CATMAP[r.ncat];
    if (!c) c = /^(카페|cafe|café)/i.test(r.title) ? 'cafe' : /^(점심|저녁|아침|조식)/.test(r.title) ? 'food' : r.ncat ? 'see' : 'etc';
    // Hotels stehen in Notion oft als "이동" / 노션에는 호텔이 '이동'으로 적힌 경우가 많음
    if (c === 'move' && !/\S\s*(-|→|–)\s*\S/.test(r.title) && (STAYRE.test(r.title + ' ' + r.time) || (r.dn.length > 1 && /체크인|체크아웃|조식|check/i.test(r.time + r.notes)))) c = 'stay';
    return c;
  }
  const notionCat = (cat, ncat) => (ncat && CATMAP[ncat] === cat ? ncat : { move: '이동', stay: '숙소', food: '맛집', cafe: '카페', see: '관광', shop: '쇼핑', etc: '기타' }[cat] || '기타');
  // Tage außerhalb der Reise (z. B. Buchungsdatum) bleiben in Notion, aber nicht im Plan
  // 여행 기간 밖의 날짜(예약한 날 등)는 노션에 그대로 두고 일정에는 안 넣음
  function appDates(r, cat, trip, gr) {
    const all = r.dn.filter((x) => x.iso).map((x) => x.iso).sort();
    const xd = r.dn.filter((x) => !x.iso && x.name).map((x) => x.name);
    let keep = all;
    if (!isDate(trip.start) && gr) {
      keep = all.filter((d) => d >= addDays(gr[0], -1) && d <= addDays(gr[1], 1));
      for (const x of r.dn) if (x.iso && !keep.includes(x.iso)) xd.push(x.name || x.iso);
    } else if (isDate(trip.start)) {
      const s = addDays(trip.start, -1), e = addDays(isDate(trip.end) ? trip.end : trip.start, 1);
      keep = all.filter((d) => (d >= s && d <= e) || (gr && d >= addDays(gr[0], -1) && d <= addDays(gr[1], 1)));
      for (const x of r.dn) if (x.iso && !keep.includes(x.iso)) xd.push(x.name || x.iso);
    }
    const date = keep[0] || '';
    let end = '';
    if ((cat === 'stay' || cat === 'move') && keep.length > 1) end = keep[keep.length - 1];
    else for (const d of keep.slice(1)) { const nm = r.dn.find((x) => x.iso === d); xd.push((nm && nm.name) || d); }
    return { date, end, xd: [...new Set(xd)] };
  }
  const snapOf = (x) => ({
    title: hash(x.title || ''), cat: x.cat || '', time: hash(x.time || ''), notes: hash(x.notes || ''), date: x.date || '', end: x.end || '',
    booked: !!x.booked, links: hash((x.links || []).join(' ')), cost: x.cost ? `${x.cost.amount} ${x.cost.cur}` : '',
  });
  function clusterRange(dates) {
    if (!dates.length) return ['', ''];
    const mid = dates[Math.floor(dates.length / 2)];
    const keep = dates.filter((d) => Math.abs(diff(mid, d)) <= 30);
    return [keep[0], keep[keep.length - 1]];
  }
  const tidy = (lines, max) => lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  const outboxHas = (k, tid, id) => S.outbox.some((o) => o.k === k && o.tid === tid && o.id === id);
  function tripIdOf(page) {
    const c = cid(page);
    const hit = Object.values(trips).find((x) => x && x.notion && cid(x.notion.page) === c);
    return hit ? hit.id : (trips[tidOf(page)] ? tidOf(page) : null);
  }
  function mergeTrip(n) {
    const tid = tripIdOf(n.page) || tidOf(n.page);
    const local = trips[tid] && trips[tid].title ? trips[tid] : null;
    if (n.gone) { if (local) write([[['trips', tid], null]], { sync: true }); return; }
    const grpRange = {};
    for (const g of new Set(n.items.map((x) => x.grp).filter(Boolean))) {
      const r = clusterRange(n.items.filter((x) => x.grp === g).flatMap((x) => x.dn.map((d) => d.iso)).filter(Boolean).sort());
      if (r[0]) grpRange[g] = r;
    }
    const notion = { page: n.page, db: n.db, dbs: n.dbs, pages: n.pages, grpPages: n.grpPages || {}, grpSpans: n.grpSpans || {}, read: Date.now(), edited: n.edited };
    let trip = local;
    if (!trip) {
      let [s, e] = clusterRange(n.items.flatMap((x) => x.dn.map((d) => d.iso)).filter(Boolean).sort());
      // Zwei Reisen in einer Seite (Unterseiten weit auseinander): kein gemeinsames Datum, jede Gruppe hat ihre Tage
      // 한 페이지에 여행 두 개(멀리 떨어진 하위 페이지): 전체 날짜는 비우고 묶음마다 자기 날짜
      if (s && Object.values(grpRange).some(([a, b]) => b < addDays(s, -1) || a > addDays(e, 1))) s = e = '';
      const firstCur = Object.values(n.dbs).map((x) => x.cur).find(Boolean);
      const cur = firstCur || ((FLAGS.find(([f]) => f === n.icon) || [])[1]) || 'EUR';
      const rate = cur === 'EUR' ? 1 : (Object.values(n.dbs).map((x) => x.rate).find(Boolean) || null);
      trip = { id: tid, title: n.title, icon: n.icon || '✈️', year: n.year, start: s, end: e, cur, rate, cover: '', memo: '', items: {}, checks: {}, created: Date.now(), from: 'notion' };
    }
    const head = {
      // In der App umbenannt: App-Titel behalten, Notion-Titel bleibt / 앱에서 바꾼 제목은 앱에만, 노션 제목은 그대로
      title: trip.titleLocal ? trip.title : n.title || trip.title, icon: n.icon || trip.icon || '✈️', cover: n.cover || trip.cover || '', year: n.year || trip.year || 0,
      memo: tidy(n.memo, 15000), gmemo: Object.fromEntries(Object.entries(n.gmemo || {}).map(([g, l]) => [g, tidy(l, 8000)]).filter(([, v]) => v)), notion,
    };
    const ctx = { ...trip, ...head };
    // Einträge / 일정
    const old = Object.values(trip.items || {}).filter((x) => x && x.id);
    const byNid = new Map(old.filter((x) => x.nid).map((x) => [cid(x.nid), x]));
    const used = new Set(), next = {};
    for (const r of n.items) {
      let id = 'n' + cid(r.nid);
      // Frühere Kopie aus dem Import: am Namen erkennen (Ort, 다녀옴, Buchungsnummer bleiben erhalten)
      // 예전에 가져온 일정: 이름으로 찾아서 위치·다녀옴·예약번호를 이어받음
      const ex = byNid.get(cid(r.nid)) || old.find((x) => !x.nid && !used.has(x.id) && norm(x.title) === norm(r.title)) || null;
      if (ex) { used.add(ex.id); id = ex.id; } // gleiche ID behalten (Ausgaben, offene Fenster zeigen darauf) / 같은 id 유지 (지출·열린 창이 가리킴)
      if (ex && outboxHas('item', tid, ex.id)) { next[ex.id] = ex; continue; } // noch nicht gesendet: App-Stand behalten / 아직 노션에 안 보낸 변경
      const cat = appCat(r);
      const { date, end, xd } = appDates(r, cat, ctx, grpRange[r.grp]);
      const x = { ...(ex || {}), id, nid: r.nid, ndb: r.ndb, grp: r.grp || '', ncat: r.ncat, cat, title: r.title, time: r.time, notes: r.notes, date, end, booked: r.booked, order: r.order, nt: r.nt };
      if (r.body) x.body = r.body; else delete x.body;
      if (r.links.length) x.links = r.links; else delete x.links;
      const s = n.dbs[r.ndb] || {};
      if (r.num != null) x.cost = { amount: r.num, cur: s.cur || trip.cur || 'EUR' }; else delete x.cost;
      if (xd.length) x.xdates = xd; else delete x.xdates;
      delete x.mt;
      x.nsnap = snapOf(x);
      next[id] = x;
    }
    for (const x of old) {
      if (used.has(x.id) || next[x.id]) continue;
      if (x.nid) { if (outboxHas('item', tid, x.id)) next[x.id] = x; continue; } // in Notion gelöscht / 노션에서 지움
      if ((x.order || 0) > 1e6 || x.mt) { next[x.id] = x; queue({ k: 'item', tid, id: x.id }); } // in der App angelegt / 앱에서 만든 것
    }
    // Checkliste / 체크리스트
    const oldC = Object.values(trip.checks || {}).filter((x) => x && x.id);
    const byC = new Map(oldC.filter((x) => x.nid).map((x) => [cid(x.nid), x]));
    const usedC = new Set(), nextC = {};
    n.checks.forEach((c, i) => {
      let id = 'n' + cid(c.nid);
      const ex = byC.get(cid(c.nid)) || oldC.find((x) => !x.nid && !usedC.has(x.id) && norm(x.text) === norm(c.text)) || null;
      if (ex) { usedC.add(ex.id); id = ex.id; }
      if (ex && outboxHas('check', tid, ex.id)) { nextC[ex.id] = ex; return; }
      const x = { ...(ex || {}), id, nid: c.nid, text: c.text, done: c.done, order: i, grp: c.grp || '' };
      delete x.mt;
      nextC[id] = x;
    });
    for (const x of oldC) {
      if (usedC.has(x.id) || nextC[x.id]) continue;
      if (x.nid) { if (outboxHas('check', tid, x.id)) nextC[x.id] = x; continue; }
      if ((x.order || 0) > 1e6 || x.mt) { nextC[x.id] = x; queue({ k: 'check', tid, id: x.id }); }
    }
    // Nur Unterschiede schreiben / 바뀐 것만 저장
    const entries = [];
    if (!local) entries.push([['trips', tid], { ...trip, ...head, items: next, checks: nextC }]);
    else {
      const noRead = (o) => (o ? { ...o, read: 0 } : o);
      for (const [k, v] of Object.entries(head)) {
        const same = k === 'notion' ? JSON.stringify(noRead(trip[k])) === JSON.stringify(noRead(v)) : JSON.stringify(trip[k]) === JSON.stringify(v);
        if (!same) entries.push([['trips', tid, k], v]);
      }
      if (trip.notion) trip.notion.read = notion.read; // nur lokal merken (2-Minuten-Regel) / 로컬에만 기억
      const oi = trip.items || {}, oc = trip.checks || {};
      for (const [id, x] of Object.entries(next)) if (JSON.stringify(oi[id]) !== JSON.stringify(x)) entries.push([['trips', tid, 'items', id], x]);
      for (const id of Object.keys(oi)) if (!next[id]) entries.push([['trips', tid, 'items', id], null]);
      for (const [id, x] of Object.entries(nextC)) if (JSON.stringify(oc[id]) !== JSON.stringify(x)) entries.push([['trips', tid, 'checks', id], x]);
      for (const id of Object.keys(oc)) if (!nextC[id]) entries.push([['trips', tid, 'checks', id], null]);
    }
    if (entries.length) write(entries, { sync: true });
  }

  // Welche Reise gehört zu diesem geänderten Notion-Objekt? / 바뀐 노션 페이지가 어느 여행 것인지
  function tripFor(r) {
    const id = cid(r.id), par = r.parent || {}, pid = cid(par.page_id || par.database_id || par.block_id || '');
    for (const tr of Object.values(trips)) {
      if (!tr || !tr.notion) continue;
      const nn = tr.notion, pages = (nn.pages || []).map(cid), dbs = Object.keys(nn.dbs || {}).map(cid);
      if (cid(nn.page) === id || pages.includes(id) || pages.includes(pid) || dbs.includes(id) || dbs.includes(pid)) return tr;
    }
    return null;
  }
  const isRootish = (r) => { const par = r.parent || {}, pid = cid(par.page_id || par.block_id || ''); return pid === cid(ROOT) || S.rootKids.has(pid); };

  async function pull(opt = {}) {
    if (S.state !== 'ok') { if (!opt.manual) return; await check(); if (S.state !== 'ok') return; }
    if (S.pulling) return;
    S.pulling = true; S.err = ''; refresh();
    const started = Date.now();
    try {
      const targets = new Map();
      const linked = () => Object.values(trips).filter((x) => x && x.notion);
      if (opt.full || !S.linked) {
        for (const x of await readRoot()) targets.set(cid(x.page), [x.page, x.year]);
        for (const tr of linked()) if (!targets.has(cid(tr.notion.page))) targets.set(cid(tr.notion.page), [tr.notion.page, tr.year]);
      } else {
        const since = S.lastPull - 3 * 60 * 1000;
        let c = null, rootChanged = false, stop = false;
        do {
          const d = await call('POST', 'search', { sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 50, ...(c && { start_cursor: c }) });
          for (const r of d.results) {
            if (Date.parse(r.last_edited_time) < since) { stop = true; break; }
            const tr = tripFor(r);
            if (tr) targets.set(cid(tr.notion.page), [tr.notion.page, tr.year]);
            else if (isRootish(r)) rootChanged = true;
          }
          c = !stop && d.has_more ? d.next_cursor : null;
        } while (c);
        if (rootChanged) for (const x of await readRoot()) if (!linked().some((tr) => cid(tr.notion.page) === cid(x.page))) targets.set(cid(x.page), [x.page, x.year]);
        if (opt.trip && opt.trip.notion) targets.set(cid(opt.trip.notion.page), [opt.trip.notion.page, opt.trip.year]);
      }
      const list = [...targets.values()], gone = [];
      let i = 0;
      for (const [page, year] of list) {
        if (list.length > 2) { S.progress = t('nPulling', { a: ++i, b: list.length }); refresh(); }
        try {
          const n = await readTrip(page, year);
          if (n.gone) gone.push(n); else mergeTrip(n);
        } catch (e) {
          if (e.code === 'gone') gone.push({ gone: true, page });
          else if (e.code === 'notion') console.warn('notion: skip', page, e.detail);
          else throw e;
        }
      }
      // Sicherung: verschwinden viele Seiten auf einmal (z. B. Verbindung in Notion entfernt), nichts löschen
      // 안전장치: 한꺼번에 여러 페이지가 사라지면(노션 연결이 끊긴 경우 등) 아무것도 지우지 않음
      if (gone.length <= 2) for (const n of gone) mergeTrip(n);
      else S.err = 'notion';
      S.lastPull = started; store.put('notion:pull', started);
      if (!S.linked) { S.linked = true; store.put('notion:linked', true); }
    } catch (e) {
      S.err = e.code || 'net'; console.warn('notion pull', e);
    } finally {
      S.pulling = false; S.progress = ''; refresh();
      flush();
    }
  }

  // ---------- App → Notion ----------
  function save() { store.put('notion:out', S.outbox); }
  let timer = 0;
  const schedule = (ms = 1200) => { clearTimeout(timer); timer = setTimeout(flush, ms); };
  function queue(op) {
    if (!S.outbox.some((o) => o.k === op.k && o.tid === op.tid && o.id === op.id && o.nid === op.nid)) { S.outbox.push(op); save(); }
    schedule();
  }
  const drop = (op) => { S.outbox = S.outbox.filter((o) => o !== op); save(); };
  // Von write() aufgerufen / 앱에서 저장할 때마다 불림
  function changed(entries, before) {
    entries.forEach(([p, v], i) => {
      if (p[0] !== 'trips') return;
      const tid = p[1], tr = trips[tid], old = before ? before[i] : undefined;
      if (p.length === 2) {
        if (v == null && old && old.notion) queue({ k: 'delTrip', tid, nid: old.notion.page });
        else if (v && !v.notion && v.title && v.from !== 'notion' && !v.local && !old) queue({ k: 'newTrip', tid }); // local: nur in der App / 앱에만
        return;
      }
      if (!tr) return;
      if ((p[2] === 'items' || p[2] === 'checks') && p.length >= 4) {
        const kind = p[2] === 'items' ? 'item' : 'check';
        if (p.length === 4 && v == null) { if (old && old.nid) queue({ k: kind === 'item' ? 'delItem' : 'delCheck', tid, nid: old.nid }); }
        else if (p[4] !== 'mt') queue({ k: kind, tid, id: p[3] });
      } else if (p[2] === 'icon') queue({ k: 'trip', tid }); // Titel bleibt in Notion wie er ist / 여행 제목은 노션에 안 보냄
    });
  }
  function notionDates(it, s) {
    if (s.dateType === 'date') return { date: it.date ? { start: it.date, end: it.end && it.end !== it.date ? it.end : null } : null };
    const isos = [];
    if (it.date) {
      if (it.cat === 'stay' && isDate(it.end)) for (let d = it.date; d <= it.end && isos.length < 60; d = addDays(d, 1)) isos.push(d);
      else { isos.push(it.date); if (it.cat === 'move' && isDate(it.end)) isos.push(it.end); }
    }
    const ko = (d) => { const x = pd(d); return `${x.getMonth() + 1}월 ${x.getDate()}일` + (s.wd ? ' ' + '일월화수목금토'[x.getDay()] : ''); };
    const names = [...new Set([...isos.map(ko), ...(it.xdates || [])])];
    return { multi_select: names.map((name) => ({ name: String(name).replace(/,/g, ' ').slice(0, 100) })) };
  }
  function costFor(it, s, tr) {
    const c = it.cost;
    if (!c || !c.amount) return null;
    const col = s.cur || tr.cur || 'EUR', rate = s.rate || tr.rate;
    if (c.cur === col) return c.amount;
    if (col === 'EUR' && c.cur === tr.cur && rate) return Math.round(c.amount * rate * 100) / 100;
    if (c.cur === 'EUR' && col === tr.cur && rate) return Math.round(c.amount / rate);
    return c.amount;
  }
  // Nur geänderte Spalten / 바뀐 칸만
  function propsFor(it, s, tr, onlyChanged) {
    const prev = (onlyChanged && it.nsnap) || {}, now = snapOf(it);
    const ch = (k) => !onlyChanged || now[k] !== prev[k];
    const P = {};
    if (s.title && ch('title')) P[s.title] = { title: rt(it.title) };
    if (s.cat && ch('cat')) P[s.cat] = { select: { name: notionCat(it.cat, it.ncat) } };
    if (s.time && ch('time')) P[s.time] = { rich_text: rt(it.time) };
    if (s.notes && ch('notes')) P[s.notes] = { rich_text: rt(it.notes) };
    if (s.date && (ch('date') || ch('end') || ch('cat'))) P[s.date] = notionDates(it, s);
    if (s.book && ch('booked')) P[s.book] = { checkbox: !!it.booked };
    if (s.files && ch('links')) P[s.files] = { files: (it.links || []).slice(0, 20).map((u) => ({ name: (hostOf(u) || 'link').slice(0, 90), type: 'external', external: { url: u } })) };
    else if (!s.files && s.url && ch('links')) P[s.url] = { url: (it.links || [])[0] || null };
    if (s.num && ch('cost')) P[s.num] = { number: costFor(it, s, tr) };
    return P;
  }
  function afterSave(tid, id, pg, db, grp) {
    const it = trips[tid] && trips[tid].items && trips[tid].items[id];
    if (!it) return;
    const e = [[['trips', tid, 'items', id, 'nsnap'], snapOf(it)], [['trips', tid, 'items', id, 'nt'], pg.last_edited_time]];
    if (db) e.push([['trips', tid, 'items', id, 'nid'], pg.id], [['trips', tid, 'items', id, 'ndb'], db], [['trips', tid, 'items', id, 'grp'], grp || '']);
    write(e, { sync: true });
  }
  // Neue Reise aus der App → neue Notion-Seite in 엄마's Form / 앱에서 만든 새 여행 → 엄마 폼으로 노션 페이지
  async function createTrip(tr) {
    if (!Object.keys(S.callouts).length) await readRoot();
    const titleProp = { title: { title: rt(tr.title) } };
    let page;
    try { page = await call('POST', 'pages', { parent: { page_id: ROOT }, icon: { type: 'emoji', emoji: tr.icon || '✈️' }, properties: titleProp }); }
    catch (e) { if (e.code !== 'notion') throw e; page = await call('POST', 'pages', { parent: { page_id: ROOT }, properties: titleProp }); }
    const c = tr.cur || 'EUR';
    const [numName, fmt] = { JPY: ['엔', 'yen'], KRW: ['원', 'won'], EUR: ['Euro', 'euro'], USD: ['달러', 'dollar'], GBP: ['파운드', 'pound'], CHF: ['프랑', 'franc'], CZK: ['코루나', 'koruna'] }[c] || [c, 'number'];
    const props = {
      Name: { title: {} },
      구분: { select: { options: [{ name: '이동', color: 'purple' }, { name: '숙소', color: 'brown' }, { name: '맛집', color: 'blue' }, { name: '카페', color: 'yellow' }, { name: '관광', color: 'orange' }, { name: '쇼핑', color: 'pink' }] } },
      시간: { rich_text: {} }, 주요내용: { rich_text: {} }, 일정: { multi_select: { options: [] } }, 예약: { checkbox: {} },
      'Dateien und Medien': { files: {} }, [numName]: { number: { format: fmt } },
    };
    let db;
    const withEuro = c !== 'EUR' && tr.rate ? { ...props, 유로: { formula: { expression: `prop("${numName}") * ${tr.rate}` } } } : props;
    try { db = await call('POST', 'databases', { parent: { type: 'page_id', page_id: page.id }, is_inline: true, title: rt(tr.title), properties: withEuro }); }
    catch (e) { if (e.code !== 'notion' || withEuro === props) throw e; db = await call('POST', 'databases', { parent: { type: 'page_id', page_id: page.id }, is_inline: true, title: rt(tr.title), properties: props }); }
    // Verweis im Jahres-Kasten / 그 해 칸에 링크 넣기
    const y = String((tr.start || '').slice(0, 4) || tr.year || new Date().getFullYear());
    const link = { object: 'block', type: 'link_to_page', link_to_page: { type: 'page_id', page_id: page.id } };
    try {
      if (S.callouts[y]) await call('PATCH', `blocks/${S.callouts[y]}/children`, { children: [link] });
      else {
        const r = await call('PATCH', `blocks/${ROOT}/children`, { children: [{ object: 'block', type: 'callout', callout: { rich_text: rt(`${y}년`), icon: { type: 'emoji', emoji: '🗓️' }, children: [link] } }] });
        if (r.results && r.results[0]) { S.callouts[y] = r.results[0].id; store.put('notion:callouts', S.callouts); }
      }
    } catch (e) { console.warn('notion: year link', e); }
    const full = await call('GET', `databases/${db.id}`);
    return { page: page.id, db: db.id, dbs: { [db.id]: schemaOf(full, '') }, pages: [page.id], read: Date.now(), edited: page.last_edited_time };
  }
  async function runOp(op) {
    const tr = trips[op.tid];
    if (op.k === 'delTrip' || op.k === 'delItem') { await call('PATCH', `pages/${op.nid}`, { archived: true }); return false; }
    if (op.k === 'delCheck') { await call('DELETE', `blocks/${op.nid}`); return false; }
    if (op.k === 'newTrip') {
      if (!tr || tr.notion || tr.from === 'notion' || tr.local) return false;
      const n = await createTrip(tr);
      write([[['trips', op.tid, 'notion'], n]], { sync: true });
      for (const x of items(trips[op.tid])) queue({ k: 'item', tid: op.tid, id: x.id });
      for (const x of Object.values(trips[op.tid].checks || {})) if (x && x.id) queue({ k: 'check', tid: op.tid, id: x.id });
      return false;
    }
    if (!tr) return false;
    if (!tr.notion) return S.outbox.some((o) => o.k === 'newTrip' && o.tid === op.tid); // auf die neue Seite warten / 새 페이지를 기다림
    if (op.k === 'trip') {
      try { await call('PATCH', `pages/${tr.notion.page}`, { icon: { type: 'emoji', emoji: tr.icon || '✈️' } }); }
      catch (e) { if (e.code !== 'notion') throw e; }
      return false;
    }
    if (op.k === 'item') {
      const it = tr.items && tr.items[op.id];
      if (!it) return false;
      const db = it.ndb && tr.notion.dbs[it.ndb] ? it.ndb : tr.notion.db, s = tr.notion.dbs[db];
      if (!s) return false;
      if (!it.nid && s.overview) return false; // nur in der App / 앱에만
      if (it.nid) {
        const P = propsFor(it, s, tr, true);
        if (Object.keys(P).length) afterSave(op.tid, it.id, await call('PATCH', `pages/${it.nid}`, { properties: P }));
      } else afterSave(op.tid, it.id, await call('POST', 'pages', { parent: { database_id: db }, properties: propsFor(it, s, tr, false) }), db, s.grp);
      return false;
    }
    if (op.k === 'check') {
      const c = tr.checks && tr.checks[op.id];
      if (!c) return false;
      const todo = { rich_text: rt(c.text), checked: !!c.done };
      if (c.nid) await call('PATCH', `blocks/${c.nid}`, { to_do: todo });
      else {
        const parent = (c.grp && (tr.notion.grpPages || {})[c.grp]) || tr.notion.page; // Unterseite der Gruppe / 묶음의 하위 페이지
        const r = await call('PATCH', `blocks/${parent}/children`, { children: [{ object: 'block', type: 'to_do', to_do: todo }] });
        const nb = r.results && r.results[0];
        if (nb) write([[['trips', op.tid, 'checks', op.id, 'nid'], nb.id]], { sync: true });
      }
      return false;
    }
    return false;
  }
  async function flush() {
    if (S.state !== 'ok' || S.pushing || S.pulling || !S.linked || !S.outbox.length) return;
    S.pushing = true; refresh();
    const rank = { newTrip: 0, trip: 1, item: 2, check: 2, delItem: 3, delCheck: 3, delTrip: 4 };
    try {
      for (const op of S.outbox.slice().sort((a, b) => rank[a.k] - rank[b.k])) {
        if (!S.outbox.includes(op)) continue;
        try { if (!(await runOp(op))) drop(op); }
        catch (e) {
          if (e.code === 'gone' || e.code === 'notion') { console.warn('notion: dropped', op, e.detail); drop(op); continue; }
          S.err = e.code || 'net'; console.warn('notion push', op, e); break;
        }
      }
    } finally {
      S.pushing = false; refresh();
      if (S.outbox.length && !S.err) schedule(4000);
    }
  }

  // ---------- Start, Anzeige / 시작, 화면 ----------
  async function check() {
    const c = window.cloud;
    if (!c || !c.user || !c.house || !c.idToken) { S.state = 'off'; refresh(); return; }
    S.state = 'checking'; refresh();
    try {
      const r = await fetch(NW + '/ping', { method: 'POST', headers: { Authorization: 'Bearer ' + await c.idToken() } });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { S.state = 'ok'; S.err = ''; } else { S.state = 'error'; S.err = j.error || 'net'; }
    } catch { S.state = 'error'; S.err = 'net'; }
    refresh();
  }
  async function start() { await check(); if (S.state === 'ok') pull(); }
  // Beim Öffnen einer Reise: diese Reise neu lesen, wenn das letzte Lesen über 2 Minuten her ist
  // 여행을 열 때: 마지막으로 읽은 지 2분이 넘었으면 그 여행만 다시 읽기
  function opened(tid) {
    const tr = trips[tid];
    if (S.state === 'ok' && tr && tr.notion && Date.now() - (tr.notion.read || 0) > 2 * 60 * 1000) pull({ trip: tr });
  }
  // Nach einem Fehler beim Prüfen (Worker kurz weg) später von selbst neu starten / 확인이 한 번 실패해도 나중에 저절로 다시 시작
  const retry = () => { if (S.state === 'error' && window.cloud && window.cloud.user) start(); };
  setInterval(() => { if (document.visibilityState !== 'visible') return; if (S.state === 'ok') pull(); else retry(); }, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') return; if (S.state === 'ok') { if (Date.now() - S.lastPull > 60 * 1000) pull(); } else retry(); });
  window.addEventListener('online', () => { if (S.state === 'ok') { S.err = ''; flush(); } else if (window.cloud && window.cloud.user) start(); });

  const errText = (code) => { const m = t('nErr'); return (m && m[code]) || m.net; };
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return t('nJustNow');
    const f = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    return m < 60 ? f.format(-m, 'minute') : m < 48 * 60 ? f.format(-Math.round(m / 60), 'hour') : f.format(-Math.round(m / 1440), 'day');
  }
  function bannerHtml() {
    if (S.progress) return `<div class="banner" style="background:var(--soft);color:var(--accent)">${esc(S.progress)}</div>`;
    if (S.state === 'ok' && S.err) return `<div class="banner">${esc('Notion: ' + errText(S.err))}</div>`;
    return '';
  }
  function settingsHtml() {
    const c = window.cloud;
    if (!c || !c.user) return `<p class="note">${esc(t('nNeedLogin'))}</p>`;
    let h = `<p class="note">${esc(t('nInfo'))}</p>`;
    if (S.state === 'off' || S.state === 'checking') return h + `<p class="note">${esc(t('nChecking'))}</p>`;
    if (S.state === 'error') return h + `<p class="note todo">${esc(errText(S.err))}</p><div class="set-row" style="margin-top:8px"><button class="btn small ghost" data-act="n-now">${esc(t('nNow'))}</button></div>`;
    h += `<p style="margin:8px 0 0;font-weight:700" class="ok">${esc(t('nOk'))}</p>`;
    if (S.lastPull) h += `<p class="note">${esc(t('nLast', { x: ago(S.lastPull) }))}</p>`;
    if (S.progress) h += `<p class="note">${esc(S.progress)}</p>`;
    else if (S.pushing) h += `<p class="note">${esc(t('nPushing'))}</p>`;
    if (S.outbox.length) h += `<p class="note">${esc(t('nPending', { n: S.outbox.length }))}</p>`;
    if (S.err) h += `<p class="note todo">${esc(errText(S.err))}</p>`;
    h += `<div class="set-row" style="margin-top:8px"><button class="btn small" data-act="n-now" ${S.pulling ? 'disabled' : ''}>${esc(t('nNow'))}</button>
      <button class="btn small ghost" data-act="n-full" ${S.pulling ? 'disabled' : ''}>${esc(t('nFull'))}</button></div>`;
    return h;
  }

  // Kleines Wolken-Symbol oben: gespeichert / läuft / wartet / Problem — Tippen öffnet die Einstellungen
  // 위쪽 작은 구름 아이콘: 저장됨 / 맞추는 중 / 보낼 것 있음 / 문제 — 누르면 설정
  function statusHtml() {
    if (S.state === 'off' || S.state === 'checking') return '';
    let icn = 'cloud_done', cls = 'ok', label = t('nSaved');
    if (S.state === 'error' || S.err) { icn = 'cloud_off'; cls = 'bad'; label = t('nProblem'); }
    else if (S.pulling || S.pushing) { icn = 'cloud_sync'; cls = 'busy'; label = t('nSyncing'); }
    else if (S.outbox.length) { icn = 'cloud_upload'; cls = 'busy'; label = t('nWaiting', { n: S.outbox.length }); }
    return `<button class="nst ${cls}" data-act="settings" aria-label="${esc(label)}" title="${esc(label)}">${ms(icn)}</button>`;
  }
  window.notionSync = { start, pull, changed, opened, bannerHtml, settingsHtml, statusHtml, _S: S, _readTrip: readTrip, _readRoot: readRoot };
})();
