// 실패한 답을 원자료에서 뽑아 유형별로 센다.
//
//   node scripts/collect_failures.ts
//
// 분류 자체는 사람이 정한 규칙으로 한다. 자동 분류를 모델에게 맡기면
// 또 하나의 못 믿을 판정이 생긴다 — F 에서 판정이 기계로 확인 가능한
// 항목에서도 틀리는 것을 봤다.

import fs from "node:fs";
import path from "node:path";

type Row = any;
const dir = "data/rubric";
const rows: Row[] = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));

type Kind = { 단계: string; 유형: string; test: (r: Row) => string | null };

const KINDS: Kind[] = [
  { 단계: "판정", 유형: "배지와 점수가 다른 말",
    test: (r) => r.verdict && r.verdict.noHalluc === false && r.verdict.score >= 80
      ? `noHalluc=false 인데 ${r.verdict.score}점` : null },
  { 단계: "판정", 유형: "cited 가 실제와 다름",
    test: (r) => r.verdict && r.citedAgrees === false
      ? `표기 ${r.idMarks}회인데 cited=${r.verdict.cited}` : null },
  { 단계: "판정", 유형: "형식이 깨진 응답",
    test: (r) => r.judgeError ? r.judgeError : null },
  { 단계: "생성", 유형: "출처 표기 없이 답함",
    test: (r) => r.kind !== "무근거" && r.idMarks === 0 && !r.gateRule
      ? `답 ${r.answerLen}자` : null },
  { 단계: "생성", 유형: "근거가 있는데 못 찾음",
    test: (r) => r.kind !== "무근거" && r.verdict && r.verdict.grounded === false && !r.gateRule
      ? `근거 ${r.hits}개 · 최고 ${r.topScore}` : null },
  { 단계: "거부", 유형: "자료 밖인데 답해 버림",
    test: (r) => r.kind === "무근거" && r.verdict && r.verdict.refusal === false && !r.gateRule
      ? `score ${r.verdict.score}` : null },
];

console.log(`원자료 ${rows.length}건 · ${fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length} 세팅\n`);
console.log(`${"단계".padEnd(6)} ${"유형".padEnd(22)} ${"건수".padStart(4)}  대표 사례`);
console.log("-".repeat(100));

const out: any[] = [];
for (const k of KINDS) {
  const hits = rows.map((r) => ({ r, why: k.test(r) })).filter((x) => x.why);
  const 대표 = hits.slice(0, 2).map((x) => `${x.r.setting} ${x.r.run}회 ${x.r.id}`).join(", ");
  console.log(`${k.단계.padEnd(6)} ${k.유형.padEnd(22)} ${String(hits.length).padStart(4)}  ${대표}`);
  out.push({ 단계: k.단계, 유형: k.유형, 건수: hits.length,
             사례: hits.map((x) => ({ setting: x.r.setting, run: x.r.run, id: x.r.id, 왜: x.why })) });
}
console.log("-".repeat(100));

fs.writeFileSync("data/failures.json", JSON.stringify(out, null, 2) + "\n");
console.log("\n기록: data/failures.json — 사례마다 세팅·회차·문항이 있어 원자료로 되짚을 수 있다");
