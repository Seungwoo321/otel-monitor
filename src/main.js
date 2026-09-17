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

function renderStats () {
  const t = computeTotals()
  const tokens = (t.tokens_in || 0) + (t.tokens_out || 0)
  const cards = [
    ['받은 요청', fmtN(t.requests), ''],
    ['누적 용량', fmtB(t.bytes || 0), ''],
    ['토큰', fmtN(tokens), 'accent'],
    ['비용', fmtUsd(t.cost_usd), 'accent'],
    ['세션', fmtN(t.sessions), ''],
    ['커밋 / PR', `${fmtN(t.commits)} / ${fmtN(t.prs)}`, ''],
    ['코드 변경', `+${fmtN(t.lines_added)} −${fmtN(t.lines_removed)}`, ''],
    ['활동 시간', fmtDur(t.active_seconds), ''],
    ['전달 실패', fmtN(t.forward_failures), t.forward_failures > 0 ? 'danger' : ''],
    ['내용 유출', fmtN(t.leak_events), t.leak_events > 0 ? 'danger' : '']
  ]
  const box = $('#stats')
  box.textContent = ''
  for (const [k, v, cls] of cards) {
    const d = el('div', 'stat')
    const kk = el('div', 'k'); kk.textContent = k
    const vv = el('div', 'v' + (cls ? ' ' + cls : '')); vv.textContent = v
    d.append(kk, vv); box.append(d)
  }
  layoutStats()
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
  r.addEventListener('click', () => { selected = c.id; renderStream(); renderInspector() })
  return r
}

function renderStream () {
  const box = $('#rows')
  box.textContent = ''
  const vis = visible()
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

function renderInspector () {
  const box = $('#inspector')
  box.textContent = ''
  const c = captures.find(x => x.id === selected)
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
function drawChart (svgId, key, color) {
  const svg = $(svgId)
  svg.textContent = ''
  const W = 600, H = 180, P = { t: 10, r: 52, b: 22, l: 10 }
  const pts = (range === 'session' ? series : histSeries(parseInt(range, 10))).slice(-120)

  const cs = getComputedStyle(document.documentElement)
  const gridC = cs.getPropertyValue('--line').trim() || '#262c35'
  const textC = cs.getPropertyValue('--text-3').trim() || '#6f7885'
  const NS = 'http://www.w3.org/2000/svg'
  const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e }

  if (pts.length < 2) {
    const t = mk('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: textC, 'font-size': '12', 'font-family': 'monospace' })
    t.textContent = '데이터를 모으는 중입니다'
    svg.append(t); return
  }

  const vals = pts.map(p => p[key])
  const max = Math.max(...vals, 1)
  const iw = W - P.l - P.r, ih = H - P.t - P.b
  const X = (i) => P.l + (i / (pts.length - 1)) * iw
  const Y = (v) => P.t + ih - (v / max) * ih

  // 그리드 + 눈금 라벨
  for (let g = 0; g <= 3; g++) {
    const v = (max / 3) * g
    const y = Y(v)
    svg.append(mk('line', { x1: P.l, y1: y, x2: P.l + iw, y2: y, stroke: gridC, 'stroke-width': '1' }))
    const lb = mk('text', { x: P.l + iw + 6, y: y + 3.5, fill: textC, 'font-size': '10', 'font-family': 'monospace' })
    lb.textContent = key === 'cost' ? '$' + v.toFixed(3) : fmtN(v)
    svg.append(lb)
  }

  const area = pts.map((p, i) => `${X(i)},${Y(p[key])}`).join(' ')
  svg.append(mk('polygon', {
    points: `${P.l},${P.t + ih} ${area} ${P.l + iw},${P.t + ih}`,
    fill: color, opacity: '0.13'
  }))
  svg.append(mk('polyline', {
    points: area, fill: 'none', stroke: color, 'stroke-width': '1.8',
    'stroke-linejoin': 'round'
  }))
  // 끝점 강조
  const lx = X(pts.length - 1), ly = Y(vals[vals.length - 1])
  svg.append(mk('circle', { cx: lx, cy: ly, r: '3', fill: color }))

  // 시간 라벨
  const first = mk('text', { x: P.l, y: H - 6, fill: textC, 'font-size': '10', 'font-family': 'monospace' })
  first.textContent = pts[0].ts
  const last = mk('text', { x: P.l + iw, y: H - 6, fill: '#6f7885', 'font-size': '10', 'font-family': 'monospace', 'text-anchor': 'end' })
  last.textContent = pts[pts.length - 1].ts
  svg.append(first, last)
}

function histSeries (days) {
  if (!hist || !hist.days) return []
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const out = []
  for (const date of Object.keys(hist.days).sort()) {
    if (date < cutoff) continue
    let tokens = 0, cost = 0
    for (const [acct, st] of Object.entries(hist.days[date])) {
      if (filters.length && !filters.every(f => f.key !== 'user.email' || f.val === acct)) continue
      tokens += (st.tokens_in || 0) + (st.tokens_out || 0)
      cost += st.cost_usd || 0
    }
    out.push({ ts: date.slice(5), tokens, cost })
  }
  return out
}

function renderCharts () {
  const cs = getComputedStyle(document.documentElement)
  const accent = cs.getPropertyValue('--accent').trim() || '#35b5ac'
  const warn = cs.getPropertyValue('--warn').trim() || '#d19a4a'
  drawChart('#chartTokens', 'tokens', accent)
  drawChart('#chartCost', 'cost', warn)

  const t = totals
  const box = $('#tokenBreak')
  box.textContent = ''
  const rows = [
    ['input', t.tokens_in], ['output', t.tokens_out],
    ['cacheRead', t.tokens_cache_read], ['cacheCreation', t.tokens_cache_creation]
  ]
  for (const [k, v] of rows) {
    const r = el('div', 'mrow')
    const n = el('div', 'n'); n.textContent = k
    const val = el('div', 'v'); val.textContent = fmtN(v)
    r.append(n, val); box.append(r)
  }
}

document.querySelectorAll('#rangeSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#rangeSeg button').forEach(x => x.classList.remove('on'))
    b.classList.add('on')
    range = b.dataset.range
    if (range !== 'session') { try { hist = await invoke('history') } catch (e) { hist = null } }
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
    if (p === 'chart') renderCharts()
  })
})

/* ---------- 액션 ---------- */
$('#btnClear').addEventListener('click', async () => {
  await invoke('clear')
  captures = []; totals = {}; series = []; selected = null
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
  new ResizeObserver(layoutStats).observe($('#stats'))
} catch (e) {
  window.addEventListener('resize', layoutStats)
}

/* ---------- 부트 ---------- */
function renderAll () {
  refreshFilterOptions(); renderChips()
  renderStats(); renderLeakBar(); renderStream(); renderInspector()
  if (!$('#paneChart').hidden) renderCharts()
}

listen('otlp-capture', (e) => {
  captures.push(e.payload)
  if (captures.length > 500) captures.shift()
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
  loadSettingsPaths()
  syncFwdWarn()
  invoke('history').then(h => { hist = h; if (h) $('#cfgRet').value = h.retention_days })
    .catch(() => {})
  invoke('history_path').then(p => {
    $('#histPath').textContent = p.replace(/^\/Users\/[^/]+/, '~')
  }).catch(() => {})
  const st = $('#srvStatus')
  if (s.running) { st.className = 'status on'; st.textContent = `수신 중 :${s.cfg.listen_port}` }
  renderAll()
})
