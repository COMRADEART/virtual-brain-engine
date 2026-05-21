use brain_core::BrainCore;
use chrono::Utc;
use shared_types::{BrainConfig, BrainEvent, OperatingMode, ToolProvider, ToolResult};
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn brain_core_indexes_memory_and_updates_graph() -> anyhow::Result<()> {
    let mut db_path = std::env::temp_dir();
    db_path.push(format!("computer-brain-smoke-{}.sqlite", uuid::Uuid::new_v4()));

    let config = BrainConfig {
        data_dir: std::env::temp_dir().to_string_lossy().into_owned(),
        sqlite_path: db_path.to_string_lossy().into_owned(),
        embedding_dimensions: 128,
        ..BrainConfig::default()
    };

    let mut core = BrainCore::boot(config)?;
    core.start().await?;

    let memory = core.ingest_memory(
        "Dimensional Core replay engine stability work and semantic memory graph design"
            .to_string(),
        vec!["dimensional-core".to_string(), "replay".to_string()],
        Some("src/replay_engine.rs".to_string()),
    )?;

    let mut found_semantic_hit = false;
    let mut found_graph_edge = false;

    for _ in 0..25 {
        let hits = core.semantic_search("replay engine stability", 5).await?;
        found_semantic_hit |= hits.iter().any(|hit| hit.memory.id == memory.id);

        let (nodes, edges) = core.graph_snapshot()?;
        found_graph_edge |= nodes.iter().any(|node| node.label == "manual memory") && !edges.is_empty();

        if found_semantic_hit && found_graph_edge {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }

    assert!(found_semantic_hit, "semantic memory agent should index stored memories");
    assert!(found_graph_edge, "project agent should project memories into the knowledge graph");

    let _ = std::fs::remove_file(db_path);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_actions_create_learned_skill() -> anyhow::Result<()> {
    let mut db_path = std::env::temp_dir();
    db_path.push(format!("computer-brain-skill-{}.sqlite", uuid::Uuid::new_v4()));

    let config = BrainConfig {
        data_dir: std::env::temp_dir().to_string_lossy().into_owned(),
        sqlite_path: db_path.to_string_lossy().into_owned(),
        embedding_dimensions: 128,
        ..BrainConfig::default()
    };

    let mut core = BrainCore::boot(config)?;
    core.start().await?;

    for _ in 0..3 {
        core.services.bus.emit(
            BrainEvent::ActionObserved {
                actor: "CommandAgent".to_string(),
                action: "cargo check".to_string(),
                capability: "terminal.execute".to_string(),
                ok: true,
                at: Utc::now(),
            },
            Some("test".to_string()),
        )?;
    }

    let mut learned = false;
    for _ in 0..25 {
        let counts = core.services.memory.counts()?;
        learned = counts.get("learnedSkills").and_then(|v| v.as_i64()).unwrap_or(0) > 0;
        if learned {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }

    assert!(learned, "SkillAgent should persist a learned skill after repeated safe actions");

    let _ = std::fs::remove_file(db_path);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cognitive_loop_records_observations_reflections_and_lessons() -> anyhow::Result<()> {
    let mut db_path = std::env::temp_dir();
    db_path.push(format!("computer-brain-cognitive-{}.sqlite", uuid::Uuid::new_v4()));

    let config = BrainConfig {
        data_dir: std::env::temp_dir().to_string_lossy().into_owned(),
        sqlite_path: db_path.to_string_lossy().into_owned(),
        embedding_dimensions: 128,
        ..BrainConfig::default()
    };

    let mut core = BrainCore::boot(config)?;
    core.start().await?;
    core.set_operating_mode(OperatingMode::Assisted)?;

    core.user_message("Run cargo test and explain any SQLite migration failures".to_string())
        .await?;
    core.services.bus.emit(
        BrainEvent::ToolCompleted {
            result: ToolResult {
                request_id: "tool-test".to_string(),
                provider: ToolProvider::Shell,
                ok: false,
                output: serde_json::json!({
                    "stderr": "cargo test failed: SQLite migration mismatch",
                    "duration_ms": 1200
                }),
                error: Some("SQLite migration mismatch".to_string()),
            },
            at: Utc::now(),
        },
        Some("test".to_string()),
    )?;

    let mut complete = false;
    for _ in 0..30 {
        let counts = core.services.memory.counts()?;
        if counts.get("goals").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("consciousnessCycles").and_then(|v| v.as_i64()).unwrap_or(0) == 0
        {
            core.run_consciousness_once();
        }
        complete = counts.get("observations").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("understandings").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("planningQuality").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("executionOutcomes").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("reflections").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("lessons").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("adaptations").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("goals").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            && counts.get("consciousnessCycles").and_then(|v| v.as_i64()).unwrap_or(0) > 0;
        if complete {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert!(complete, "cognitive loop should persist perception, reflection, learning, and adaptation records");

    let _ = std::fs::remove_file(db_path);
    Ok(())
}
