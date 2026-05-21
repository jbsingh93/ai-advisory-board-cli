/**
 * Minimal web-reachability probe used by `aab doctor` to flag when the
 * Skill Planner's web-research phase (§6.4) is likely to be degraded.
 *
 * Pure HEAD against `https://www.anthropic.com/` with a short timeout —
 * no API key, no Claude call. Returns latency + a reason on failure so
 * the operator can see whether they're offline, behind a proxy, or DNS
 * is broken.
 */
import { request } from 'node:https';

export interface WebProbeResult {
  reachable: boolean;
  host: string;
  latencyMs: number;
  reason?: string;
}

export async function probeWebReachability(
  opts: { host?: string; timeoutMs?: number } = {},
): Promise<WebProbeResult> {
  const host = opts.host ?? 'www.anthropic.com';
  const timeoutMs = opts.timeoutMs ?? 1500;
  const start = Date.now();
  return new Promise<WebProbeResult>((resolve) => {
    let settled = false;
    const settleOnce = (r: WebProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = request(
      { host, method: 'HEAD', path: '/', timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        settleOnce({
          reachable: status >= 200 && status < 500,
          host,
          latencyMs: Date.now() - start,
          reason: status >= 500 ? `HTTP ${status}` : undefined,
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      settleOnce({ reachable: false, host, latencyMs: Date.now() - start, reason: 'timeout' });
    });
    req.on('error', (err) => {
      settleOnce({
        reachable: false,
        host,
        latencyMs: Date.now() - start,
        reason: err.message.split('\n')[0]!.slice(0, 80),
      });
    });
    req.end();
  });
}
