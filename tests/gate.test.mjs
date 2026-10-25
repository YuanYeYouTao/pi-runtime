import { Gate } from "../src/gate.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) concurrency is capped: with max 2, a third acquisition waits
{
  const gate = new Gate(2, 0);
  let peak = 0;
  let active = 0;
  const task = async (ms) => {
    const release = await gate.acquire();
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, ms));
    active--;
    release();
  };
  await Promise.all([task(30), task(30), task(30), task(30)]);
  check("never exceeds maxConcurrent", peak === 2, `peak=${peak}`);
  check("all tasks completed", active === 0, `active=${active}`);
}

// 2) release is idempotent (double release must not free two slots)
{
  const gate = new Gate(1, 0);
  const release = await gate.acquire();
  release();
  release();
  const started = Date.now();
  const second = await gate.acquire();
  check("double release does not over-free", gate.inFlight === 1 && Date.now() - started < 50, `inFlight=${gate.inFlight}`);
  second();
}

// 3) minInterval spaces out starts
{
  const gate = new Gate(5, 40);
  const startedAt = [];
  for (let i = 0; i < 3; i++) {
    const release = await gate.acquire();
    startedAt.push(Date.now());
    release();
  }
  const gaps = [startedAt[1] - startedAt[0], startedAt[2] - startedAt[1]];
  check("starts are spaced by minInterval", gaps.every((gap) => gap >= 30), JSON.stringify(gaps));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
