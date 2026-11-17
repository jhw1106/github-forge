// Entry point for the GitHub-compatible forge: the harness lifecycle.
//
// This process is only a thin shell around the server built in app.ts. Its job
// is to (a) find the trial env, (b) bind a port the kernel chooses, (c) tell
// the env where to reach the server, and (d) stay alive until the env reports
// the trial is over. The forge itself lives in app.ts; nothing here is scored
// except that the lifecycle works.
//
// The contract with the env:
//   - MAKEFUN_ENV_URL is the env's origin, e.g. http://store:8080 inside a
//     trial container. Absent, the process has nothing to talk to and exits 1.
//   - The server binds port 0. The env owns 8080, so it is never bound here.
//   - POST /register {"port": N} announces the bound port. 200 is the usual
//     answer; 409 means an earlier entry already registered, which is fine --
//     this process still waits for done like any other. 400/405 mean the
//     request itself is malformed, so the process gives up at once.
//   - GET /done answers {"done": false} while the suite runs and
//     {"done": true} when it is over. A poll that fails or times out is
//     retried; the process only leaves once done is true.
//   - Then the server is closed and the process exits 0.

import { createApp } from './app.ts';

// The env's origin, with trailing slashes stripped so "/register" and "/done"
// can be appended plainly.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!envOrigin) {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set; nothing to register with\n');
  process.exit(1);
}

// One request gets this long before it is abandoned and retried.
const REQUEST_BUDGET_MS = 30_000;
// Retry pauses start here and double after each failure, up to this ceiling.
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Thrown when the env rejects a request as malformed: retrying would not help. */
class ContractError extends Error {}

/**
 * Call `step` until it returns true. Between attempts, wait a pause that
 * starts at BACKOFF_START_MS and doubles up to BACKOFF_CEILING_MS. A
 * ContractError stops retrying at once; any other throw is treated as a
 * transient failure (env not up yet, request timed out) and retried.
 */
async function untilTrue(step: () => Promise<boolean>): Promise<void> {
  let waitMs = BACKOFF_START_MS;
  for (;;) {
    try {
      if (await step()) return;
    } catch (err) {
      if (err instanceof ContractError) throw err;
      // Transient: fall through to the pause and try again.
    }
    await pause(waitMs);
    waitMs = Math.min(BACKOFF_CEILING_MS, waitMs * 2);
  }
}

/** Announce the bound port to the env; true once the env has accepted it. */
async function announce(port: number): Promise<boolean> {
  const res = await fetch(`${envOrigin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
  });
  if (res.status === 200 || res.status === 409) return true;
  if (res.status === 400 || res.status === 405) {
    throw new ContractError(`register rejected with HTTP ${res.status}: ${await res.text()}`);
  }
  return false;
}

/** Ask the env whether the trial is over; true once it answers done. */
async function trialOver(): Promise<boolean> {
  const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
  if (!res.ok) return false;
  const body = (await res.json()) as { done?: unknown };
  return body.done === true;
}

/** The whole life of the process: bind, announce, wait, shut down. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on ${bound.port}\n`);

  await untilTrue(() => announce(bound.port));
  process.stdout.write('[forge] registered; waiting for the trial to finish\n');

  await untilTrue(trialOver);
  server.close();
  process.stdout.write('[forge] trial done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
