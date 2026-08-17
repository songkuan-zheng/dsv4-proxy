// Isolate the crypto cost: same data, same Redis, encryption on vs off.
const crypto = require("crypto");
const fs = require("fs");
const Redis = require("ioredis");
const KEY_FILE = process.env.CACHE_KEY_FILE || "./cache.key";
const PREFIX = "dsv4bench2:";
const TTL = 3600;
const key = Buffer.from(
  fs.readFileSync(KEY_FILE, "utf-8").trim(), "hex");

const enc = (t) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const b = Buffer.concat([c.update(t, "utf-8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), b]).toString("base64");
};
const dec = (r) => {
  const b = Buffer.from(r, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf-8");
};

const trace = (i) =>
  `第 ${i} 轮:检查 module_${i}.py,lock 只保护写路径,两个调用方都会 miss。`.repeat(30);

(async () => {
  const redis = new Redis("redis://127.0.0.1:6380");
  const N = 10000, ids = Array.from({length:N},(_,i)=>`k${i}`);

  // --- pure CPU cost, no Redis involved ---
  const samples = ids.map((_, i) => trace(i));
  let t = process.hrtime.bigint();
  const encoded = samples.map(enc);
  const encMs = Number(process.hrtime.bigint()-t)/1e6;
  t = process.hrtime.bigint();
  encoded.forEach(dec);
  const decMs = Number(process.hrtime.bigint()-t)/1e6;
  const plainBytes = samples.reduce((a,s)=>a+Buffer.byteLength(s),0);
  const encBytes = encoded.reduce((a,s)=>a+s.length,0);
  console.log("纯 CPU (10000 条, 每条 %.1fKB):", plainBytes/N/1024);
  console.log("  加密 %.0fms (%.1f µs/条)   解密 %.0fms (%.1f µs/条)",
    encMs, encMs*1000/N, decMs, decMs*1000/N);
  console.log("  体积膨胀: %.1fMB -> %.1fMB (+%.0f%%)",
    plainBytes/1048576, encBytes/1048576, (encBytes/plainBytes-1)*100);

  // --- end to end through Redis, both modes ---
  for (const mode of ["明文", "加密"]) {
    const use = mode === "加密";
    const P = PREFIX + (use ? "e:" : "p:");
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i += 200) {
      const pipe = redis.pipeline();
      for (let j = i; j < Math.min(i+200, N); j++)
        pipe.set(P + ids[j], use ? encoded[j] : samples[j], "EX", TTL);
      await pipe.exec();
    }
    const w = Number(process.hrtime.bigint()-t0)/1e6;

    const runs = [];
    for (let r = 0; r < 5; r++) {
      const t1 = process.hrtime.bigint();
      const pipe = redis.pipeline();
      for (let j = 0; j < 200; j++) pipe.getex(P + ids[j], "EX", TTL);
      const res = await pipe.exec();
      for (const [e, v] of res) if (!e && v) { if (use) dec(v); }
      runs.push(Number(process.hrtime.bigint()-t1)/1e6);
    }
    runs.sort((a,b)=>a-b);
    console.log("%s: 写 10000 条 %.0fms | 回填 200 key p50 %.2fms",
      mode, w, runs[2]);
    for (let i = 0; i < N; i += 500)
      await redis.unlink(...ids.slice(i,i+500).map(k=>P+k));
  }
  await redis.quit();
})().catch(e=>{console.error(e);process.exit(1)});
