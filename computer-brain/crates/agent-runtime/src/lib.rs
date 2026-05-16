use anyhow::Result;
use nervous_system::BrainBus;
use parking_lot::RwLock;
use shared_types::{AgentCapability, AgentDescriptor, AgentName, AgentState, BrainEvent, BrainEventEnvelope};
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::task::JoinHandle;

pub type AgentFuture<'a> = Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;

#[derive(Clone)]
pub struct AgentContext {
    pub bus: BrainBus,
}

impl AgentContext {
    pub fn status(&self, agent: &str, state: AgentState, detail: impl Into<Option<String>>) -> Result<()> {
        self.bus.emit(
            BrainEvent::AgentStatus {
                agent: agent.to_string(),
                state,
                detail: detail.into(),
                at: shared_types::now(),
            },
            Some(agent.to_string()),
        )?;
        Ok(())
    }
}

pub trait Agent: Send + Sync {
    fn name(&self) -> AgentName;
    fn capabilities(&self) -> Vec<AgentCapability>;
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a>;
    fn handle_event<'a>(&'a self, ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a>;
    fn run_task<'a>(&'a self, ctx: &'a AgentContext, task: shared_types::AgentTask) -> AgentFuture<'a>;
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a>;
}

#[derive(Clone, Default)]
pub struct AgentRegistry {
    agents: Arc<RwLock<BTreeMap<AgentName, Arc<dyn Agent>>>>,
}

impl AgentRegistry {
    pub fn register<A: Agent + 'static>(&self, agent: A) {
        self.agents.write().insert(agent.name(), Arc::new(agent));
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Agent>> {
        self.agents.read().get(name).cloned()
    }

    pub fn all(&self) -> Vec<Arc<dyn Agent>> {
        self.agents.read().values().cloned().collect()
    }

    pub fn descriptors(&self) -> Vec<AgentDescriptor> {
        self.agents
            .read()
            .values()
            .map(|agent| AgentDescriptor {
                name: agent.name(),
                state: AgentState::Idle,
                capabilities: agent.capabilities(),
                last_seen_at: shared_types::now(),
                detail: None,
            })
            .collect()
    }
}

pub struct AgentRuntime {
    registry: AgentRegistry,
    ctx: AgentContext,
    listeners: Vec<JoinHandle<()>>,
}

impl AgentRuntime {
    pub fn new(bus: BrainBus) -> Self {
        Self {
            registry: AgentRegistry::default(),
            ctx: AgentContext { bus },
            listeners: Vec::new(),
        }
    }

    pub fn registry(&self) -> AgentRegistry {
        self.registry.clone()
    }

    pub fn register<A: Agent + 'static>(&self, agent: A) {
        self.registry.register(agent);
    }

    pub async fn start(&mut self) -> Result<()> {
        for agent in self.registry.all() {
            agent.init(&self.ctx).await?;
        }
        let mut rx = self.ctx.bus.subscribe();
        let registry = self.registry.clone();
        let ctx = self.ctx.clone();
        self.listeners.push(tokio::spawn(async move {
            loop {
                let Ok(event) = rx.recv().await else {
                    continue;
                };
                for agent in registry.all() {
                    let ctx = ctx.clone();
                    let event = event.clone();
                    tokio::spawn(async move {
                        let _ = agent.handle_event(&ctx, event).await;
                    });
                }
            }
        }));
        Ok(())
    }

    pub async fn dispatch_task(&self, task: shared_types::AgentTask) -> Result<()> {
        if let Some(agent) = self.registry.get(&task.agent) {
            agent.run_task(&self.ctx, task).await?;
        }
        Ok(())
    }

    pub async fn shutdown(&mut self) -> Result<()> {
        for handle in self.listeners.drain(..) {
            handle.abort();
        }
        for agent in self.registry.all() {
            agent.shutdown(&self.ctx).await?;
        }
        Ok(())
    }
}
