// Stops the app's process groups and the process left on the core port, and waits until they are gone: macOS shows an
// app whose own process ended while its children still run as "Running in Background".
export function createStopper({ pids, portOwners, sleep, kill = process.kill.bind(process), now = Date.now, deadlineMs = 10_000, pollMs = 100 }) {
  const send = (targets, signal) =>
    targets.filter((target) => {
      try {
        kill(target, signal);
        return true;
      } catch {
        return false;
      }
    });
  const signal = (name = 'SIGTERM') => send([...pids().map((pid) => -pid), ...portOwners()], name);
  let stopping = null;
  return {
    signal,
    stop() {
      stopping ??= (async () => {
        let alive = signal('SIGTERM');
        const deadline = now() + deadlineMs;
        while (alive.length && now() < deadline) {
          await sleep(pollMs);
          alive = send(alive, 0);
        }
        send(alive, 'SIGKILL');
      })();
      return stopping;
    },
  };
}
