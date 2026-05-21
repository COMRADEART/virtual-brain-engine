use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub id: String,
    pub path: String,
    pub change_type: String,
    pub timestamp: u64,
    pub size: Option<u64>,
    pub extension: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStats {
    pub total_files: usize,
    pub total_lines: u64,
    pub languages: HashMap<String, usize>,
    pub last_modified: u64,
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitActivity {
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub uncommitted_changes: usize,
    pub last_commit_timestamp: Option<u64>,
    pub last_commit_message: Option<String>,
}

pub struct FileWatcher {
    watcher: Option<RecommendedWatcher>,
    watched_paths: Vec<PathBuf>,
    // TODO(phase2): drained by poll_events/add_change in a later phase.
    #[allow(dead_code)]
    recent_changes: Vec<FileChange>,
    project_stats: ProjectStats,
}

impl FileWatcher {
    pub fn new() -> Self {
        Self {
            watcher: None,
            watched_paths: Vec::new(),
            recent_changes: Vec::new(),
            project_stats: ProjectStats {
                total_files: 0,
                total_lines: 0,
                languages: HashMap::new(),
                last_modified: 0,
                root_path: String::new(),
            },
        }
    }

    pub fn watch(&mut self, path: &Path) -> Result<(), String> {
        let event_tx = std::sync::mpsc::channel::<Result<Event, notify::Error>>();

        let watcher = RecommendedWatcher::new(
            move |res| {
                let _ = event_tx.0.send(res);
            },
            Config::default(),
        ).map_err(|e| format!("Failed to create watcher: {}", e))?;

        self.watcher = Some(watcher);
        self.watched_paths.push(path.to_path_buf());

        if let Some(ref mut w) = self.watcher {
            w.watch(path, RecursiveMode::Recursive)
                .map_err(|e| format!("Failed to watch path: {}", e))?;
        }

        Ok(())
    }

    // TODO(phase2): used by a later phase — kept as scaffolding (see CLAUDE.md).
    #[allow(dead_code)]
    pub fn poll_events(&mut self) -> Vec<FileChange> {
        std::mem::take(&mut self.recent_changes)
    }

    // TODO(phase2): used by a later phase — kept as scaffolding (see CLAUDE.md).
    #[allow(dead_code)]
    pub fn add_change(&mut self, change: FileChange) {
        // Keep only last 100 changes
        if self.recent_changes.len() >= 100 {
            self.recent_changes.remove(0);
        }
        self.recent_changes.push(change);
    }

    pub fn scan_project(&mut self, root_path: &Path) -> ProjectStats {
        let mut stats = ProjectStats {
            total_files: 0,
            total_lines: 0,
            languages: HashMap::new(),
            last_modified: 0,
            root_path: root_path.to_string_lossy().into_owned(),
        };

        let language_extensions: HashMap<&str, &str> = [
            ("rust", "rs"),
            ("typescript", "ts"),
            ("typescript", "tsx"),
            ("javascript", "js"),
            ("javascript", "jsx"),
            ("python", "py"),
            ("go", "go"),
            ("java", "java"),
            ("c", "c"),
            ("c", "h"),
            ("cpp", "cpp"),
            ("cpp", "hpp"),
            ("csharp", "cs"),
            ("ruby", "rb"),
            ("php", "php"),
            ("swift", "swift"),
            ("kotlin", "kt"),
            ("html", "html"),
            ("css", "css"),
            ("scss", "scss"),
            ("json", "json"),
            ("yaml", "yaml"),
            ("yaml", "yml"),
            ("markdown", "md"),
            ("sql", "sql"),
        ].iter().fold(HashMap::new(), |mut acc, (lang, ext)| {
            acc.insert(*ext, *lang);
            acc
        });

        fn count_lines(path: &Path) -> u64 {
            std::fs::read_to_string(path)
                .map(|content| content.lines().count() as u64)
                .unwrap_or(0)
        }

        fn walk_dir(dir: &Path, stats: &mut ProjectStats, extensions: &HashMap<&str, &str>) {
            let skip_dirs = ["node_modules", ".git", "target", "dist", "build", ".next", "__pycache__", "venv", ".venv", "vendor"];

            let Ok(entries) = std::fs::read_dir(dir) else { return; };

            for entry in entries.flatten() {
                let path = entry.path();

                if path.is_dir() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if !skip_dirs.contains(&name) {
                            walk_dir(&path, stats, extensions);
                        }
                    }
                } else if path.is_file() {
                    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                        if let Some(lang) = extensions.get(ext) {
                            stats.total_files += 1;
                            stats.languages.insert(lang.to_string(), *stats.languages.get(*lang).unwrap_or(&0) + 1);
                            stats.total_lines += count_lines(&path);

                            if let Ok(metadata) = entry.metadata() {
                                if let Ok(modified) = metadata.modified() {
                                    let timestamp = modified.duration_since(UNIX_EPOCH)
                                        .map(|d| d.as_secs())
                                        .unwrap_or(0);
                                    if timestamp > stats.last_modified {
                                        stats.last_modified = timestamp;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        walk_dir(root_path, &mut stats, &language_extensions);
        self.project_stats = stats.clone();
        stats
    }

    pub fn get_git_activity(&self, repo_path: &Path) -> Option<GitActivity> {
        let repo = git2::Repository::open(repo_path).ok()?;

        let branch = repo.head().ok().and_then(|h| {
            h.shorthand().map(|s| s.to_string())
        });

        let (ahead, behind) = branch
            .as_deref()
            .and_then(|name| {
                let local = repo.find_branch(name, git2::BranchType::Local).ok()?;
                let upstream = local.upstream().ok()?;
                let local_commit = local.get().peel_to_commit().ok()?;
                let upstream_commit = upstream.get().peel_to_commit().ok()?;
                repo.graph_ahead_behind(local_commit.id(), upstream_commit.id()).ok()
            })
            .unwrap_or((0, 0));

        let statuses = repo.statuses(None).ok();
        let uncommitted_changes = statuses
            .map(|s| s.iter().filter(|entry| entry.status() != git2::Status::CURRENT).count())
            .unwrap_or(0);

        let (last_commit_timestamp, last_commit_message) = repo.head().ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| {
                let time = c.time();
                let timestamp = time.seconds() as u64;
                let message = c.message().map(|m| m.trim().to_string());
                (Some(timestamp), message)
            })
            .unwrap_or((None, None));

        Some(GitActivity {
            branch,
            ahead,
            behind,
            uncommitted_changes,
            last_commit_timestamp,
            last_commit_message,
        })
    }
}

impl Default for FileWatcher {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedFileWatcher = Arc<RwLock<FileWatcher>>;

pub fn create_file_watcher() -> SharedFileWatcher {
    Arc::new(RwLock::new(FileWatcher::new()))
}
