// 부정문 인용 실험 — 원문의 "~하지 않는다" 가 답에서 뒤집히는가.
//
//   node scripts/run_negation.ts --setting base  --runs 3
//   node scripts/run_negation.ts --setting quote --runs 3
//
// 왜 루브릭으로 재지 않는가: 루브릭의 판정은 이 실패를 못 잡는다.
// OBS-001 에서 부정이 두 곳 뒤집힌 답에 85점을 줬다. 그래서 이 실험은
// **판정을 쓰지 않고** 두 가지를 직접 잰다.
//
//   1. 뒤집힘  — 답에 뒤집힘 표지가 나오는가 (문항마다 미리 정해 둔 낱말)
//   2. 원문 인용 — 답이 근거 원문의 연속 20자 이상을 그대로 담는가
//
// 1번은 문항별 표지를 사람이 미리 정했다. 결과를 보고 표지를 고치지 않는다.

import fs from "node:fs";
import { buildBm25Index, hybridSearch, type Chunk } from "../app/src/lib/search.ts";
import { buildPrompt } from "../app/src/lib/prompt.ts";
import { streamChat } from "../app/src/lib/ollama.ts";

type Q = { id: string; q: string; 근거: string; 원문: string; 맞는_답?: string; 뒤집힘_표지: string[] };

const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
const setting = arg("--setting") ?? "base";
const quoteVerbatim = setting === "quote";
const RUNS = Number(arg("--runs")) || 3;

const chunks: Chunk[] = JSON.parse(fs.readFileSync("app/public/already-got-it-docs.json", "utf8"));
const byId = new Map(chunks.map((c) => [c.id, c]));
const qvecs = new Map<string, number[]>(
  JSON.parse(fs.readFileSync(".sources/qv-neg.json", "utf8")).map((r: any) => [r.query, r.vector]),
);
const QS: Q[] = JSON.parse(fs.readFileSync("data/negation-queries.json", "utf8"));
const index = buildBm25Index(chunks);

/** 답이 원문의 연속 n자 이상을 그대로 담는가 — 가장 긴 공통 조각의 길이 */
function longestVerbatim(answer: string, source: string): number {
  const a = answer.replace(/\s+/g, " ");
  const s = source.replace(/\s+/g, " ");
  let best = 0;
  for (let i = 0; i < s.length; i++) {
    for (let len = best + 1; i + len <= s.length; len++) {
      if (a.includes(s.slice(i, i + len))) best = len;
      else break;
    }
  }
  return best;
}

console.log(`세팅 ${setting}${quoteVerbatim ? " — 부정문은 원문 그대로 옮겨 적으라고 요구" : " — 기준 행 (요구 없음)"}`);
console.log(`질문 ${QS.length}개 × ${RUNS}회\n`);
console.log(`${"".padEnd(4)} ${"문항".padEnd(4)} ${"뒤집힘".padEnd(8)} ${"원문 인용".padStart(8)}  답 길이  걸린 표지`);
console.log("-".repeat(92));

const rows: any[] = [];
for (let run = 1; run <= RUNS; run++) {
  for (const Q of QS) {
    const qv = qvecs.get(Q.q);
    if (!qv) { console.error(`질문 벡터 없음: ${Q.q}`); process.exit(1); }

    const res = hybridSearch(chunks, index, qv, Q.q);
    const prompt = buildPrompt(res.hits, Q.q, res.weakEvidence, undefined, { quoteVerbatim });

    let answer = "";
    const ctrl = new AbortController();
    for await (const piece of streamChat(prompt, ctrl.signal)) answer += piece;

    const flat = answer.replace(/\s+/g, " ");
    const 걸린표지 = Q.뒤집힘_표지.filter((m) => flat.includes(m));
    const 뒤집힘 = 걸린표지.length > 0;
    const 인용길이 = longestVerbatim(answer, Q.원문);
    const 인용함 = 인용길이 >= 20;
    const 근거들어옴 = res.hits.some((h) => h.chunk.id === Q.근거);

    console.log(
      `${String(run).padEnd(4)} ${Q.id.padEnd(4)} ${(뒤집힘 ? "⚠️ 뒤집힘" : "정상").padEnd(8)} ${(인용함 ? `${인용길이}자` : "없음").padStart(8)}  ${String(answer.length).padStart(5)}자  ${걸린표지.join(", ")}`,
    );

    rows.push({ setting, run, id: Q.id, question: Q.q, 근거: Q.근거, 근거들어옴,
                answer, answerLen: answer.length, 뒤집힘, 걸린표지, 인용길이, 인용함 });
  }
}

console.log("-".repeat(92));
const flips = rows.filter((r) => r.뒤집힘).length;
const quotes = rows.filter((r) => r.인용함).length;
console.log(`뒤집힘   : ${flips}/${rows.length}`);
console.log(`원문 인용 : ${quotes}/${rows.length} (연속 20자 이상)`);
console.log(`근거 청크가 검색에 들어온 비율 : ${rows.filter((r) => r.근거들어옴).length}/${rows.length}`);

fs.mkdirSync("data/negation", { recursive: true });
const dest = `data/negation/${setting}.json`;

// 이미 있는 기록이 더 많은 회차면 덮어쓰지 않는다.
// gate.json 과 base.json 을 각각 한 번씩 스모크 테스트로 덮어쓴 적이 있다.
// 측정 기록은 다시 만들 수 없다 — 같은 세팅으로 다시 돌려도 답이 달라진다.
if (fs.existsSync(dest) && !process.argv.includes("--force")) {
  const old = JSON.parse(fs.readFileSync(dest, "utf8"));
  if (old.length > rows.length) {
    console.error(`\n⚠️ ${dest} 에 이미 ${old.length}건이 있다. 지금 결과는 ${rows.length}건이라 덮어쓰지 않는다.`);
    console.error(`   덮어쓰려면 --force, 따로 두려면 --setting 이름을 바꾼다.`);
    process.exit(1);
  }
}
fs.writeFileSync(dest, JSON.stringify(rows, null, 2) + "\n");
console.log(`\n기록: ${dest}`);
