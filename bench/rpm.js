// Measure the proxy's own ceiling: a mock upstream returns instantly, so the
// numbers reflect parse + backfill + scrub + stringify, not inference.
const http = require("http");
const { spawn } = require("child_process");
const KEY_FILE = process.env.CACHE_KEY_FILE || "./cache.key";

const UP_PORT = 19100, PROXY_PORT = 19101;

const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const body = JSON.stringify({
      id: "x",
      choices: [{ index: 0, message: { role: "assistant", content: "ok",
        reasoning_content: "brief" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, reasoning_tokens: 5 },
    });
    res.writeHead(200, {"content-type":"application/json",
      "content-length": Buffer.byteLength(body)});
    res.end(body);
  });
});

function makeBody(turns, toolResultKB) {
  const messages = [
    { role: "system", content: "You are a coding agent. ".repeat(400) },
    { role: "user", content: "Fix the bug." },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [
      { id: `call_bench${String(i).padStart(20,"0")}`, type: "function",
        function: { name: "read_file", arguments: JSON.stringify({path:`m${i}.py`}) } }]});
    messages.push({ role: "tool", tool_call_id: `call_bench${String(i).padStart(20,"0")}`,
      content: "x".repeat(toolResultKB * 1024) });
  }
  return JSON.stringify({ model: "m", messages,
    tools: Array.from({length:44},(_,i)=>({type:"function",
      function:{name:`tool${i}`,description:"d",
        parameters:{type:"object",properties:{a:{type:"string"}}}}})) });
}

function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({host:"127.0.0.1",port:PROXY_PORT,
      path:"/v1/chat/completions",method:"POST",
      headers:{"content-type":"application/json","content-length":Buffer.byteLength(body)}},
      (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", reject);
    req.end(body);
  });
}

async function measure(label, body, concurrency, seconds) {
  const sizeMB = Buffer.byteLength(body)/1048576;
  let done = 0, stop = false;
  const deadline = Date.now() + seconds*1000;
  const workers = Array.from({length:concurrency}, async () => {
    while (!stop && Date.now() < deadline) { await post(body); done++; }
  });
  await Promise.all(workers);
  stop = true;
  const rps = done / seconds;
  console.log(`  ${label.padEnd(26)} 并发${String(concurrency).padStart(3)}  ` +
    `${(sizeMB*1024).toFixed(0).padStart(5)}KB/req  ` +
    `${rps.toFixed(0).padStart(5)} req/s = ${(rps*60).toFixed(0).padStart(6)} RPM`);
  return rps;
}

(async () => {
  await new Promise(r => upstream.listen(UP_PORT, "127.0.0.1", r));
  const proxy = spawn("node", ["proxy.js"], { env: { ...process.env,
    UPSTREAM: `http://127.0.0.1:${UP_PORT}`, PORT: String(PROXY_PORT),
    DEFAULT_REASONING_EFFORT: "max", REASONING_EFFORT_OVERRIDE: "1",
    BACKFILL_REASONING: "1", BACKFILL_MAX_TURNS: "0",
    REASONING_REDIS_URL: "redis://127.0.0.1:6380",
    REASONING_REDIS_PREFIX: "dsv4rpm:",
    REASONING_CACHE_KEY_FILE: KEY_FILE,
    SCRUB_ASSISTANT_LOOPS: "1", LOG_REASONING: "0",
  }, stdio: ["ignore","ignore","inherit"] });
  await new Promise(r => setTimeout(r, 1500));

  console.log("小请求(2 轮历史,类似标题生成):");
  await measure("2 turns / 1KB tool result", makeBody(2, 1), 8, 4);
  await measure("2 turns / 1KB tool result", makeBody(2, 1), 32, 4);

  console.log("\n中等(50 轮历史):");
  await measure("50 turns / 4KB", makeBody(50, 4), 8, 4);
  await measure("50 turns / 4KB", makeBody(50, 4), 32, 4);

  console.log("\n生产规模(200 轮历史,约 1MB):");
  await measure("200 turns / 4KB", makeBody(200, 4), 8, 5);
  await measure("200 turns / 4KB", makeBody(200, 4), 16, 5);

  proxy.kill();
  upstream.close();
  const Redis = require("ioredis");
  const r = new Redis("redis://127.0.0.1:6380");
  const keys = await r.keys("dsv4rpm:*");
  if (keys.length) for (let i=0;i<keys.length;i+=500) await r.unlink(...keys.slice(i,i+500));
  await r.quit();
})().catch(e => { console.error(e); process.exit(1); });
