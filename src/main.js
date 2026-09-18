import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { save } from '@tauri-apps/plugin-dialog'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const $ = (s) => document.querySelector(s)
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e }

let captures = []
let totals = {}
let series = []
let selected = null
let filters = []        // [{key, val}]
let hist = null
let range = 'session'
let following = true     // tail -f 처럼 새 항목을 자동으로 따라간다

/* ---------- 포맷 ---------- */
const nf = new Intl.NumberFormat('ko-KR')
const fmtN = (n) => nf.format(Math.round(n || 0))
const fmtB = (b) => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}K` : `${(b / 1048576).toFixed(1)}M`
const fmtUsd = (n) => '$' + (n || 0).toFixed(4)
const fmtDur = (s) => {
  s = Math.round(s || 0)
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`
  return `${Math.floor(s / 3600)}시 ${Math.floor((s % 3600) / 60)}분`
}

/* ---------- 통계 카드 열 수 ---------- */
const STAT_MIN_W = 118   // 카드 최소 폭(px)
const STAT_GAP = 1

/**
 * 카드 n 개를 폭 w 에 배치할 때 쓸 열 수를 고른다.
 *
 * 폭에 들어가는 최대 열 수(maxFit)부터 훑으며, 마지막 줄에 남는 칸이 가장 적은 값을 쓴다.
 * 남는 칸이 같으면 더 넓게(열이 많게) 쓴다. 이렇게 하면 "마지막 줄에 1개만" 남지 않는다.
 */
function pickCols (n, w) {
  const maxFit = Math.max(1, Math.floor((w + STAT_GAP) / (STAT_MIN_W + STAT_GAP)))
  if (n <= maxFit) return n            // 한 줄에 다 들어가면 그대로
  let best = maxFit
  let bestWaste = Infinity
  for (let c = maxFit; c >= 2; c--) {
    const rem = n % c
    const waste = rem === 0 ? 0 : c - rem   // 마지막 줄의 빈 칸 수
    if (waste < bestWaste) { bestWaste = waste; best = c }
    if (bestWaste === 0) break
  }
  return best
}

function layoutStats () {
  const box = $('#stats')
  const n = box.children.length
  if (!n) return
  const w = box.clientWidth
  if (!w) return
  box.style.setProperty('--stat-cols', String(pickCols(n, w)))
}

/* ---------- 필터 ---------- */
function matches (c) {
  return filters.every(f => c.attrs.some(([k, v]) => k === f.key && v === f.val))
}
function visible () { return captures.filter(matches) }

function refreshFilterOptions () {
  const bar = $('#filterbar')
  bar.hidden = captures.length === 0
  const keys = new Map()
  for (const c of captures) {
    for (const [k, v] of c.attrs) {
      if (!keys.has(k)) keys.set(k, new Set())
      keys.get(k).add(v)
    }
  }
  const kSel = $('#fKey')
  const cur = kSel.value
  kSel.textContent = ''
  const ph = document.createElement('option'); ph.value = ''; ph.textContent = '속성 선택…'
  kSel.append(ph)
  for (const k of [...keys.keys()].sort()) {
    const o = document.createElement('option'); o.value = k; o.textContent = k
    kSel.append(o)
  }
  if (keys.has(cur)) kSel.value = cur
  fillValues(keys)
  kSel.onchange = () => fillValues(keys)
}

function fillValues (keys) {
  const k = $('#fKey').value
  const vSel = $('#fVal')
  vSel.textContent = ''
  vSel.disabled = !k
  if (!k) { const o = document.createElement('option'); o.textContent = '값'; vSel.append(o); return }
  for (const v of [...keys.get(k)].sort()) {
    const o = document.createElement('option'); o.value = v; o.textContent = v
    vSel.append(o)
  }
}

function renderChips () {
  const box = $('#fChips')
  box.textContent = ''
  for (const f of filters) {
    const c = el('span', 'fchip')
    c.append(document.createTextNode(`${f.key}=${f.val}`))
    const x = el('button'); x.type = 'button'; x.textContent = '×'
    x.title = '제거'
    x.addEventListener('click', () => {
      filters = filters.filter(z => !(z.key === f.key && z.val === f.val))
      renderAll()
    })
    c.append(x); box.append(c)
  }
  $('#fClear').hidden = filters.length === 0
}

/* ---------- 상단 통계 ---------- */
function computeTotals () {
  if (filters.length === 0) return totals
  // 필터가 걸리면 보이는 캡처의 시리즈 최신값으로 다시 합산 (cumulative)
  const latest = new Map()
  let requests = 0, bytes = 0, leaks = 0, fails = 0
  for (const c of visible()) {
    requests++; bytes += c.bytes
    if (c.leaks.length) leaks++
    if (c.forwarded.kind === 'failed') fails++
    const sess = (c.attrs.find(([k]) => k === 'session.id') || [])[1] || ''
    for (const m of c.metrics) {
      const disc = m.attrs.filter(([k]) => k === 'type' || k === 'start_type')
        .map(([k, v]) => `${k}=${v}`).join(',')
      latest.set(`${m.name}|${sess}|${disc}`, { v: m.value, disc })
    }
  }
  const t = { requests, bytes, leak_events: leaks, forward_failures: fails,
    tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_creation: 0,
    cost_usd: 0, sessions: 0, commits: 0, prs: 0,
    lines_added: 0, lines_removed: 0, active_seconds: 0 }
  for (const [key, { v, disc }] of latest) {
    const name = key.split('|')[0]
    const kind = (disc.split(',').find(p => p.startsWith('type=')) || '').slice(5)
    if (name === 'claude_code.token.usage') {
      if (kind === 'input') t.tokens_in += v
      else if (kind === 'output') t.tokens_out += v
      else if (kind === 'cacheRead') t.tokens_cache_read += v
      else if (kind === 'cacheCreation') t.tokens_cache_creation += v
    } else if (name === 'claude_code.cost.usage') t.cost_usd += v
    else if (name === 'claude_code.session.count') t.sessions += v
    else if (name === 'claude_code.commit.count') t.commits += v
    else if (name === 'claude_code.pull_request.count') t.prs += v
    else if (name === 'claude_code.lines_of_code.count') {
      if (kind === 'removed') t.lines_removed += v; else t.lines_added += v
    } else if (name === 'claude_code.active_time.total') t.active_seconds += v
  }
  return t
}

const CARD_DEFS = [
  { id: 'requests', label: '받은 요청' },
  { id: 'bytes',    label: '누적 용량' },
  { id: 'tokens',   label: '토큰',      cls: 'accent' },
  { id: 'cost',     label: '비용',      cls: 'accent' },
  { id: 'sessions', label: '세션' },
  { id: 'commits',  label: '커밋 / PR' },
  { id: 'lines',    label: '코드 변경' },
  { id: 'active',   label: '활동 시간' },
  { id: 'fails',    label: '전달 실패' },
  { id: 'leaks',    label: '내용 유출' }
]

let visibleCards = CARD_DEFS.map(c => c.id)

function loadCardPrefs () {
  try {
    const raw = localStorage.getItem('otel-cards')
    if (!raw) return
    const saved = JSON.parse(raw)
    if (Array.isArray(saved) && saved.length) {
      // 정의에 없는 값은 버린다 (버전이 올라가며 카드가 바뀔 수 있다)
      visibleCards = CARD_DEFS.map(c => c.id).filter(id => saved.includes(id))
    }
  } catch (e) { /* 저장소를 못 읽어도 전체 표시로 동작 */ }
}

function saveCardPrefs () {
  try { localStorage.setItem('otel-cards', JSON.stringify(visibleCards)) } catch (e) {}
}

function cardValue (id, t) {
  switch (id) {
    case 'requests': return [fmtN(t.requests), '']
    case 'bytes':    return [fmtB(t.bytes || 0), '']
    case 'tokens':   return [fmtN((t.tokens_in || 0) + (t.tokens_out || 0)), 'accent']
    case 'cost':     return [fmtUsd(t.cost_usd), 'accent']
    case 'sessions': return [fmtN(t.sessions), '']
    case 'commits':  return [`${fmtN(t.commits)} / ${fmtN(t.prs)}`, '']
    case 'lines':    return [`+${fmtN(t.lines_added)} −${fmtN(t.lines_removed)}`, '']
    case 'active':   return [fmtDur(t.active_seconds), '']
    case 'fails':    return [fmtN(t.forward_failures), t.forward_failures > 0 ? 'danger' : '']
    case 'leaks':    return [fmtN(t.leak_events), t.leak_events > 0 ? 'danger' : '']
    default:         return ['', '']
  }
}

function renderStats () {
  const t = computeTotals()
  const box = $('#stats')
  box.textContent = ''
  for (const def of CARD_DEFS) {
    if (!visibleCards.includes(def.id)) continue
    const [v, cls] = cardValue(def.id, t)
    const d = el('div', 'stat')
    const kk = el('div', 'k'); kk.textContent = def.label
    const vv = el('div', 'v' + (cls ? ' ' + cls : '')); vv.textContent = v
    d.append(kk, vv); box.append(d)
  }
  layoutStats()
}

function renderCardMenu () {
  const m = $('#cardMenu')
  m.textContent = ''
  const h = el('div', 'mhead'); h.textContent = '표시할 카드'
  m.append(h)
  for (const def of CARD_DEFS) {
    const l = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = visibleCards.includes(def.id)
    cb.addEventListener('change', () => {
      visibleCards = cb.checked
        ? CARD_DEFS.map(c => c.id).filter(id => id === def.id || visibleCards.includes(id))
        : visibleCards.filter(id => id !== def.id)
      saveCardPrefs()
      renderStats()
    })
    const sp = document.createElement('span'); sp.textContent = def.label
    l.append(cb, sp); m.append(l)
  }
  const foot = el('div', 'mfoot')
  const all = document.createElement('button'); all.type = 'button'; all.textContent = '전체'
  all.addEventListener('click', () => {
    visibleCards = CARD_DEFS.map(c => c.id)
    saveCardPrefs(); renderStats(); renderCardMenu()
  })
  const none = document.createElement('button'); none.type = 'button'; none.textContent = '해제'
  none.addEventListener('click', () => {
    visibleCards = []
    saveCardPrefs(); renderStats(); renderCardMenu()
  })
  foot.append(all, none); m.append(foot)
}

/* ---------- 유출 배너 ---------- */
function renderLeakBar () {
  const bar = $('#leakBar')
  const all = []
  for (const c of visible()) for (const l of c.leaks) if (!all.includes(l)) all.push(l)
  if (all.length === 0) { bar.className = ''; bar.textContent = ''; return }
  bar.className = 'show'
  bar.textContent = ''
  const b = el('b'); b.textContent = '⚠ 내용 유출 감지 — '
  bar.append(b, document.createTextNode(all.join(' · ')))
}

/* ---------- 수신 스트림 ---------- */
function rowFor (c) {
  const r = el('div', 'row' + (selected === c.id ? ' sel' : ''))
  r.dataset.id = c.id

  const t = el('div', 't'); t.textContent = c.ts
  const s = el('div', 'sig ' + c.signal); s.textContent = c.signal
  const by = el('div', 'by'); by.textContent = fmtB(c.bytes)

  const names = el('div', 'names')
  if (c.metrics.length) {
    const uniq = [...new Set(c.metrics.map(m => m.name.replace('claude_code.', '')))]
    names.textContent = uniq.join(', ')
  } else if (c.event_count) {
    names.textContent = `${c.event_count} events`
  } else {
    names.textContent = '—'
  }

  const fw = el('div', 'fw')
  const f = c.forwarded
  if (f.kind === 'ok') { fw.classList.add('ok'); fw.textContent = `${f.status} ${f.ms}ms` }
  else if (f.kind === 'failed') { fw.classList.add('fail'); fw.textContent = '실패' }
  else { fw.classList.add('off'); fw.textContent = '—' }

  r.append(t, s, by, names, fw)
  r.addEventListener('click', () => {
    selected = c.id
    following = false      // 특정 항목을 보는 중 — 새 항목이 와도 옮기지 않는다
    syncFollow()
    renderStream()
    if (window.matchMedia('(max-width: 860px)').matches) {
      document.querySelector('.tab[data-pane="inspect"]').click()
    } else {
      renderInspector()
    }
  })
  return r
}

function renderStream () {
  const box = $('#rows')
  box.textContent = ''
  const vis = visible()
  $('#streamCount').textContent = filters.length
    ? `${vis.length} / ${captures.length}건`
    : `${captures.length}건`
  $('#streamEmpty').hidden = vis.length > 0
  for (const c of [...vis].reverse()) box.append(rowFor(c))
}

function forwardOffReason () {
  const on = $('#cfgFwd').checked
  const empty = $('#cfgUp').value.trim() === ''
  if (on && empty) return '전달 안 함 — 서버 주소가 비어 있음'
  return '전달 안 함 — 전달이 꺼져 있음'
}

/* ---------- 인스펙터 ---------- */
function sec (title) {
  const s = el('div', 'sec')
  const h = el('h3'); h.textContent = title
  s.append(h)
  return s
}

function inspectorBox () {
  // 좁은 화면에서는 사이드 패널이 숨겨지므로 탭 쪽에 그린다
  return window.matchMedia('(max-width: 860px)').matches
    ? $('#paneInspect')
    : $('#inspector')
}

function closeInspector () {
  selected = null
  const tab = document.querySelector('.tab[data-pane="stream"]')
  if (tab) tab.click()
  renderInspector()
}

function renderInspector () {
  const box = inspectorBox()
  const narrow = box.id === 'paneInspect'
  box.textContent = ''
  const c = captures.find(x => x.id === selected)

  // 좁은 화면에서는 인스펙터가 스트림을 덮으므로 돌아가는 길을 함께 둔다
  if (narrow) {
    const bar = el('div', 'backbar')
    const t = el('span', 'ttl')
    t.textContent = c ? `${c.ts} · ${c.signal}` : '선택된 항목 없음'
    const x = el('button'); x.type = 'button'
    x.textContent = '✕ 닫기'
    x.title = '수신 스트림으로 돌아가기 (Esc)'
    x.addEventListener('click', closeInspector)
    bar.append(t, x)
    box.append(bar)
  }

  if (!c) {
    const e = el('div', 'empty'); e.textContent = '행을 선택하면 상세가 표시됩니다.'
    box.append(e); return
  }

  // 요약
  const s1 = sec('요청 정보')
  const dl = el('dl', 'kv')
  const add = (k, v, cls) => {
    const dt = el('dt'); dt.textContent = k
    const dd = el('dd', cls); dd.textContent = v
    dl.append(dt, dd)
  }
  add('시각', c.ts)
  add('신호', c.signal)
  add('경로', c.path)
  add('크기', `${c.bytes.toLocaleString()} bytes`)
  const f = c.forwarded
  add('서버 전달',
    f.kind === 'ok' ? `HTTP ${f.status} (${f.ms}ms)`
      : f.kind === 'failed' ? `실패: ${f.error}` : '전달 안 함')
  s1.append(dl); box.append(s1)

  // 유출
  if (c.leaks.length) {
    const s = sec('⚠ 내용 유출 경고')
    for (const l of c.leaks) {
      const p = el('div'); p.style.color = 'var(--danger)'
      p.style.fontSize = '11.5px'; p.style.marginBottom = '4px'
      p.textContent = l; s.append(p)
    }
    box.append(s)
  }

  // 개인 식별
  if (c.pii.length) {
    const s = sec('개인 식별 정보')
    const d = el('dl', 'kv')
    for (const p of c.pii) {
      const [k, ...rest] = p.split(' = ')
      const dt = el('dt'); dt.textContent = k
      const dd = el('dd', 'pii'); dd.textContent = rest.join(' = ')
      d.append(dt, dd)
    }
    s.append(d); box.append(s)
  }

  // 메트릭
  if (c.metrics.length) {
    const s = sec(`메트릭 (${c.metrics.length})`)
    for (const m of c.metrics) {
      const row = el('div', 'mrow')
      const n = el('div', 'n')
      n.textContent = m.name.replace('claude_code.', '')
      const attrs = m.attrs.filter(([k]) => k === 'type' || k === 'model')
      if (attrs.length) n.textContent += ` [${attrs.map(([, v]) => v).join(',')}]`
      const v = el('div', 'v')
      v.textContent = fmtN(m.value) + (m.unit ? ` ${m.unit}` : '')
      row.append(n, v); s.append(row)
    }
    box.append(s)
  }

  // 전체 속성
  if (c.attrs.length) {
    const s = sec(`속성 (${c.attrs.length})`)
    const d = el('dl', 'kv')
    for (const [k, v] of c.attrs) {
      const dt = el('dt'); dt.textContent = k
      const isPii = ['user.email', 'user.account_uuid', 'user.account_id', 'organization.id', 'user.id'].includes(k)
      const dd = el('dd', isPii ? 'pii' : ''); dd.textContent = v
      d.append(dt, dd)
    }
    s.append(d); box.append(s)
  }
}

/* ---------- 차트 ---------- */
const NS = 'http://www.w3.org/2000/svg'
const mk = (n, a) => {
  const e = document.createElementNS(NS, n)
  for (const k in a) e.setAttribute(k, a[k])
  return e
}

/** 시리즈 색은 테마 토큰에서 읽는다 — 라이트/다크 양쪽에서 검증된 값만 쓴다. */
function palette () {
  const cs = getComputedStyle(document.documentElement)
  const g = (n, f) => cs.getPropertyValue(n).trim() || f
  return {
    accent: g('--accent', '#35b5ac'),
    accent2: g('--accent-2', '#7fd8d2'),
    warn: g('--warn', '#d19a4a'),
    danger: g('--danger', '#d4604f'),
    ok: g('--ok', '#4ea86a'),
    grid: g('--line', '#262c35'),
    ink3: g('--text-3', '#6f7885')
  }
}

/** 원본 데이터에서 차트용 시리즈를 만든다. */
function chartData () {
  if (range === 'session') {
    return series.map(p => ({
      ts: p.ts,
      tokens_in: p.tokens_in ?? 0,
      tokens_out: p.tokens_out ?? 0,
      tokens: p.tokens,
      cost: p.cost,
      active: p.active ?? 0,
      added: p.added ?? 0,
      removed: p.removed ?? 0
    }))
  }
  const days = parseInt(range, 10)
  if (!hist || !hist.days) return []
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const acctFilter = filters.filter(f => f.key === 'user.email').map(f => f.val)
  const out = []
  for (const date of Object.keys(hist.days).sort()) {
    if (date < cutoff) continue
    const row = { ts: date.slice(5), tokens_in: 0, tokens_out: 0, cost: 0, active: 0, added: 0, removed: 0 }
    for (const [acct, st] of Object.entries(hist.days[date])) {
      if (acctFilter.length && !acctFilter.includes(acct)) continue
      row.tokens_in += st.tokens_in || 0
      row.tokens_out += st.tokens_out || 0
      row.cost += st.cost_usd || 0
      row.active += st.active_seconds || 0
      row.added += st.lines_added || 0
      row.removed += st.lines_removed || 0
    }
    row.tokens = row.tokens_in + row.tokens_out
    out.push(row)
  }
  return out
}

/**
 * 면적/선 차트 하나를 그린다.
 *
 * pts   : [{ts, ...}]
 * specs : [{key, name, color}] — 한 차트의 시리즈들
 * fmt   : 값 포맷터
 */
function drawChart (svgId, pts, specs, fmt, opts = {}) {
  const svg = $(svgId)
  const host = svg.parentElement
  svg.textContent = ''
  host.querySelector('.tip')?.remove()

  const vb = svg.getAttribute('viewBox').split(' ').map(Number)
  const W = vb[2], H = vb[3]
  const P = { t: 12, r: 58, b: 22, l: 12 }
  const p = palette()

  if (pts.length < 2) {
    const t = mk('text', {
      x: W / 2, y: H / 2, 'text-anchor': 'middle',
      fill: p.ink3, 'font-size': '11.5', 'font-family': 'monospace'
    })
    t.textContent = range === 'session' ? '데이터를 모으는 중입니다' : '이 기간에 기록이 없습니다'
    svg.append(t)
    return
  }

  const iw = W - P.l - P.r, ih = H - P.t - P.b
  let max = 0
  for (const s of specs) for (const d of pts) max = Math.max(max, d[s.key] || 0)
  if (opts.symmetric) { /* 증감 차트는 0 기준 양방향 */ }
  if (max <= 0) max = 1

  const X = i => P.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw)
  const Y = v => P.t + ih - (v / max) * ih

  // 그리드 + 눈금 (모든 라벨이 실제 도달하는 값)
  for (let g = 0; g <= 3; g++) {
    const v = (max / 3) * g
    const y = Y(v)
    svg.append(mk('line', { x1: P.l, y1: y, x2: P.l + iw, y2: y, stroke: p.grid, 'stroke-width': 1 }))
    const lb = mk('text', {
      x: P.l + iw + 7, y: y + 3.5, fill: p.ink3,
      'font-size': '10', 'font-family': 'monospace'
    })
    lb.textContent = fmt(v, true)
    svg.append(lb)
  }

  // 시리즈
  for (const sp of specs) {
    const path = pts.map((d, i) => `${X(i)},${Y(d[sp.key] || 0)}`).join(' ')
    if (specs.length === 1) {
      svg.append(mk('polygon', {
        points: `${P.l},${P.t + ih} ${path} ${P.l + iw},${P.t + ih}`,
        fill: sp.color, opacity: 0.12
      }))
    }
    svg.append(mk('polyline', {
      points: path, fill: 'none', stroke: sp.color,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }))
    const li = pts.length - 1
    svg.append(mk('circle', { cx: X(li), cy: Y(pts[li][sp.key] || 0), r: 3, fill: sp.color }))
  }

  // x 축 양끝 라벨
  const t0 = mk('text', { x: P.l, y: H - 5, fill: p.ink3, 'font-size': '10', 'font-family': 'monospace' })
  t0.textContent = pts[0].ts
  const t1 = mk('text', {
    x: P.l + iw, y: H - 5, fill: p.ink3, 'font-size': '10',
    'font-family': 'monospace', 'text-anchor': 'end'
  })
  t1.textContent = pts[pts.length - 1].ts
  svg.append(t0, t1)

  // ---- 호버: 크로스헤어 + 툴팁 ----
  const hair = mk('line', {
    y1: P.t, y2: P.t + ih, stroke: p.ink3, 'stroke-width': 1,
    'stroke-dasharray': '3 3', opacity: 0
  })
  svg.append(hair)
  const dots = specs.map(sp => {
    const c = mk('circle', { r: 4, fill: sp.color, stroke: 'var(--panel)', 'stroke-width': 2, opacity: 0 })
    svg.append(c)
    return c
  })

  const tip = el('div', 'tip')
  host.append(tip)

  const hit = mk('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' })
  svg.append(hit)

  const show = (clientX) => {
    const r = svg.getBoundingClientRect()
    const rel = (clientX - r.left) / r.width * W          // viewBox 좌표로 환산
    let idx = Math.round(((rel - P.l) / iw) * (pts.length - 1))
    idx = Math.max(0, Math.min(pts.length - 1, idx))
    const d = pts[idx]
    const x = X(idx)

    hair.setAttribute('x1', x); hair.setAttribute('x2', x); hair.setAttribute('opacity', 0.55)
    specs.forEach((sp, k) => {
      dots[k].setAttribute('cx', x)
      dots[k].setAttribute('cy', Y(d[sp.key] || 0))
      dots[k].setAttribute('opacity', 1)
    })

    tip.textContent = ''
    const dt = el('div', 'tdate'); dt.textContent = d.ts
    tip.append(dt)
    for (const sp of specs) {
      const row = el('div', 'trow')
      const i = el('i'); i.style.background = sp.color
      const n = el('span', 'tname'); n.textContent = sp.name
      const v = el('span', 'tval'); v.textContent = fmt(d[sp.key] || 0)
      row.append(i, n, v); tip.append(row)
    }
    tip.classList.add('on')

    // 화면 밖으로 나가지 않게
    const px = (x / W) * r.width
    const tw = tip.offsetWidth || 130
    tip.style.left = Math.max(4, Math.min(r.width - tw - 4, px + 12)) + 'px'
    tip.style.top = '6px'
  }
  const hide = () => {
    hair.setAttribute('opacity', 0)
    dots.forEach(c => c.setAttribute('opacity', 0))
    tip.classList.remove('on')
  }

  svg.addEventListener('pointermove', e => show(e.clientX))
  svg.addEventListener('pointerleave', hide)
  svg.addEventListener('pointerdown', e => show(e.clientX))
}

function renderLegend (id, specs) {
  const box = $(id)
  if (!box) return
  box.textContent = ''
  for (const sp of specs) {
    const l = el('span', 'lg')
    const i = el('i'); i.style.background = sp.color
    const t = document.createElement('span'); t.textContent = sp.name
    l.append(i, t); box.append(l)
  }
}

const fmtTok = (v, axis) => axis
  ? (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'K' : Math.round(v))
  : fmtN(v)
const fmtCost = (v) => '$' + (v || 0).toFixed(4)
const fmtCostAxis = (v) => '$' + (v || 0).toFixed(v >= 1 ? 1 : 2)
const fmtSec = (v, axis) => axis ? (v >= 3600 ? (v / 3600).toFixed(1) + 'h' : Math.round(v / 60) + 'm') : fmtDur(v)
const fmtLines = (v, axis) => axis ? (v >= 1000 ? (v / 1000).toFixed(1) + 'K' : Math.round(v)) : fmtN(v)

function renderCharts () {
  if (currentPane === 'chart') renderSummary()
  const p = palette()
  const pts = chartData()

  const tokenSpecs = [
    { key: 'tokens_in', name: 'input', color: p.accent },
    { key: 'tokens_out', name: 'output', color: p.accent2 }
  ]
  const hasSplit = pts.some(d => d.tokens_in > 0 || d.tokens_out > 0)
  const tSpecs = hasSplit ? tokenSpecs : [{ key: 'tokens', name: '토큰', color: p.accent }]
  renderLegend('#legTokens', tSpecs.length > 1 ? tSpecs : [])
  drawChart('#chartTokens', pts, tSpecs, fmtTok)

  drawChart('#chartCost', pts, [{ key: 'cost', name: '비용', color: p.warn }],
    (v, axis) => axis ? fmtCostAxis(v) : fmtCost(v))

  drawChart('#chartActive', pts, [{ key: 'active', name: '활동', color: p.ok }], fmtSec)

  const lineSpecs = [
    { key: 'added', name: '추가', color: p.ok },
    { key: 'removed', name: '삭제', color: p.danger }
  ]
  renderLegend('#legLines', lineSpecs)
  drawChart('#chartLines', pts, lineSpecs, fmtLines)

  // 요약
  const last = pts[pts.length - 1] || {}
  const sum = (k) => pts.reduce((a, d) => a + (d[k] || 0), 0)
  $('#sumTokens').textContent = range === 'session'
    ? `현재 ${fmtN(last.tokens || 0)}` : `합계 ${fmtN(sum('tokens_in') + sum('tokens_out'))}`
  $('#sumCost').textContent = range === 'session'
    ? `현재 ${fmtCost(last.cost || 0)}` : `합계 ${fmtCost(sum('cost'))}`
  $('#sumActive').textContent = range === 'session'
    ? `현재 ${fmtDur(last.active || 0)}` : `합계 ${fmtDur(sum('active'))}`
  $('#sumLines').textContent = range === 'session'
    ? `+${fmtN(last.added || 0)} −${fmtN(last.removed || 0)}`
    : `+${fmtN(sum('added'))} −${fmtN(sum('removed'))}`

}

/* ---------- 차트 범위 ---------- */
document.querySelectorAll('#rangeSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#rangeSeg button').forEach(x => x.classList.remove('on'))
    b.classList.add('on')
    range = b.dataset.range
    // 이력 범위는 디스크 기록을 읽어야 한다
    if (range !== 'session') {
      try { hist = await invoke('history') } catch (e) { hist = null }
    }
    renderCharts()
  })
})

/* ---------- 탭 ---------- */
document.querySelectorAll('.tab[data-pane]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab[data-pane]').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const p = tab.dataset.pane
    $('#paneStream').hidden = p !== 'stream'
    $('#paneChart').hidden = p !== 'chart'
    $('#paneSetup').hidden = p !== 'setup'
    $('#paneInspect').hidden = p !== 'inspect'
    syncSidePanel(p)
    if (p === 'chart') renderCharts()
    if (p === 'inspect') renderInspector()
  })
})

/* ---------- 액션 ---------- */
$('#btnClear').addEventListener('click', async () => {
  await invoke('clear')
  captures = []; totals = {}; series = []; selected = null
  following = true; syncFollow()
  renderAll()
})

async function download (kind) {
  const data = kind === 'json' ? await invoke('export_json') : await invoke('export_csv')
  const path = await save({
    defaultPath: `otel-capture.${kind}`,
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }]
  })
  if (!path) return
  const { writeTextFile } = await import('@tauri-apps/plugin-fs').catch(() => ({}))
  if (writeTextFile) { await writeTextFile(path, data); return }
  // fs 플러그인이 없으면 클립보드 대체
  await navigator.clipboard.writeText(data)
  alert('파일 저장 플러그인이 없어 클립보드로 복사했습니다.')
}
$('#btnJson').addEventListener('click', () => download('json'))
$('#btnCsv').addEventListener('click', () => download('csv'))

function syncFwdWarn () {
  const on = $('#cfgFwd').checked
  const empty = $('#cfgUp').value.trim() === ''
  $('#fwdWarn').hidden = !(on && empty)
}
$('#cfgFwd').addEventListener('change', syncFwdWarn)
$('#cfgUp').addEventListener('input', syncFwdWarn)

$('#btnSaveCfg').addEventListener('click', async () => {
  const cfg = await invoke('set_config', {
    cfg: {
      listen_port: parseInt($('#cfgPort').value, 10) || 4318,
      upstream: $('#cfgUp').value.trim(),
      forward_enabled: $('#cfgFwd').checked
    }
  })
  $('#cfgPort').value = cfg.listen_port
  $('#cfgUp').value = cfg.upstream
  $('#cfgFwd').checked = cfg.forward_enabled
  syncFwdWarn()
  $('#btnSaveCfg').textContent = '저장됨 ✓'
  setTimeout(() => { $('#btnSaveCfg').textContent = '저장' }, 1500)
})

async function loadSettingsPaths () {
  let paths = []
  try { paths = await invoke('find_settings') } catch (e) { paths = [] }
  const sel = $('#diagSelect')
  sel.textContent = ''
  if (paths.length === 0) {
    const o = document.createElement('option')
    o.textContent = '찾지 못함 — 경로를 직접 입력하세요'
    o.value = ''
    sel.append(o)
    return
  }
  for (const p of paths) {
    const o = document.createElement('option')
    o.value = p
    o.textContent = p.replace(/^\/Users\/[^/]+/, '~')
    sel.append(o)
  }
  $('#diagPath').value = paths[0]
  sel.addEventListener('change', () => { $('#diagPath').value = sel.value })
}

$('#btnDiag').addEventListener('click', async () => {
  const r = await invoke('inspect_settings', { path: $('#diagPath').value.trim() })
  const out = $('#diagOut')
  out.textContent = ''
  if (!r.ok) {
    const p = el('div', 'bad'); p.textContent = '읽기 실패: ' + r.error
    out.append(p); return
  }
  const line = (k, v, cls) => {
    const d = el('div')
    const kk = el('span', 'none'); kk.textContent = k + ': '
    const vv = el('span', cls || ''); vv.textContent = v || '(없음)'
    d.append(kk, vv); out.append(d)
  }
  line('telemetry', r.telemetry, r.telemetry === '1' ? 'ok' : 'none')
  line('exporter', r.metrics_exporter, 'ok')
  line('endpoint', r.endpoint, r.endpoint.includes('localhost') ? 'ok' : 'none')
  line('attrs', r.resource_attrs, 'ok')
  line('interval', r.interval + 'ms', 'none')
  const d = el('div'); d.style.marginTop = '7px'
  if (r.content_keys.length) {
    d.className = 'bad'
    d.textContent = '⚠ 내용 노출 키 발견: ' + r.content_keys.join(', ')
  } else {
    d.className = 'ok'
    d.textContent = '✓ 내용 노출 키 없음 (프롬프트·응답·도구 파라미터 미전송)'
  }
  out.append(d)
})


/* ---------- 테마 ---------- */
function applyTheme (mode) {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
  document.querySelectorAll('#themeSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.theme === mode)
  })
  // 차트는 토큰이 아니라 리터럴 색을 쓰므로 다시 그린다
  if (!$('#paneChart').hidden) renderCharts()
}

function initTheme () {
  let saved = 'system'
  try { saved = localStorage.getItem('otel-theme') || 'system' } catch (e) { /* 비공개 창 등 */ }
  applyTheme(saved)
  document.querySelectorAll('#themeSeg button').forEach(b => {
    b.addEventListener('click', () => {
      const m = b.dataset.theme
      try { localStorage.setItem('otel-theme', m) } catch (e) { /* 저장 못해도 적용은 된다 */ }
      applyTheme(m)
    })
  })
  // 시스템 모드일 때 OS 테마가 바뀌면 차트 색을 따라가게
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!document.documentElement.hasAttribute('data-theme') && !$('#paneChart').hidden) renderCharts()
    })
  } catch (e) { /* 미지원 브라우저 */ }
}


/* ---------- 인스펙터 너비 조정 ---------- */
function initSplitter () {
  const sp = $('#splitter')
  if (!sp) return
  const MIN = 260, MAX_RATIO = 0.7

  try {
    const saved = parseInt(localStorage.getItem('otel-side-w'), 10)
    if (saved >= MIN) document.documentElement.style.setProperty('--side-w', saved + 'px')
  } catch (e) { /* 저장소를 못 읽어도 기본값으로 동작 */ }

  let dragging = false

  const move = (clientX) => {
    const w = Math.round(window.innerWidth - clientX)
    const max = Math.round(window.innerWidth * MAX_RATIO)
    const next = Math.max(MIN, Math.min(max, w))
    document.documentElement.style.setProperty('--side-w', next + 'px')
  }

  sp.addEventListener('pointerdown', (e) => {
    dragging = true
    sp.setPointerCapture(e.pointerId)
    sp.classList.add('dragging')
    document.body.classList.add('resizing')
    e.preventDefault()
  })
  sp.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX) })
  const end = (e) => {
    if (!dragging) return
    dragging = false
    sp.classList.remove('dragging')
    document.body.classList.remove('resizing')
    try { sp.releasePointerCapture(e.pointerId) } catch (_) {}
    const cur = getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim()
    try { localStorage.setItem('otel-side-w', parseInt(cur, 10)) } catch (_) {}
    if (!$('#paneChart').hidden) renderCharts()
  }
  sp.addEventListener('pointerup', end)
  sp.addEventListener('pointercancel', end)
  // 더블클릭으로 기본 너비 복귀
  sp.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--side-w', '380px')
    try { localStorage.setItem('otel-side-w', 380) } catch (_) {}
    if (!$('#paneChart').hidden) renderCharts()
  })
}

$('#fAdd').addEventListener('click', () => {
  const key = $('#fKey').value
  const val = $('#fVal').value
  if (!key || !val) return
  if (!filters.some(f => f.key === key && f.val === val)) filters.push({ key, val })
  renderAll()
})
$('#fClear').addEventListener('click', () => { filters = []; renderAll() })

$('#btnRet').addEventListener('click', async () => {
  const d = parseInt($('#cfgRet').value, 10) || 90
  await invoke('set_retention', { days: d })
  $('#btnRet').textContent = '적용됨 ✓'
  setTimeout(() => { $('#btnRet').textContent = '적용' }, 1500)
})
$('#btnClearHist').addEventListener('click', async () => {
  await invoke('clear_history')
  hist = await invoke('history').catch(() => null)
  if (range !== 'session') renderCharts()
  $('#btnClearHist').textContent = '삭제됨'
  setTimeout(() => { $('#btnClearHist').textContent = '기록 삭제' }, 1500)
})

$('#btnUpd').addEventListener('click', async () => {
  const st = $('#updStatus')
  const btn = $('#btnUpd')
  btn.disabled = true
  st.textContent = '확인 중…'
  try {
    const up = await check()
    if (!up) { st.textContent = '최신 버전을 쓰고 있습니다.'; btn.disabled = false; return }
    st.textContent = `새 버전 ${up.version} 이 있습니다. 내려받는 중…`
    await up.downloadAndInstall()
    st.textContent = '설치 완료 — 앱을 다시 시작합니다.'
    await relaunch()
  } catch (e) {
    st.textContent = '확인 실패: ' + (e && e.message ? e.message : String(e))
    btn.disabled = false
  }
})

try {
  const mq = window.matchMedia('(max-width: 860px)')
  const onWidthChange = () => {
    // 넓어지면 인스펙터 탭에서 빠져나온다
    if (!mq.matches && !$('#paneInspect').hidden) {
      document.querySelector('.tab[data-pane="stream"]').click()
    }
    renderInspector()
  }
  if (mq.addEventListener) mq.addEventListener('change', onWidthChange)
  else mq.addListener(onWidthChange)
} catch (e) { /* 미지원 환경 */ }

try {
  new ResizeObserver(layoutStats).observe($('#stats'))
} catch (e) {
  window.addEventListener('resize', layoutStats)
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!$('#paneInspect').hidden) closeInspector()
})


/* ---------- 사이드 패널 ---------- */
// 탭마다 오른쪽에 둘 내용이 다르다. 인스펙터는 "요청 하나"를 보는 패널이라
// 집계를 보는 차트 탭이나 설정 탭에는 맞지 않는다.
let sideCollapsed = false
let currentPane = 'stream'

function syncSidePanel (pane) {
  currentPane = pane || currentPane
  const isChart = currentPane === 'chart'
  const isSetup = currentPane === 'setup'

  // 설정 탭은 오른쪽에 보여줄 것이 없다
  const hideSide = isSetup || sideCollapsed
  $('main').classList.toggle('side-collapsed', hideSide)
  $('#sideReopen').hidden = !(sideCollapsed && !isSetup)

  $('#sideTitle').textContent = isChart ? '요약' : '인스펙터'
  $('#inspector').hidden = isChart
  $('#sideSummary').hidden = !isChart
  if (isChart) renderSummary()
}

function renderSummary () {
  const box = $('#sideSummary')
  box.textContent = ''
  const t = computeTotals()

  const sec = (title) => {
    const d = el('div', 'sec')
    const h = el('h3'); h.textContent = title
    d.append(h); return d
  }
  const row = (k, v) => {
    const r = el('div', 'mrow')
    const n = el('div', 'n'); n.textContent = k
    const val = el('div', 'v'); val.textContent = v
    r.append(n, val); return r
  }

  // 범위 합계
  const pts = chartData()
  const sum = (key) => pts.reduce((a, d) => a + (d[key] || 0), 0)
  const s1 = sec(range === 'session' ? '이번 실행' : `최근 ${range}일`)
  if (range === 'session') {
    s1.append(
      row('토큰', fmtN(t.tokens_in + t.tokens_out)),
      row('비용', fmtCost(t.cost_usd)),
      row('활동 시간', fmtDur(t.active_seconds)),
      row('코드 변경', `+${fmtN(t.lines_added)} −${fmtN(t.lines_removed)}`)
    )
  } else {
    s1.append(
      row('토큰', fmtN(sum('tokens_in') + sum('tokens_out'))),
      row('비용', fmtCost(sum('cost'))),
      row('활동 시간', fmtDur(sum('active'))),
      row('코드 변경', `+${fmtN(sum('added'))} −${fmtN(sum('removed'))}`),
      row('일수', `${pts.length}일`)
    )
  }
  box.append(s1)

  // 토큰 구성
  const s2 = sec('토큰 구성')
  for (const [k, v] of [['input', t.tokens_in], ['output', t.tokens_out],
    ['cacheRead', t.tokens_cache_read], ['cacheCreation', t.tokens_cache_creation]]) {
    s2.append(row(k, fmtN(v)))
  }
  box.append(s2)

  // 계정별
  const s3 = sec('계정별')
  const acc = {}
  if (hist && hist.days) {
    const days = range === 'session' ? 1 : parseInt(range, 10)
    const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
    for (const [date, accts] of Object.entries(hist.days)) {
      if (range !== 'session' && date < cutoff) continue
      for (const [a, st] of Object.entries(accts)) {
        acc[a] = acc[a] || { tokens: 0, cost: 0 }
        acc[a].tokens += (st.tokens_in || 0) + (st.tokens_out || 0)
        acc[a].cost += st.cost_usd || 0
      }
    }
  }
  const entries = Object.entries(acc).sort((a, b) => b[1].tokens - a[1].tokens)
  if (entries.length === 0) {
    const e = el('div'); e.style.cssText = 'color:var(--text-3);font-size:12px'
    e.textContent = '기록이 아직 없습니다.'
    s3.append(e)
  } else {
    for (const [a, v] of entries) s3.append(row(a, `${fmtN(v.tokens)} · ${fmtCost(v.cost)}`))
  }
  box.append(s3)
}

$('#sideCollapse').addEventListener('click', () => {
  sideCollapsed = true
  try { localStorage.setItem('otel-side-collapsed', '1') } catch (e) {}
  syncSidePanel()
})
$('#sideReopen').addEventListener('click', () => {
  sideCollapsed = false
  try { localStorage.setItem('otel-side-collapsed', '0') } catch (e) {}
  syncSidePanel()
})


/* ---------- 스트림 추적 ---------- */
function syncFollow () {
  const f = $('#followState')
  f.classList.toggle('paused', !following)
  $('#followText').textContent = following ? '추적 중' : '멈춤'
  f.title = following
    ? '새 항목을 자동으로 따라갑니다'
    : '특정 항목을 보는 중입니다. "최신으로" 를 누르면 다시 따라갑니다.'
  $('#btnResume').hidden = following
}

function resumeFollow () {
  following = true
  const vis = visible()
  selected = vis.length ? vis[vis.length - 1].id : null
  syncFollow()
  renderStream()
  renderInspector()
}

$('#btnResume').addEventListener('click', resumeFollow)
$('#followState').addEventListener('click', () => { if (!following) resumeFollow() })

/* ---------- 상단바 ---------- */
$('#btnCards').addEventListener('click', (e) => {
  e.stopPropagation()
  const m = $('#cardMenu')
  const opening = m.hidden
  if (opening) renderCardMenu()
  m.hidden = !opening
  $('#btnCards').classList.toggle('on', opening)
})
document.addEventListener('click', (e) => {
  const m = $('#cardMenu')
  if (!m.hidden && !m.contains(e.target)) {
    m.hidden = true
    $('#btnCards').classList.remove('on')
  }
})

// 테마는 시스템 → 라이트 → 다크 순으로 돈다
$('#btnTheme').addEventListener('click', () => {
  const order = ['system', 'light', 'dark']
  let cur = 'system'
  try { cur = localStorage.getItem('otel-theme') || 'system' } catch (e) {}
  const next = order[(order.indexOf(cur) + 1) % order.length]
  try { localStorage.setItem('otel-theme', next) } catch (e) {}
  applyTheme(next)
  $('#btnTheme').title = `테마: ${{ system: '시스템', light: '라이트', dark: '다크' }[next]}`
})

$('#btnSettings').addEventListener('click', () => {
  document.querySelector('.tab[data-pane="setup"]').click()
})

/* ---------- 부트 ---------- */
function renderAll () {
  refreshFilterOptions(); renderChips()
  if (following) {
    const vis = visible()
    selected = vis.length ? vis[vis.length - 1].id : null
  }
  renderStats(); renderLeakBar(); renderStream(); renderInspector()
  if (!$('#paneChart').hidden) renderCharts()
}

listen('otlp-capture', (e) => {
  captures.push(e.payload)
  if (captures.length > 500) captures.shift()
  if (following && matches(e.payload)) selected = e.payload.id
  invoke('snapshot').then(s => {
    totals = s.totals; series = s.series
    renderAll()
  })
})

listen('server-status', (e) => {
  const p = e.payload
  const s = $('#srvStatus')
  if (p.running) { s.className = 'status on'; s.textContent = `수신 중 :${p.port}` }
  else { s.className = 'status err'; s.textContent = `포트 ${p.port} 실패` }
})

initTheme()
initSplitter()

invoke('snapshot').then(s => {
  captures = s.captures; totals = s.totals; series = s.series
  $('#cfgPort').value = s.cfg.listen_port
  $('#cfgUp').value = s.cfg.upstream
  $('#cfgFwd').checked = s.cfg.forward_enabled
  loadCardPrefs()
  syncFollow()
  loadSettingsPaths()
  syncFwdWarn()
  try { sideCollapsed = localStorage.getItem('otel-side-collapsed') === '1' } catch (e) {}
  syncSidePanel('stream')
  invoke('history').then(h => { hist = h; if (h) $('#cfgRet').value = h.retention_days })
    .catch(() => {})
  invoke('history_path').then(p => {
    $('#histPath').textContent = p.replace(/^\/Users\/[^/]+/, '~')
  }).catch(() => {})
  const st = $('#srvStatus')
  if (s.running) { st.className = 'status on'; st.textContent = `수신 중 :${s.cfg.listen_port}` }
  renderAll()
})
