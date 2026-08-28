// 루브릭 실험 — 고정 질문 Q1~Q9 를 한 세팅으로 여러 번 돌려 기록한다.
//
//   node scripts/run_rubric.ts --setting baseline --runs 3
//   node scripts/run_rubric.ts --setting temp0   --runs 3
//   node scripts/run_rubric.ts --setting idplain --runs 3
//
// 한 번에 변수 하나만 바꾼다. 질문 세트와 순서는 세팅과 무관하게 항상 같다.
// F 에서 같은 질문의 판정이 회차마다 흔들리는 것을 봤으므로, 세팅마다
// 여러 번 돌려 **흔들림의 폭**을 함께 잰다. 그보다 작은 차이는 변화로 읽지 않는다.

import fs from "node:fs";
import { buildBm25Index, hybridSearch, type Chunk } from "../app/src/lib/search.ts";
import { buildPrompt, type IdFormat } from "../app/src/lib/prompt.ts";
import { streamChat } from "../app/src/lib/ollama.ts";
import { judge } from "../app/src/lib/judge.ts";

type Setting = { name: string; 바꾼것: string; temperature?: number; idFormat: IdFormat };
const SETTINGS: Record<string, Setting> = {
  baseline: { name: "baseline", 바꾼것: "— (기준 행)", idFormat: "section" },
  temp0:    { name: "temp0",    바꾼것: "생성 온도를 0 으로 고정 (기준은 지정하지 않음)", temperature: 0, idFormat: "section" },
  idplain:  { name: "idplain",  바꾼것: "자료 머리표를 [AG-004 | 섹션] → [AG-004] 로 (섹션은 다음 줄)", idFormat: "plain" },
};

const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
const setting = SETTINGS[arg("--setting") ?? "baseline"];
if (!setting) { console.error(`모르는 세팅. 가능: ${Object.keys(SETTINGS).join(", ")}`); process.exit(1); }
const RUNS = Number(arg("--runs")) || 3;

const chunks: Chunk[] = JSON.parse(fs.readFileSync("app/public/already-got-it-docs.json", "utf8"));
const qvecs = new Map<string, number[]>(
  JSON.parse(fs.readFileSync(".sources/query-vectors.json", "utf8")).map((r: any) => [r.query, r.vector]),
);
const QUESTIONS: { id: string; kind: string; q: string; note: string }[] =
  JSON.parse(fs.readFileSync("data/rubric-queries.json", "utf8"));
const index = buildBm25Index(chunks);

console.log(`세팅 ${setting.name} — 바꾼 것: ${setting.바꾼것}`);
console.log(`질문 ${QUESTIONS.length}개 × ${RUNS}회 = ${QUESTIONS.length * RUNS}번\n`);

const rows: any[] = [];
for (let run = 1; run <= RUNS; run++) {
  for (const Q of QUESTIONS) {
    const qv = qvecs.get(Q.q);
    if (!qv) { console.error(`질문 벡터 없음: ${Q.q}`); process.exit(1); }

    const res = hybridSearch(chunks, index, qv, Q.q);
    const prompt = buildPrompt(res.hits, Q.q, res.weakEvidence, undefined, { idFormat: setting.idFormat });

    let answer = "";
    const ctrl = new AbortController();
    for await (const piece of streamChat(prompt, ctrl.signal, { temperature: setting.temperature }))
      answer += piece;

    const outcome = await judge(Q.q, res.hits, answer, ctrl.signal, { idFormat: setting.idFormat });

    // cited 는 모델 없이 확인할 수 있는 유일한 판정 항목이다.
    const citedActual = /\[AG-\d+/.test(answer);
    const v = outcome.ok ? outcome.verdict : null;

    rows.push({
      setting: setting.name, run, id: Q.id, kind: Q.kind, question: Q.q,
      hits: res.hits.length, topScore: +res.topScore.toFixed(4), weakEvidence: res.weakEvidence,
      answer, answerLen: answer.length, idMarks: (answer.match(/\[AG-\d+/g) ?? []).length, citedActual,
      verdict: v, citedAgrees: v ? v.cited === citedActual : null,
      judgeError: outcome.ok ? null : outcome.reason,
    });

    const badge = v
      ? `g=${v.grounded ? "T" : "F"} h=${v.noHalluc ? "T" : "F"} c=${v.cited ? "T" : "F"} r=${v.refusal ? "T" : "F"} ${String(v.score).padStart(3)}점`
      : `judgeError`;
    const mark = v ? (v.cited === citedActual ? " " : "⚠") : " ";
    console.log(`  ${run}회 ${Q.id} ${Q.kind.padEnd(3)} ${badge} ${mark} 답 ${String(answer.length).padStart(4)}자 [AG-…] ${Q.id === "" ? "" : (answer.match(/\[AG-\d+/g) ?? []).length}회`);
  }
}

fs.mkdirSync("data/rubric", { recursive: true });
fs.writeFileSync(`data/rubric/${setting.name}.json`, JSON.stringify(rows, null, 2) + "\n");
console.log(`\n기록: data/rubric/${setting.name}.json`);
