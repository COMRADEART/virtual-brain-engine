use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutonomousTaskKind {
    NightlyProjectSummary,
    WeeklyArchitectureDigest,
    MemoryCleanup,
    SemanticIndexRefresh,
    Reminder,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduleSpec {
    IntervalMinutes(i64),
    Daily { hour: u32, minute: u32 },
    Weekly { weekday_from_monday: u32, hour: u32, minute: u32 },
    Once,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutonomousTask {
    pub id: String,
    pub kind: AutonomousTaskKind,
    pub title: String,
    pub schedule: ScheduleSpec,
    pub next_run_at: DateTime<Utc>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub priority: u8,
    pub enabled: bool,
    pub payload: serde_json::Value,
}

impl AutonomousTask {
    pub fn new(
        kind: AutonomousTaskKind,
        title: impl Into<String>,
        schedule: ScheduleSpec,
        first_run_at: DateTime<Utc>,
        priority: u8,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            kind,
            title: title.into(),
            schedule,
            next_run_at: first_run_at,
            last_run_at: None,
            priority: priority.min(100),
            enabled: true,
            payload,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct AutonomousRuntime {
    tasks: BTreeMap<String, AutonomousTask>,
}

impl AutonomousRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert(&mut self, task: AutonomousTask) {
        self.tasks.insert(task.id.clone(), task);
    }

    pub fn tasks(&self) -> impl Iterator<Item = &AutonomousTask> {
        self.tasks.values()
    }

    pub fn due_tasks(&self, now: DateTime<Utc>) -> Vec<AutonomousTask> {
        let mut due = self
            .tasks
            .values()
            .filter(|task| task.enabled && task.next_run_at <= now)
            .cloned()
            .collect::<Vec<_>>();
        due.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.next_run_at.cmp(&b.next_run_at)));
        due
    }

    pub fn mark_finished(&mut self, task_id: &str, finished_at: DateTime<Utc>) -> Option<AutonomousTask> {
        let mut task = self.tasks.get(task_id)?.clone();
        task.last_run_at = Some(finished_at);
        task.next_run_at = next_run_after(&task.schedule, finished_at);
        if matches!(task.schedule, ScheduleSpec::Once) {
            task.enabled = false;
        }
        self.tasks.insert(task.id.clone(), task.clone());
        Some(task)
    }
}

pub fn spawn_scheduler(
    runtime: Arc<RwLock<AutonomousRuntime>>,
    sender: mpsc::Sender<AutonomousTask>,
    tick: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tick).await;
            let due = runtime
                .read()
                .map(|rt| rt.due_tasks(Utc::now()))
                .unwrap_or_default();
            for task in due {
                if sender.send(task).await.is_err() {
                    return;
                }
            }
        }
    })
}

pub fn next_run_after(schedule: &ScheduleSpec, after: DateTime<Utc>) -> DateTime<Utc> {
    match schedule {
        ScheduleSpec::IntervalMinutes(minutes) => after + ChronoDuration::minutes((*minutes).max(1)),
        ScheduleSpec::Daily { hour, minute } => {
            let today = after.date_naive();
            let time = chrono::NaiveTime::from_hms_opt((*hour).min(23), (*minute).min(59), 0)
                .unwrap_or(chrono::NaiveTime::MIN);
            let candidate = DateTime::<Utc>::from_naive_utc_and_offset(today.and_time(time), Utc);
            if candidate > after {
                candidate
            } else {
                candidate + ChronoDuration::days(1)
            }
        }
        ScheduleSpec::Weekly {
            weekday_from_monday,
            hour,
            minute,
        } => {
            let target = (*weekday_from_monday).clamp(0, 6);
            let mut candidate = next_run_after(&ScheduleSpec::Daily { hour: *hour, minute: *minute }, after);
            while candidate.weekday().num_days_from_monday() != target {
                candidate += ChronoDuration::days(1);
            }
            candidate
        }
        ScheduleSpec::Once => after,
    }
}

trait WeekdayExt {
    fn weekday(&self) -> chrono::Weekday;
}

impl WeekdayExt for DateTime<Utc> {
    fn weekday(&self) -> chrono::Weekday {
        chrono::Datelike::weekday(self)
    }
}
