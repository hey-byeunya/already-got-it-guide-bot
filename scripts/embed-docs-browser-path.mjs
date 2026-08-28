// 청크 배열을 읽어 브라우저 RAG 용 벡터스토어를 만든다.
//
// 이름에 browser-path 가 붙은 이유: 브라우저가 쓰는 것과 **같은 경로**로 임베딩한다.
// 브라우저에서 pipeline() 을 그대로 부르면 기본 q4/q8 경로가 WASM ONNX Runtime 의
// GatherBlockQuantized 연산을 지원하지 않아 실패한다. 그래서 토크나이저는
// AutoTokenizer 로, 추론은 model_no_gather_q4.onnx 를 ort 세션에 직접 넘겨 나눈다.
// 문서 벡터와 질문 벡터가 다른 경로를 지나면 코사인 점수는 비교할 자리를 잃는다.
//
// 사용:
//   node scripts/embed-docs-browser-path.mjs                    문서 벡터 생성
//   node scripts/embed-docs-browser-path.mjs --queries a.txt    질문 벡터 생성(줄 단위)

import fs from "node:fs";
import path from "node:path";
import { AutoTokenizer } from "@huggingface/transformers";
import * as ort from "onnxruntime-web";

const MODEL_ID   = "onnx-community/embeddinggemma-300m-ONNX";
const MODEL_FILE = "onnx/model_no_gather_q4.onnx";   // q4 이되 GatherBlockQuantized 가 없는 판
const DATA_FILE  = "onnx/model_no_gather_q4.onnx_data";
const DIM        = 768;
const CACHE      = ".models";

// ── 모델 내려받기 (한 번만) ──────────────────────────────────────────────
async function ensure(file) {
  const dest = path.join(CACHE, path.basename(file));
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(CACHE, { recursive: true });
  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/${file}`;
  process.stdout.write(`내려받는 중: ${file} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file} 내려받기 실패: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)}MB`);
  return dest;
}

// ── 임베딩 ──────────────────────────────────────────────────────────────
let _tok = null, _sess = null;

async function load() {
  if (_sess) return { tok: _tok, sess: _sess };
  const modelPath = await ensure(MODEL_FILE);
  const dataPath  = await ensure(DATA_FILE);

  _tok = await AutoTokenizer.from_pretrained(MODEL_ID);
  _sess = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(modelPath)), {
    executionProviders: ["wasm"],
    externalData: [{ path: path.basename(DATA_FILE), data: new Uint8Array(fs.readFileSync(dataPath)) }],
  });
  console.log(`세션 입력 : ${_sess.inputNames.join(", ")}`);
  console.log(`세션 출력 : ${_sess.outputNames.join(", ")}`);
  return { tok: _tok, sess: _sess };
}

/** 문장 하나를 768차원 벡터로. mean pooling + L2 정규화. */
async function embed(text) {
  const { tok, sess } = await load();
  const enc = await tok(text, { add_special_tokens: true });

  const ids  = BigInt64Array.from(Array.from(enc.input_ids.data, (v) => BigInt(v)));
  const mask = BigInt64Array.from(Array.from(enc.attention_mask.data, (v) => BigInt(v)));
  const len  = ids.length;

  const feeds = {};
  for (const name of sess.inputNames) {
    if (name === "input_ids")      feeds[name] = new ort.Tensor("int64", ids,  [1, len]);
    else if (name === "attention_mask") feeds[name] = new ort.Tensor("int64", mask, [1, len]);
    else if (name === "position_ids")
      feeds[name] = new ort.Tensor("int64", BigInt64Array.from({ length: len }, (_, i) => BigInt(i)), [1, len]);
    else if (name === "token_type_ids")
      feeds[name] = new ort.Tensor("int64", new BigInt64Array(len), [1, len]);
  }

  const out  = await sess.run(feeds);
  const hidden = out.last_hidden_state ?? out[sess.outputNames[0]];
  const [, seq, dim] = hidden.dims;
  if (dim !== DIM) throw new Error(`차원이 ${dim} 이다. ${DIM} 이어야 한다`);

  // attention_mask 가 가리키는 실제 토큰만 평균낸다 (패딩이 문장 표현에 섞이지 않게)
  const h = hidden.data, v = new Float64Array(dim);
  let n = 0;
  for (let t = 0; t < seq; t++) {
    if (mask[t] === 0n) continue;
    n++;
    for (let d = 0; d < dim; d++) v[d] += h[t * dim + d];
  }
  for (let d = 0; d < dim; d++) v[d] /= n;

  // L2 정규화 — 정규화된 벡터끼리는 내적이 곧 코사인 유사도다
  let sum = 0;
  for (let d = 0; d < dim; d++) sum += v[d] * v[d];
  const norm = Math.sqrt(sum) || 1;
  return Array.from(v, (x) => x / norm);
}

// ── 실행 ────────────────────────────────────────────────────────────────
const qi = process.argv.indexOf("--queries");

if (qi >= 0) {
  const file = process.argv[qi + 1];
  const raw = fs.readFileSync(file, "utf8");
  const lines = file.endsWith(".json")
    ? JSON.parse(raw).map((r) => r.q)
    : raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const q of lines) {
    out.push({ query: q, vector: await embed(q) });
    console.log(`  질문 임베딩: ${q}`);
  }
  fs.mkdirSync(".sources", { recursive: true });
  fs.writeFileSync(".sources/query-vectors.json", JSON.stringify(out));
  console.log(`\n질문 ${out.length}개 → .sources/query-vectors.json`);
} else {
  const chunks = JSON.parse(fs.readFileSync("data/chunks.json", "utf8"));
  const rows = [];
  for (const c of chunks) {
    const vector = await embed(c.text);
    // id, text, url, section 을 보존하고 vector 만 더한다
    rows.push({ id: c.id, text: c.text, url: c.url, section: c.section, vector });
    console.log(`  ${c.id}  ${c.text.length}자 → ${vector.length}차원`);
  }

  // 검증 — 하나라도 어긋나면 파일을 쓰지 않는다
  const wrong = rows.filter((r) => r.vector.length !== DIM);
  if (wrong.length) throw new Error(`${DIM}차원이 아닌 청크: ${wrong.map((r) => r.id).join(", ")}`);
  const badNorm = rows.filter((r) => Math.abs(Math.hypot(...r.vector) - 1) > 1e-6);
  if (badNorm.length) throw new Error(`정규화되지 않은 청크: ${badNorm.map((r) => r.id).join(", ")}`);
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  if ([...keys].sort().join(",") !== "id,section,text,url,vector") throw new Error(`필드가 다르다: ${[...keys]}`);

  fs.mkdirSync("app/public", { recursive: true });
  fs.writeFileSync("app/public/already-got-it-docs.json", JSON.stringify(rows));

  console.log(`\n검증`);
  console.log(`  ${DIM}차원          : ${rows.length}/${rows.length} 통과`);
  console.log(`  L2 정규화(‖v‖=1) : ${rows.length}/${rows.length} 통과`);
  console.log(`  필드 보존         : id, text, url, section + vector`);
  console.log(`\n저장: app/public/already-got-it-docs.json (${(fs.statSync("app/public/already-got-it-docs.json").size / 1e6).toFixed(2)}MB)`);
}
