// 하이브리드 검색 확인 — 특히 BM25 가 무엇을 보태는지 본다.
//
//   node scripts/check_hybrid.ts
//
// 질문 벡터는 embed-docs-browser-path.mjs 가 만든 것을 그대로 쓴다.
// 여기서 다시 임베딩하지 않는다 — 다른 경로로 만들면 점수가 뜻을 잃는다.

import fs from "node:fs";
import {
  buildBm25Index, bm25Scores, cosine, hybridSearch,
  VECTOR_TOP_K, BM25_TOP_K, WEAK_EVIDENCE_THRESHOLD,
  type Chunk,
} from "../app/src/lib/search.ts";

const chunks: Chunk[] = JSON.parse(fs.readFileSync("app/public/already-got-it-docs.json", "utf8"));
const qvecs = new Map<string, number[]>(
  JSON.parse(fs.readFileSync(".sources/query-vectors.json", "utf8")).map((r: any) => [r.query, r.vector]),
);
const queries: { q: string; expect: string[]; kind: string }[] =
  JSON.parse(fs.readFileSync("data/spotcheck-queries.json", "utf8"));

const index = buildBm25Index(chunks);

console.log(`문서 ${chunks.length}개 · 질문 ${queries.length}개`);
console.log(`설정: 코사인 상위 ${VECTOR_TOP_K} + 미중복 BM25 상위 ${BM25_TOP_K}, 약한 근거 임계 ${WEAK_EVIDENCE_THRESHOLD}\n`);

// 코퍼스가 작으면 상위 10 + 미중복 5 가 전체를 덮는다. 먼저 그 사실부터 재 둔다.
console.log(`⚠️ 코퍼스가 ${chunks.length}개이므로 코사인 상위 ${VECTOR_TOP_K}만으로 이미 ${Math.min(VECTOR_TOP_K, chunks.length)}/${chunks.length}를 덮는다.`);
console.log(`   BM25 가 새로 넣을 수 있는 자리는 최대 ${Math.max(0, chunks.length - VECTOR_TOP_K)}개다.\n`);

const rows: any[] = [];
console.log(`${"질문".padEnd(42)} ${"근거수".padStart(4)} ${"약함".padStart(4)}  ${"BM25로 들어온 것".padEnd(22)} BM25 자체 1위`);
console.log("-".repeat(118));

for (const { q, expect, kind } of queries) {
  const qv = qvecs.get(q);
  if (!qv) throw new Error(`질문 벡터 없음: ${q}`);
  const res = hybridSearch(chunks, index, qv, q);

  const viaBm25 = res.hits.filter((h) => h.method === "bm25");
  // BM25 만으로 순위를 매기면 무엇이 1위인지 (미중복 제한을 걷어낸 순수 신호)
  const raw = bm25Scores(index, q);
  const bmRank = [...raw.entries()].sort((a, b) => b[1] - a[1]);
  const bmTop = bmRank[0]?.[0] ?? "-";
  const bmTopHitsExpect = expect.includes(bmTop);

  const cosRank = chunks
    .map((c) => ({ id: c.id, s: cosine(qv, c.vector) }))
    .sort((a, b) => b.s - a.s);
  const cosTop = cosRank[0].id;

  const bmLabel = viaBm25.length
    ? viaBm25.map((h) => `${h.chunk.id}(${h.score.toFixed(2)})`).join(" ")
    : "없음";
  const mark = expect.length ? (bmTopHitsExpect ? "◎" : " ") : " ";
  console.log(
    `${q.padEnd(42)} ${String(res.hits.length).padStart(4)} ${(res.weakEvidence ? "예" : "아니오").padStart(4)}  ${bmLabel.padEnd(22)} ${bmTop}${mark}`,
  );

  rows.push({
    q, kind, expect,
    cosine_top1: cosTop,
    bm25_top1: bmTop,
    bm25_top1_ok: expect.length ? bmTopHitsExpect : null,
    hits: res.hits.length,
    via_bm25: viaBm25.map((h) => h.chunk.id),
    top_score: +res.topScore.toFixed(4),
    weak_evidence: res.weakEvidence,
  });
}

console.log("-".repeat(118));
console.log("◎ = BM25 자체 1위가 기대 청크와 일치\n");

// ── C 에서 코사인이 놓친 2건을 BM25 가 어떻게 보는지 ──────────────────
const MISSED = ["수량을 0으로 등록할 수 있나요?", "어제 본 D-day랑 숫자가 다른데 왜 그래요?"];
console.log("C 에서 코사인 top-1 이 빗나갔던 2건 — 낱말 검색은 어떻게 보는가\n");
for (const q of MISSED) {
  const r = rows.find((x) => x.q === q)!;
  const raw = bm25Scores(index, q);
  const top3 = [...raw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const max = top3[0]?.[1] ?? 1;
  console.log(`  "${q}"`);
  console.log(`    기대       : ${r.expect.join(", ")}`);
  console.log(`    코사인 1위 : ${r.cosine_top1}`);
  console.log(`    BM25 1~3위 : ${top3.map(([id, s]) => `${id}(${(s / max).toFixed(2)})`).join("  ") || "(겹치는 낱말 없음)"}`);
  console.log(`    판정       : ${r.bm25_top1_ok ? "BM25 가 기대 청크를 1위로 올렸다" : "BM25 도 기대 청크를 1위로 올리지 못했다"}\n`);
}

// ── 정확한 표기가 중요한 질문 — BM25 보조 효과를 직접 겨눈다 ──────────
const probes: { q: string; expect: string[]; kind: string }[] =
  JSON.parse(fs.readFileSync("data/bm25-probe-queries.json", "utf8"));

console.log("\n" + "=".repeat(118));
console.log("정확한 표기·고유명사가 중요한 질문 — BM25 가 실제로 보태는가\n");
console.log(`${"질문".padEnd(46)} ${"코사인1위".padEnd(9)} ${"BM251위".padEnd(9)} ${"기대".padEnd(16)} 판정`);
console.log("-".repeat(118));

let probeCos = 0, probeBm = 0;
for (const { q, expect, kind } of probes) {
  const qv = qvecs.get(q);
  if (!qv) throw new Error(`질문 벡터 없음: ${q}`);
  const cosTop = chunks.map((c) => ({ id: c.id, s: cosine(qv, c.vector) })).sort((a, b) => b.s - a.s)[0].id;
  const raw = bm25Scores(index, q);
  const bmTop = [...raw.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
  const cOk = expect.includes(cosTop), bOk = expect.includes(bmTop);
  probeCos += +cOk; probeBm += +bOk;
  const verdict = bOk && !cOk ? "★ BM25 만 맞혔다" : bOk && cOk ? "둘 다 맞음" : !bOk && cOk ? "코사인만 맞음" : "둘 다 틀림";
  console.log(`${q.padEnd(46)} ${(cosTop + (cOk ? "◎" : " ")).padEnd(9)} ${(bmTop + (bOk ? "◎" : " ")).padEnd(9)} ${expect.join(",").padEnd(16)} ${verdict}`);
  rows.push({ q, kind, expect, cosine_top1: cosTop, bm25_top1: bmTop,
              cosine_top1_ok: cOk, bm25_top1_ok: bOk, probe: true });
}
console.log("-".repeat(118));
console.log(`정확한 표기 질문 ${probes.length}개 1위 일치 — 코사인 ${probeCos}, BM25 ${probeBm}\n`);

const cosOk = rows.filter((r) => !r.probe && r.expect.length && r.expect.includes(r.cosine_top1)).length;
const bmOk = rows.filter((r) => !r.probe && r.bm25_top1_ok).length;
const inDomain = rows.filter((r) => !r.probe && r.expect.length).length;
const anyBm25 = rows.filter((r) => !r.probe && r.via_bm25?.length).length;

console.log("요약");
console.log(`  근거 있는 질문 ${inDomain}개 중 1위가 기대와 일치 — 코사인 ${cosOk}, BM25 ${bmOk}`);
console.log(`  BM25 로 새로 들어온 청크가 있는 질문 : ${anyBm25}/${inDomain + rows.filter((r)=>!r.probe && !r.expect.length).length}`);
console.log(`  모든 질문의 근거 수 : ${[...new Set(rows.filter((r)=>!r.probe).map((r) => r.hits))].sort().join(", ")}개`);
console.log(`  약한 근거로 잡힌 질문 : ${rows.filter((r) => r.weak_evidence).length}/${rows.filter((r)=>!r.probe).length}`);

fs.writeFileSync("data/hybrid-result.json", JSON.stringify(rows, null, 2) + "\n");
console.log("\n기록: data/hybrid-result.json");
