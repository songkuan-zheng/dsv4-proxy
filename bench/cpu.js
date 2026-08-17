const crypto = require("crypto");
const fs = require("fs");
const KEY_FILE = process.env.CACHE_KEY_FILE || "./cache.key";
const key = Buffer.from(
  fs.readFileSync(KEY_FILE, "utf-8").trim(), "hex");

function run(label, sizeKB, iters) {
  const text = "第 N 轮推理:检查缓存实现,lock 只保护写路径。".repeat(
    Math.ceil(sizeKB * 1024 / 60));
  const bytes = Buffer.byteLength(text);
  // encrypt
  let t = process.hrtime.bigint();
  const out = [];
  for (let i = 0; i < iters; i++) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const b = Buffer.concat([c.update(text,"utf-8"), c.final()]);
    out.push(Buffer.concat([iv, c.getAuthTag(), b]).toString("base64"));
  }
  const encMs = Number(process.hrtime.bigint()-t)/1e6;
  // decrypt
  t = process.hrtime.bigint();
  for (const r of out) {
    const b = Buffer.from(r,"base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0,12));
    d.setAuthTag(b.subarray(12,28));
    Buffer.concat([d.update(b.subarray(28)), d.final()]);
  }
  const decMs = Number(process.hrtime.bigint()-t)/1e6;
  const totalMB = bytes*iters/1048576;
  console.log(
    `  ${label.padEnd(12)} 加密 ${(totalMB/(encMs/1000)).toFixed(0).padStart(4)} MB/s` +
    `   解密 ${(totalMB/(decMs/1000)).toFixed(0).padStart(4)} MB/s` +
    `   每条 ${(encMs*1000/iters).toFixed(1)}/${(decMs*1000/iters).toFixed(1)} µs`);
}
run("2.5KB 典型", 2.5, 20000);
run("120KB 最长", 120, 500);

// where does the time actually go?
const text = "推理内容".repeat(700); // ~2.5KB
const N = 20000;
let t = process.hrtime.bigint();
for (let i=0;i<N;i++) crypto.randomBytes(12);
console.log(`\n  拆解(每条 2.5KB,${N} 次):`);
console.log(`    randomBytes(12)   ${(Number(process.hrtime.bigint()-t)/1e6*1000/N).toFixed(2)} µs`);
t = process.hrtime.bigint();
for (let i=0;i<N;i++) { const iv=Buffer.alloc(12); const c=crypto.createCipheriv("aes-256-gcm",key,iv); c.update(text,"utf-8"); c.final(); }
console.log(`    AES-GCM 本体      ${(Number(process.hrtime.bigint()-t)/1e6*1000/N).toFixed(2)} µs`);
const enc = Buffer.from(text);
t = process.hrtime.bigint();
for (let i=0;i<N;i++) enc.toString("base64");
console.log(`    base64 编码       ${(Number(process.hrtime.bigint()-t)/1e6*1000/N).toFixed(2)} µs  <- 可省`);
