use anyhow::Result;
use chrono::Utc;
use nervous_system::BrainBus;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use shared_types::BrainEvent;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use sysinfo::System;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSnapshot {
    pub cpu: f32,
    pub memory: f32,
    pub active_process: Option<String>,
}

#[derive(Clone)]
pub struct SensorySystem {
    bus: BrainBus,
}

impl SensorySystem {
    pub fn new(bus: BrainBus) -> Self {
        Self { bus }
    }

    pub fn observe_system_once(&self) -> Result<SystemSnapshot> {
        let mut system = System::new_all();
        system.refresh_all();
        let cpu = if system.cpus().is_empty() {
            0.0
        } else {
            system.cpus().iter().map(|cpu| cpu.cpu_usage()).sum::<f32>() / system.cpus().len() as f32
        };
        let memory = if system.total_memory() == 0 {
            0.0
        } else {
            system.used_memory() as f32 / system.total_memory() as f32
        };
        let active_process = system
            .processes()
            .values()
            .max_by(|a, b| a.cpu_usage().partial_cmp(&b.cpu_usage()).unwrap_or(std::cmp::Ordering::Equal))
            .map(|p| p.name().to_string_lossy().into_owned());
        let snapshot = SystemSnapshot {
            cpu,
            memory,
            active_process,
        };
        self.bus.emit(
            BrainEvent::SystemObserved {
                cpu,
                memory,
                active_process: snapshot.active_process.clone(),
                at: Utc::now(),
            },
            Some("ObserverAgent".to_string()),
        )?;
        Ok(snapshot)
    }

    pub fn watch_project_blocking(&self, root: PathBuf) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        let mut watcher = RecommendedWatcher::new(tx, Config::default())?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        for event in rx {
            let event = event?;
            let change = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Modify(_) => "modify",
                EventKind::Remove(_) => "remove",
                _ => "other",
            }
            .to_string();
            for path in event.paths {
                self.bus.emit(
                    BrainEvent::FileChanged {
                        path: path.to_string_lossy().into_owned(),
                        change: change.clone(),
                        project_root: Some(root.to_string_lossy().into_owned()),
                        at: Utc::now(),
                    },
                    Some("ObserverAgent".to_string()),
                )?;
            }
        }
        Ok(())
    }

    pub fn detect_git_changes(&self, root: impl AsRef<Path>) -> Result<usize> {
        let root = root.as_ref();
        let output = Command::new("git")
            .args(["-C", &root.to_string_lossy(), "status", "--porcelain"])
            .output();
        let changed_files = output
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).lines().count())
            .unwrap_or(0);
        let branch = Command::new("git")
            .args(["-C", &root.to_string_lossy(), "branch", "--show-current"])
            .output()
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        self.bus.emit(
            BrainEvent::GitChanged {
                project_root: root.to_string_lossy().into_owned(),
                branch,
                changed_files,
                at: Utc::now(),
            },
            Some("ObserverAgent".to_string()),
        )?;
        Ok(changed_files)
    }
}
