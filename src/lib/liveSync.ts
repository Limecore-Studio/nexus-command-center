// v1.20 (NCC#221) — start and stop live sync without putting the engine in
// the startup bundle. realtime.ts loads on the first start; a stop that comes
// in while it is still loading wins, so a sign-out mid-load leaves nothing open.

type Engine = typeof import('./realtime');

let engine: Engine | null = null;
let wanted: string | null = null;

export function startLive(userId: string): void {
  wanted = userId;
  void import('./realtime')
    .then((m) => {
      engine = m;
      if (wanted === userId) m.startRealtime(userId);
    })
    .catch((e) => console.warn('[realtime] live sync failed to load:', (e as Error).message));
}

export function stopLive(): void {
  wanted = null;
  engine?.stopRealtime();
}
