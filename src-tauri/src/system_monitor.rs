use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, Networks, RefreshKind, System};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuMetrics {
    pub overall: f32,
    pub per_core: Vec<f32>,
    pub cpu_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryMetrics {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub usage_percent: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_usage: f32,
    pub memory_usage: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskMetrics {
    pub total: u64,
    pub available: u64,
    pub usage_percent: f32,
    pub read_bytes: u64,
    pub write_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkMetrics {
    pub received: u64,
    pub transmitted: u64,
    pub rx_rate: u64,
    pub tx_rate: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMetrics {
    pub timestamp: u64,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub processes: Vec<ProcessInfo>,
    pub disk: DiskMetrics,
    pub network: NetworkMetrics,
    pub load_average: [f32; 3],
    pub uptime: u64,
}

pub struct SystemMonitor {
    system: System,
    disks: Disks,
    networks: Networks,
    last_network_received: u64,
    last_network_transmitted: u64,
    last_check_time: u64,
}

impl SystemMonitor {
    pub fn new() -> Self {
        let system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();

        let (last_network_received, last_network_transmitted) = Self::get_network_totals(&networks);
        let last_check_time = Self::current_timestamp();

        Self {
            system,
            disks,
            networks,
            last_network_received,
            last_network_transmitted,
            last_check_time,
        }
    }

    pub fn refresh(&mut self) {
        self.system.refresh_all();
        self.disks.refresh(true);
        self.networks.refresh(true);
    }

    pub fn collect_metrics(&mut self) -> SystemMetrics {
        self.refresh();

        let timestamp = Self::current_timestamp();
        let cpu = self.collect_cpu_metrics();
        let memory = self.collect_memory_metrics();
        let processes = self.collect_top_processes(5);
        let disk = self.collect_disk_metrics();
        let (network, _rx_rate, _tx_rate) = self.collect_network_metrics(timestamp);

        let load = System::load_average();
        let load_average = [load.one as f32, load.five as f32, load.fifteen as f32];

        let uptime = System::uptime();

        SystemMetrics {
            timestamp,
            cpu,
            memory,
            processes,
            disk,
            network,
            load_average,
            uptime,
        }
    }

    fn collect_cpu_metrics(&self) -> CpuMetrics {
        let cpus = self.system.cpus();
        let per_core: Vec<f32> = cpus.iter().map(|c| c.cpu_usage()).collect();
        let overall = if per_core.is_empty() {
            0.0
        } else {
            per_core.iter().sum::<f32>() / per_core.len() as f32
        };

        CpuMetrics {
            overall,
            per_core,
            cpu_count: cpus.len(),
        }
    }

    fn collect_memory_metrics(&self) -> MemoryMetrics {
        let total = self.system.total_memory();
        let used = self.system.used_memory();
        let available = self.system.available_memory();
        let usage_percent = if total > 0 {
            (used as f32 / total as f32) * 100.0
        } else {
            0.0
        };

        MemoryMetrics {
            total,
            used,
            available,
            usage_percent,
        }
    }

    fn collect_top_processes(&self, count: usize) -> Vec<ProcessInfo> {
        let processes: Vec<_> = self.system.processes().iter()
            .map(|(pid, process)| ProcessInfo {
                pid: pid.as_u32(),
                name: process.name().to_string_lossy().into_owned(),
                cpu_usage: process.cpu_usage(),
                memory_usage: process.memory(),
            })
            .collect();

        let mut sorted: Vec<_> = processes.into_iter()
            .map(|p| (p.cpu_usage, p))
            .collect();
        sorted.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        sorted.into_iter()
            .take(count)
            .map(|(_, p)| p)
            .collect()
    }

    fn collect_disk_metrics(&self) -> DiskMetrics {
        let disk = self.disks.list().first();

        match disk {
            Some(d) => {
                let total = d.total_space();
                let available = d.available_space();
                let used = total.saturating_sub(available);
                let usage_percent = if total > 0 {
                    (used as f32 / total as f32) * 100.0
                } else {
                    0.0
                };

                DiskMetrics {
                    total,
                    available,
                    usage_percent,
                    read_bytes: 0,
                    write_bytes: 0,
                }
            }
            None => DiskMetrics {
                total: 0,
                available: 0,
                usage_percent: 0.0,
                read_bytes: 0,
                write_bytes: 0,
            }
        }
    }

    fn collect_network_metrics(&mut self, current_time: u64) -> (NetworkMetrics, u64, u64) {
        let (received, transmitted) = Self::get_network_totals(&self.networks);

        let time_delta = if current_time > self.last_check_time {
            current_time - self.last_check_time
        } else {
            1
        };

        let rx_rate = if time_delta > 0 {
            (received.saturating_sub(self.last_network_received)) / time_delta.max(1)
        } else {
            0
        };
        let tx_rate = if time_delta > 0 {
            (transmitted.saturating_sub(self.last_network_transmitted)) / time_delta.max(1)
        } else {
            0
        };

        self.last_network_received = received;
        self.last_network_transmitted = transmitted;
        self.last_check_time = current_time;

        let metrics = NetworkMetrics {
            received,
            transmitted,
            rx_rate: rx_rate * 1000,
            tx_rate: tx_rate * 1000,
        };

        (metrics, rx_rate * 1000, tx_rate * 1000)
    }

    fn get_network_totals(networks: &Networks) -> (u64, u64) {
        let mut received = 0u64;
        let mut transmitted = 0u64;

        for (_, data) in networks {
            received += data.total_received();
            transmitted += data.total_transmitted();
        }

        (received, transmitted)
    }

    fn current_timestamp() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

impl Default for SystemMonitor {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedSystemMonitor = Arc<RwLock<SystemMonitor>>;

pub fn create_system_monitor() -> SharedSystemMonitor {
    Arc::new(RwLock::new(SystemMonitor::new()))
}
