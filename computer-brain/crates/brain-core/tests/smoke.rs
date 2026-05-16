use brain_core::BrainCore;
use shared_types::BrainConfig;
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
