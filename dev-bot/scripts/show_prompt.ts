// 실제로 모델에게 가는 프롬프트를 그대로 찍는다.
//
//   node scripts/show_prompt.ts "위시에 담아둔 걸 샀는데 어떻게 있템으로 옮겨요?"
//
// 답이 이상할 때 모델을 탓하기 전에 무엇을 보냈는지 먼저 본다.

import fs from "node:fs";
import { buildBm25Index, hybridSearch, type Chunk } from "../app/src/lib/search.ts";
import { buildPrompt } from "../app/src/lib/prompt.ts";

const q = process.argv[2] ?? "위시에 담아둔 걸 샀는데 어떻게 있템으로 옮겨요?";
const chunks: Chunk[] = JSON.parse(fs.readFileSync("app/public/already-got-it-docs.json", "utf8"));
const qvecs = new Map<string, number[]>(
  JSON.parse(fs.readFileSync(".sources/query-vectors.json", "utf8")).map((r: any) => [r.query, r.vector]),
);
const qv = qvecs.get(q);
if (!qv) {
  console.error(`질문 벡터가 없습니다: ${q}`);
  console.error("data/spotcheck-queries.json 에 넣고 --queries 로 만든 질문만 됩니다.");
  process.exit(1);
}

const res = hybridSearch(chunks, buildBm25Index(chunks), qv, q);
const prompt = buildPrompt(res.hits, q, res.weakEvidence);

console.log(`근거 ${res.hits.length}개 · 최고 유사도 ${res.topScore.toFixed(3)} · 약한 근거 ${res.weakEvidence ? "예" : "아니오"}`);
console.log(`프롬프트 ${prompt.length}자\n`);
console.log("─".repeat(100));
console.log(prompt);
console.log("─".repeat(100));
