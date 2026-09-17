//! 일자별 누적 집계 저장.
//!
//! 캡처 원본은 남기지 않는다 — 감시 도구가 원문을 쌓아두면 그 자체가 유출 지점이 된다.
//! 날짜 × 계정별 합계와 유출 경고만 디스크에 두고, 원본이 필요하면 JSON/CSV 로 내보낸다.
//!
//! Claude Code 는 cumulative temporality 로 보내므로 같은 (날짜, 계정, 시리즈) 는
//! 누계가 갱신된 값이다. 더하지 않고 최신값으로 덮어쓴다.

use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// 하루 · 한 계정의 집계.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DayStat {
    pub tokens_in: f64,
    pub tokens_out: f64,
    pub tokens_cache_read: f64,
    pub tokens_cache_creation: f64,
    pub cost_usd: f64,
    pub sessions: f64,
    pub commits: f64,
    pub prs: f64,
    pub lines_added: f64,
    pub lines_removed: f64,
    pub active_seconds: f64,
    /// 그날 받은 요청 수 (집계가 아니라 카운트라 누적한다)
    pub requests: u64,
}

/// 유출 경고 한 건.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeakRecord {
    pub ts: String,
    pub account: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct History {
    /// 날짜(YYYY-MM-DD) → 계정 → 집계
    pub days: BTreeMap<String, BTreeMap<String, DayStat>>,
    pub leaks: Vec<LeakRecord>,
    /// 보관 일수 (기본 90)
    #[serde(default = "default_retention")]
    pub retention_days: u32,
}

fn default_retention() -> u32 {
    90
}

impl Default for History {
    fn default() -> Self {
        Self {
            days: BTreeMap::new(),
            leaks: Vec::new(),
            retention_days: default_retention(),
        }
    }
}

/// 시리즈별 누계의 마지막 값. (날짜, 계정, 메트릭, 구분) → 값
type SeriesKey = (String, String, String, String);

pub struct HistoryStore {
    path: PathBuf,
    data: RwLock<History>,
    latest: RwLock<BTreeMap<SeriesKey, f64>>,
    dirty: RwLock<bool>,
}

impl HistoryStore {
    pub fn new() -> Self {
        let path = Self::file_path();
        let mut data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<History>(&s).ok())
            .unwrap_or_default();
        // 예전 파일이나 잘못된 값으로 0 이 들어와 있으면 기본값으로 되돌린다.
        // 0 이면 prune 이 전부 지워 버린다.
        if data.retention_days == 0 {
            data.retention_days = default_retention();
        }

        Self {
            path,
            data: RwLock::new(data),
            latest: RwLock::new(BTreeMap::new()),
            dirty: RwLock::new(false),
        }
    }

    fn file_path() -> PathBuf {
        let base = std::env::var("HOME")
            .map(|h| {
                PathBuf::from(h)
                    .join("Library/Application Support/dev.seungwoo.otel-monitor")
            })
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = std::fs::create_dir_all(&base);
        base.join("history.json")
    }

    pub fn snapshot(&self) -> History {
        self.data.read().clone()
    }

    pub fn set_retention(&self, days: u32) {
        self.data.write().retention_days = days.clamp(1, 3650);
        self.prune();
        *self.dirty.write() = true;
    }

    pub fn clear(&self) {
        let keep = self.data.read().retention_days;
        *self.data.write() = History {
            retention_days: keep,
            ..Default::default()
        };
        self.latest.write().clear();
        *self.dirty.write() = true;
        self.flush();
    }

    /// 캡처 하나를 그날 집계에 반영한다.
    pub fn record(
        &self,
        date: &str,
        account: &str,
        metrics: &[(String, String, f64)], // (name, discriminator, value)
        leaks: &[String],
        ts: &str,
    ) {
        {
            let mut latest = self.latest.write();
            for (name, disc, val) in metrics {
                latest.insert(
                    (
                        date.to_string(),
                        account.to_string(),
                        name.clone(),
                        disc.clone(),
                    ),
                    *val,
                );
            }
        }

        let mut d = self.data.write();
        let day = d.days.entry(date.to_string()).or_default();
        let stat = day.entry(account.to_string()).or_default();

        // 요청 수는 이벤트 카운트라 누적
        stat.requests += 1;

        // 나머지는 시리즈 최신값으로 다시 합산 (cumulative)
        let latest = self.latest.read();
        let mut fresh = DayStat {
            requests: stat.requests,
            ..Default::default()
        };
        for ((dt, acc, name, disc), val) in latest.iter() {
            if dt != date || acc != account {
                continue;
            }
            let kind = disc
                .split(',')
                .find_map(|p| p.strip_prefix("type="))
                .unwrap_or("");
            match name.as_str() {
                "claude_code.token.usage" => match kind {
                    "input" => fresh.tokens_in += val,
                    "output" => fresh.tokens_out += val,
                    "cacheRead" => fresh.tokens_cache_read += val,
                    "cacheCreation" => fresh.tokens_cache_creation += val,
                    _ => {}
                },
                "claude_code.cost.usage" => fresh.cost_usd += val,
                "claude_code.session.count" => fresh.sessions += val,
                "claude_code.commit.count" => fresh.commits += val,
                "claude_code.pull_request.count" => fresh.prs += val,
                "claude_code.lines_of_code.count" => match kind {
                    "removed" => fresh.lines_removed += val,
                    _ => fresh.lines_added += val,
                },
                "claude_code.active_time.total" => fresh.active_seconds += val,
                _ => {}
            }
        }
        *stat = fresh;
        drop(latest);

        for l in leaks {
            d.leaks.push(LeakRecord {
                ts: ts.to_string(),
                account: account.to_string(),
                reason: l.clone(),
            });
        }
        // 유출 기록은 최근 500건까지만
        let n = d.leaks.len();
        if n > 500 {
            d.leaks.drain(0..n - 500);
        }

        drop(d);
        self.prune();
        *self.dirty.write() = true;
    }

    /// 보관 기간이 지난 날짜를 버린다.
    fn prune(&self) {
        let mut d = self.data.write();
        let keep = d.retention_days as i64;
        let cutoff = chrono::Local::now().date_naive() - chrono::Duration::days(keep);
        let cutoff = cutoff.format("%Y-%m-%d").to_string();
        d.days.retain(|k, _| k.as_str() >= cutoff.as_str());
    }

    /// 변경분이 있으면 디스크에 쓴다. 실패해도 앱 동작은 막지 않는다.
    pub fn flush(&self) {
        if !*self.dirty.read() {
            return;
        }
        let snapshot = self.data.read().clone();
        if let Ok(json) = serde_json::to_string(&snapshot) {
            // 원자적 교체 — 쓰다 죽어도 기존 파일이 깨지지 않는다
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, &self.path).is_ok() {
                *self.dirty.write() = false;
            }
        }
    }

    pub fn path_string(&self) -> String {
        self.path.to_string_lossy().to_string()
    }
}
