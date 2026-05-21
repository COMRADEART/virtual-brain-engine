use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use shared_types::{AgentDescriptor, BrainEvent, BrainId, GoalRecord, OperatingMode, ProjectRecord};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CognitiveMode {
    Idle,
    Observing,
    Learning,
    Focused,
    Planning,
    Executing,
    Analyzing,
    WaitingApproval,
    Recovering,
}

impl Default for CognitiveMode {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SystemLoad {
    pub cpu: f32,
    pub memory: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldState {
    pub cognitive_mode: CognitiveMode,
    pub operating_mode: OperatingMode,
    pub active_project: Option<BrainId>,
    pub active_window: Option<String>,
    pub running_apps: Vec<String>,
    pub active_agents: Vec<String>,
    pub pending_tasks: usize,
    pub current_focus: String,
    pub system_load: SystemLoad,
    pub available_tools: Vec<String>,
    pub current_context: Option<String>,
    pub recent_memories: Vec<BrainId>,
    pub updated_at: DateTime<Utc>,
}

impl Default for WorldState {
    fn default() -> Self {
        Self {
            cognitive_mode: CognitiveMode::Idle,
            operating_mode: OperatingMode::Passive,
            active_project: None,
            active_window: None,
            running_apps: Vec::new(),
            active_agents: Vec::new(),
            pending_tasks: 0,
            current_focus: "ambient-awareness".to_string(),
            system_load: SystemLoad::default(),
            available_tools: Vec::new(),
            current_context: None,
            recent_memories: Vec::new(),
            updated_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileSystemMap {
    pub important_folders: Vec<String>,
    pub project_roots: Vec<String>,
    pub document_roots: Vec<String>,
    pub source_roots: Vec<String>,
    pub asset_roots: Vec<String>,
    pub log_roots: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolMap {
    pub languages: Vec<String>,
    pub terminals: Vec<String>,
    pub developer_tools: Vec<String>,
    pub clis: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiToolMap {
    pub local_models: Vec<String>,
    pub cloud_models: Vec<String>,
    pub api_access: Vec<String>,
    pub embedding_tools: Vec<String>,
    pub vector_databases: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillMap {
    pub known_skills: Vec<String>,
    pub commands: Vec<String>,
    pub programming_tools: Vec<String>,
    pub automation_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMapEntry {
    pub id: BrainId,
    pub name: String,
    pub root_path: String,
    pub languages: Vec<String>,
    pub build_systems: Vec<String>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemBodyMap {
    pub file_system: FileSystemMap,
    pub tool_map: ToolMap,
    pub ai_tool_map: AiToolMap,
    pub skill_map: SkillMap,
    pub project_map: Vec<ProjectMapEntry>,
    pub identity_profile: String,
    pub scanned_at: DateTime<Utc>,
}

impl Default for SystemBodyMap {
    fn default() -> Self {
        Self {
            file_system: FileSystemMap::default(),
            tool_map: ToolMap::default(),
            ai_tool_map: AiToolMap::default(),
            skill_map: SkillMap::default(),
            project_map: Vec::new(),
            identity_profile: "Computer Brain has not completed system onboarding yet.".to_string(),
            scanned_at: Utc::now(),
        }
    }
}

#[derive(Clone, Default)]
pub struct CognitiveStateEngine {
    world: Arc<RwLock<WorldState>>,
    body_map: Arc<RwLock<SystemBodyMap>>,
    goals: Arc<RwLock<Vec<GoalRecord>>>,
}

impl CognitiveStateEngine {
    pub fn snapshot(&self) -> WorldState {
        self.world.read().clone()
    }

    pub fn body_map(&self) -> SystemBodyMap {
        self.body_map.read().clone()
    }

    pub fn operating_mode(&self) -> OperatingMode {
        self.world.read().operating_mode.clone()
    }

    pub fn set_operating_mode(&self, mode: OperatingMode) -> WorldState {
        let mut world = self.world.write();
        world.operating_mode = mode;
        world.updated_at = Utc::now();
        world.clone()
    }

    pub fn goals(&self) -> Vec<GoalRecord> {
        self.goals.read().clone()
    }

    pub fn replace_goals(&self, goals: Vec<GoalRecord>) {
        *self.goals.write() = goals;
    }

    pub fn push_goal(&self, goal: GoalRecord) {
        let mut goals = self.goals.write();
        if goals.iter().any(|existing| existing.id == goal.id) {
            return;
        }
        goals.insert(0, goal);
        goals.truncate(64);
    }

    pub fn install_body_map(&self, body_map: SystemBodyMap) {
        let available_tools = body_map
            .tool_map
            .clis
            .iter()
            .chain(body_map.tool_map.languages.iter())
            .chain(body_map.ai_tool_map.local_models.iter())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        *self.body_map.write() = body_map;
        let mut world = self.world.write();
        world.available_tools = available_tools;
        world.updated_at = Utc::now();
    }

    pub fn transition(&self, mode: CognitiveMode, focus: impl Into<String>) -> WorldState {
        let mut world = self.world.write();
        world.cognitive_mode = mode;
        world.current_focus = focus.into();
        world.updated_at = Utc::now();
        world.clone()
    }

    pub fn observe_event(&self, event: &BrainEvent) -> WorldState {
        let mut world = self.world.write();
        match event {
            BrainEvent::SystemObserved { cpu, memory, active_process, .. } => {
                world.cognitive_mode = CognitiveMode::Observing;
                world.system_load = SystemLoad { cpu: *cpu, memory: *memory };
                if let Some(process) = active_process {
                    push_unique(&mut world.running_apps, process.clone(), 24);
                }
            }
            BrainEvent::GitChanged { project_root, .. } => {
                world.cognitive_mode = CognitiveMode::Focused;
                world.current_context = Some(project_root.clone());
                world.current_focus = "project-work".to_string();
            }
            BrainEvent::UserMessage { content, .. } => {
                world.cognitive_mode = CognitiveMode::Planning;
                world.current_focus = content.chars().take(160).collect();
            }
            BrainEvent::CommandRequested { command, .. } => {
                world.cognitive_mode = CognitiveMode::WaitingApproval;
                world.current_focus = format!("command requested: {command}");
            }
            BrainEvent::ToolCompleted { .. } => {
                world.cognitive_mode = CognitiveMode::Analyzing;
            }
            BrainEvent::WorkflowQueued { .. } => {
                world.pending_tasks = world.pending_tasks.saturating_add(1);
                world.cognitive_mode = CognitiveMode::Executing;
            }
            BrainEvent::MemoryStored { memory_id, .. } => {
                push_unique(&mut world.recent_memories, memory_id.clone(), 32);
                world.cognitive_mode = CognitiveMode::Learning;
            }
            BrainEvent::Error { .. } => {
                world.cognitive_mode = CognitiveMode::Recovering;
            }
            _ => {}
        }
        world.updated_at = Utc::now();
        world.clone()
    }

    pub fn set_agents(&self, agents: &[AgentDescriptor]) {
        let mut world = self.world.write();
        world.active_agents = agents.iter().map(|agent| agent.name.clone()).collect();
        world.updated_at = Utc::now();
    }
}

pub struct SystemBodyScanner;

impl SystemBodyScanner {
    pub fn scan(projects: &[ProjectRecord], agents: &[AgentDescriptor]) -> SystemBodyMap {
        let mut file_system = FileSystemMap::default();
        for folder in known_folders() {
            push_unique(&mut file_system.important_folders, folder, 24);
        }
        file_system.project_roots = projects.iter().map(|p| p.root_path.clone()).collect();
        file_system.source_roots = projects.iter().map(|p| p.root_path.clone()).collect();

        let mut tool_map = ToolMap::default();
        detect_tool("rustc", "Rust", &mut tool_map.languages);
        detect_tool("cargo", "Cargo", &mut tool_map.clis);
        detect_tool("python", "Python", &mut tool_map.languages);
        detect_tool("node", "Node.js", &mut tool_map.languages);
        detect_tool("npm", "npm", &mut tool_map.clis);
        detect_tool("git", "Git", &mut tool_map.clis);
        detect_tool("docker", "Docker", &mut tool_map.developer_tools);
        detect_tool("code", "VS Code", &mut tool_map.developer_tools);
        detect_tool("pwsh", "PowerShell", &mut tool_map.terminals);
        detect_tool("powershell", "Windows PowerShell", &mut tool_map.terminals);
        detect_tool("cmd", "Windows CMD", &mut tool_map.terminals);
        detect_tool("bash", "Bash", &mut tool_map.terminals);
        detect_tool("zsh", "Zsh", &mut tool_map.terminals);

        let mut ai_tool_map = AiToolMap::default();
        detect_tool("ollama", "Ollama", &mut ai_tool_map.local_models);
        ai_tool_map.cloud_models = vec!["OpenAI".to_string(), "Claude".to_string(), "Gemini".to_string()];
        ai_tool_map.embedding_tools = vec!["local-hash-embedding".to_string(), "Ollama embeddings".to_string()];
        ai_tool_map.vector_databases = vec!["local SQLite vectors".to_string(), "Qdrant/ChromaDB optional".to_string()];

        let skill_map = SkillMap {
            known_skills: agents.iter().map(|agent| agent.name.clone()).collect(),
            commands: vec![
                "cargo check".to_string(),
                "cargo test".to_string(),
                "npm run build".to_string(),
                "git status".to_string(),
            ],
            programming_tools: tool_map.languages.clone(),
            automation_tools: tool_map.clis.clone(),
        };

        let project_map = projects
            .iter()
            .map(|project| ProjectMapEntry {
                id: project.id.clone(),
                name: project.name.clone(),
                root_path: project.root_path.clone(),
                languages: infer_languages(&project.root_path, &project.language_stats),
                build_systems: infer_build_systems(&project.root_path),
                last_seen_at: project.last_seen_at,
            })
            .collect::<Vec<_>>();

        let identity_profile = format!(
            "This system exposes {} developer tools, {} AI tools, {} known agents, and {} detected projects.",
            tool_map.languages.len() + tool_map.clis.len() + tool_map.developer_tools.len(),
            ai_tool_map.local_models.len() + ai_tool_map.cloud_models.len(),
            agents.len(),
            project_map.len()
        );

        SystemBodyMap {
            file_system,
            tool_map,
            ai_tool_map,
            skill_map,
            project_map,
            identity_profile,
            scanned_at: Utc::now(),
        }
    }
}

fn known_folders() -> Vec<String> {
    [
        dirs::home_dir(),
        dirs::desktop_dir(),
        dirs::document_dir(),
        dirs::download_dir(),
        dirs::data_dir(),
    ]
    .into_iter()
    .flatten()
    .map(|path| path.to_string_lossy().into_owned())
    .collect()
}

fn detect_tool(binary: &str, label: &str, out: &mut Vec<String>) {
    if which_in_path(binary).is_some() {
        push_unique(out, label.to_string(), 64);
    }
}

fn which_in_path(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat", ""]
    } else {
        vec![""]
    };
    for root in std::env::split_paths(&path) {
        for ext in &extensions {
            let candidate = root.join(format!("{binary}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn infer_languages(root: &str, stats: &serde_json::Value) -> Vec<String> {
    if let Some(obj) = stats.as_object() {
        let keys = obj.keys().cloned().collect::<Vec<_>>();
        if !keys.is_empty() {
            return keys;
        }
    }
    let root = Path::new(root);
    let mut languages = Vec::new();
    if root.join("Cargo.toml").exists() {
        languages.push("Rust".to_string());
    }
    if root.join("package.json").exists() {
        languages.push("Node.js".to_string());
    }
    if root.join("pyproject.toml").exists() || root.join("requirements.txt").exists() {
        languages.push("Python".to_string());
    }
    languages
}

fn infer_build_systems(root: &str) -> Vec<String> {
    let root = Path::new(root);
    let mut systems = Vec::new();
    if root.join("Cargo.toml").exists() {
        systems.push("Cargo".to_string());
    }
    if root.join("package.json").exists() {
        systems.push("npm".to_string());
    }
    if root.join("Makefile").exists() {
        systems.push("Make".to_string());
    }
    systems
}

fn push_unique(values: &mut Vec<String>, value: String, limit: usize) {
    if values.iter().any(|existing| existing == &value) {
        return;
    }
    values.insert(0, value);
    values.truncate(limit);
}
