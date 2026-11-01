/** Calls onLost once when the supervising process is gone, so stopping the supervisor never orphans the server. */
export function watchSupervisor(pid: number, onLost: () => void, intervalMs = 1000) {
  const timer = setInterval(() => {
    try { process.kill(pid,0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      clearInterval(timer);
      onLost();
    }
  },intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
