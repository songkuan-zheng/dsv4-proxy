// Simulate one long agent session: write 10000 traces, then replay a turn's
// worth of backfill lookups the way the proxy actually does it.
const crypto = require("crypto");
const fs = require("fs");
const Redis = require("ioredis");
const KEY_FILE = process.env.CACHE_KEY_FILE || "./cache.key";

const PREFIX = "dsv4bench:rc:";
const TTL = 86400;
const key = Buffer.from(
  fs.readFileSync(KEY_FILE, "utf-8").trim(), "hex");

function encodeValue(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(text, "utf-8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}
function decodeValue(raw) {
  const buf = Buffer.from(raw, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf-8");
}

// Realistic trace: mixed lengths, Chinese + code, like production
function makeTrace(i) {
  const n = 200 + (i * 37) % 3000;
  return `第 ${i} 轮推理:检查 module_${i}.py 的缓存实现,lock 只保护写路径。` .repeat(Math.max(1, Math.floor(n / 60)));
}

(async () => {
  const redis = new Redis("redis://127.0.0.1:6380");
  await redis.ping();
  const ids = Array.from({length: 10000}, (_, i) => `call_bench${String(i).padStart(20,"0")}`);

  // ---- write: batched pipelines, as pushReasoning does ----
  let bytes = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ids.length; i += 200) {
    const pipe = redis.pipeline();
    for (const id of ids.slice(i, i + 200)) {
      const v = encodeValue(makeTrace(i));
      bytes += v.length;
      pipe.set(PREFIX + id, v, "EX", TTL);
    }
    await pipe.exec();
  }
  const wms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`写入 10000 条: ${wms.toFixed(0)}ms  (${(10000/(wms/1000)).toFixed(0)} 条/秒)`);
  console.log(`  加密后数据量: ${(bytes/1048576).toFixed(1)}MB  平均 ${(bytes/10000/1024).toFixed(1)}KB/条`);

  // ---- read: one pipeline of GETEX, the per-request backfill pattern ----
  for (const n of [50, 200, 500, 1000]) {
    const sample = ids.slice(0, n);
    const runs = [];
    for (let r = 0; r < 5; r++) {
      const t = process.hrtime.bigint();
      const pipe = redis.pipeline();
      for (const id of sample) pipe.getex(PREFIX + id, "EX", TTL);
      const res = await pipe.exec();
      let ok = 0;
      for (const [err, val] of res) if (!err && val) { decodeValue(val); ok++; }
      runs.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (ok !== n) throw new Error(`only ${ok}/${n} hits`);
    }
    runs.sort((a,b)=>a-b);
    console.log(`回填 ${String(n).padStart(4)} key: p50=${runs[2].toFixed(1)}ms  min=${runs[0].toFixed(1)}ms  max=${runs[4].toFixed(1)}ms  (含解密)`);
  }

  const info = await redis.info("memory");
  console.log("Redis 内存:", /used_memory_human:(\S+)/.exec(info)[1]);

  // cleanup
  for (let i = 0; i < ids.length; i += 500) {
    await redis.unlink(...ids.slice(i, i+500).map(k => PREFIX + k));
  }
  await redis.quit();
})().catch(e => { console.error("bench failed:", e); process.exit(1); });
