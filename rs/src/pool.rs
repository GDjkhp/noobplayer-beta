//! Worker pool for the CPU-heavy audio analysis stages (the Rust counterpart of
//! the Python ProcessPoolExecutor): a few dedicated, lowered-priority threads so
//! the 20 ms relay pacing loop on the main runtime is never starved.
//! A job that panics is reported as a crash, which the caller retries on a fresh
//! pool exactly like the original's BrokenProcessPool handling.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex as StdMutex};

use parking_lot::Mutex;
use tokio::sync::oneshot;

use crate::{analysis, config};

type Job = Box<dyn FnOnce() + Send + 'static>;

pub struct Pool {
    tx: Mutex<Option<Sender<Job>>>,
}

static POOL: Mutex<Option<Arc<Pool>>> = Mutex::new(None);
/// How many times the worker pool died under us.
static BROKEN: AtomicU32 = AtomicU32::new(0);

/// Make this thread yield to the relay (nice 10 on Linux).
fn lower_priority() {
    #[cfg(target_os = "linux")]
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, 10);
    }
}

impl Pool {
    fn new(n: usize) -> Arc<Self> {
        let (tx, rx) = channel::<Job>();
        let rx = Arc::new(StdMutex::new(rx));
        for i in 0..n {
            let rx = rx.clone();
            std::thread::Builder::new()
                .name(format!("analysis-{i}"))
                .stack_size(16 * 1024 * 1024)
                .spawn(move || {
                    lower_priority();
                    let _ = catch_unwind(analysis::warmup);
                    loop {
                        let job = { rx.lock().unwrap().recv() };
                        match job {
                            Ok(j) => j(),
                            Err(_) => break,
                        }
                    }
                })
                .expect("spawn analysis worker");
        }
        let pool = Arc::new(Pool { tx: Mutex::new(Some(tx)) });
        // Spawn every worker now so the first real track doesn't pay for the start.
        for _ in 0..n {
            pool.submit(Box::new(|| {}));
        }
        pool
    }

    fn submit(&self, j: Job) {
        if let Some(tx) = self.tx.lock().as_ref() {
            let _ = tx.send(j);
        }
    }

    /// Run `f` on a worker. Err = the job panicked.
    pub async fn run<T: Send + 'static>(&self, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
        let (otx, orx) = oneshot::channel();
        self.submit(Box::new(move || {
            let r = catch_unwind(AssertUnwindSafe(f)).map_err(|e| {
                e.downcast_ref::<String>()
                    .cloned()
                    .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "worker panicked".into())
            });
            let _ = otx.send(r);
        }));
        match orx.await {
            Ok(r) => r,
            Err(_) => Err("worker pool shut down".into()),
        }
    }

    fn shutdown(&self) {
        self.tx.lock().take();
    }
}

pub fn broken() -> u32 {
    BROKEN.load(Ordering::SeqCst)
}

/// The worker pool, or Ok(None) to run stages on the runtime's blocking pool
/// (only when AUDIO_ANALYSIS_USE_PROCESS = false). If the workers keep dying
/// this errors instead of falling back.
pub fn get_pool() -> Result<Option<Arc<Pool>>, String> {
    if !config::AUDIO_ANALYSIS_USE_PROCESS {
        return Ok(None);
    }
    if broken() >= 2 {
        return Err("analysis worker processes keep crashing — analysis disabled until the server restarts".into());
    }
    let mut g = POOL.lock();
    if g.is_none() {
        let n = if config::AUDIO_ANALYSIS_WORKERS == 0 { 2 } else { config::AUDIO_ANALYSIS_WORKERS };
        *g = Some(Pool::new(n));
    }
    Ok(g.clone())
}

/// Drop the dead pool. `dead` is the pool the failing job used: if it was
/// already replaced nothing more to do.
pub fn reset_pool(dead: Option<&Arc<Pool>>) {
    let mut g = POOL.lock();
    if let Some(d) = dead {
        match g.as_ref() {
            Some(cur) if Arc::ptr_eq(cur, d) => {}
            _ => return,
        }
    }
    BROKEN.fetch_add(1, Ordering::SeqCst);
    if let Some(p) = g.take() {
        p.shutdown();
    }
}

pub fn shutdown() {
    if let Some(p) = POOL.lock().take() {
        p.shutdown();
    }
}

/// Hand freed heap pages back to the OS (glibc malloc_trim; a no-op elsewhere).
pub fn trim_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}
