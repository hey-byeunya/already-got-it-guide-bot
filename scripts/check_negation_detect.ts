// 부정문 찾기가 맞는지 확인한다.
//   node scripts/check_negation_detect.ts
//
// 실험 4 에서 뒤집힘이 실제로 난 청크를 잡아내야 하고,
// 부정이 없는 청크를 잘못 잡으면 안 된다(경고가 늘 떠 있으면 아무도 안 본다).

import fs from "node:fs";
import { findNegations } from "../app/src/lib/negation.ts";

const chunks = JSON.parse(fs.readFileSync("data/chunks.json", "utf8"));
// 실험 4 에서 답이 실제로 뒤집힌 근거 청크
const 뒤집힌_적_있음 = new Set(["AG-005", "AG-013"]);

console.log(`${"청크".padEnd(8)} ${"부정문".padStart(4)}  걸린 표현`);
console.log("-".repeat(88));
let 잡음 = 0;
for (const c of chunks) {
  const hits = findNegations(c.text);
  const mark = 뒤집힌_적_있음.has(c.id) ? (hits.length ? " ← 실험 4 에서 뒤집힌 적 있음 ✅" : " ← ⚠️ 뒤집혔는데 못 잡음") : "";
  if (hits.length) 잡음++;
  if (hits.length || mark)
    console.log(`${c.id.padEnd(8)} ${String(hits.length).padStart(4)}  ${[...new Set(hits.flatMap((h) => h.marks))].join(", ")}${mark}`);
}
console.log("-".repeat(88));
console.log(`부정문이 있는 청크: ${잡음}/${chunks.length}`);
console.log(`실험 4 에서 뒤집힌 청크를 모두 잡았는가: ${[...뒤집힌_적_있음].every((id) => findNegations(chunks.find((c: any) => c.id === id).text).length > 0) ? "예" : "아니오"}`);

console.log(`\n경고가 뜨는 비율이 너무 높으면 아무도 보지 않는다. ${잡음}/${chunks.length} = ${Math.round(100 * 잡음 / chunks.length)}%`);

console.log(`\n[AG-005 에서 뽑은 문장]`);
for (const h of findNegations(chunks.find((c: any) => c.id === "AG-005").text))
  console.log(`  · (${h.marks.join(",")}) ${h.sentence.slice(0, 90)}`);
