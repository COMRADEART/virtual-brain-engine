use anyhow::Result;
use chrono::Utc;
use parking_lot::RwLock;
use shared_types::{new_id, BrainEvent, BrainEventEnvelope};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct BrainBus {
    tx: broadcast::Sender<BrainEventEnvelope>,
    log: Arc<RwLock<VecDeque<BrainEventEnvelope>>>,
    log_limit: usize,
}

impl BrainBus {
    pub fn new(capacity: usize, log_limit: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(16));
        Self {
            tx,
            log: Arc::new(RwLock::new(VecDeque::with_capacity(log_limit.max(1)))),
            log_limit: log_limit.max(1),
        }
    }

    pub fn emit(&self, event: BrainEvent, source_agent: Option<String>) -> Result<BrainEventEnvelope> {
        let envelope = BrainEventEnvelope {
            id: new_id("evt"),
            occurred_at: Utc::now(),
            event,
            source_agent,
            correlation_id: None,
        };
        {
            let mut log = self.log.write();
            if log.len() >= self.log_limit {
                log.pop_front();
            }
            log.push_back(envelope.clone());
        }
        let _ = self.tx.send(envelope.clone());
        Ok(envelope)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BrainEventEnvelope> {
        self.tx.subscribe()
    }

    pub fn recent(&self, limit: usize) -> Vec<BrainEventEnvelope> {
        let log = self.log.read();
        log.iter().rev().take(limit).cloned().collect()
    }
}

impl Default for BrainBus {
    fn default() -> Self {
        Self::new(512, 2_000)
    }
}
