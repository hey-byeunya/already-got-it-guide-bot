// 루브릭 세팅들을 나란히 놓고 비교한다.
//
//   node scripts/summarize_rubric.ts baseline temp0 idplain
//
// 회차 간 흔들림을 함께 보여 준다. 흔들림보다 작은 차이는 변화로 읽지 않는다.

import fs from "node:fs";

const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!names.length) { console.error("세팅 이름을 하나 이상 준다"); process.exit(1); }

type Row = any;
const sets = new Map<string, Row[]>();
for (const n of names) {
  const f = `data/rubric/${n}.json`;
  if (!fs.existsSync(f)) { console.error(`없음: ${f}`); process.exit(1); }
  sets.set(n, JSON.parse(fs.readFileSync(f, "utf8")));
}

/** 지표 — 각 값은 회차별로 따로 재고, 평균과 범위를 함께 낸다. */
function metrics(rows: Row[]) {
  const runs = [...new Set(rows.map((r) => r.run))];
  const per = runs.map((run) => {
    const R = rows.filter((r) => r.run === run);
    const grounded = R.filter((r) => r.kind !== "무근거");
    const oob = R.filter((r) => r.kind === "무근거");
    const judged = R.filter((r) => r.verdict);
    return {
      run,
      cited: grounded.filter((r) => r.verdict?.cited).length,          // 지표1 / 6
      refusal: oob.filter((r) => r.verdict?.refusal).length,           // 지표2 / 3
      groundedRate: grounded.length
        ? grounded.filter((r) => r.verdict?.grounded).length / grounded.length : 0, // 지표3
      citedAgree: judged.length ? judged.filter((r) => r.citedAgrees).length / judged.length : 0, // 지표4
      avgLen: Math.round(R.reduce((s, r) => s + r.answerLen, 0) / R.length),        // 지표5
      judgeErrors: R.filter((r) => r.judgeError).length,
    };
  });
  const agg = (k: keyof (typeof per)[0]) => {
    const v = per.map((p) => Number(p[k]));
    return { avg: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
  };
  return { per, cited: agg("cited"), refusal: agg("refusal"), groundedRate: agg("groundedRate"),
           citedAgree: agg("citedAgree"), avgLen: agg("avgLen"), judgeErrors: agg("judgeErrors") };
}

const fmt = (a: { avg: number; min: number; max: number }, digits = 2) =>
  `${a.avg.toFixed(digits)} (${a.min === a.max ? "흔들림 없음" : `${a.min.toFixed(digits)}~${a.max.toFixed(digits)}`})`;

console.log(`${"지표".padEnd(28)} ${names.map((n) => n.padEnd(24)).join("")}`);
console.log("-".repeat(28 + names.length * 24));
const M = new Map(names.map((n) => [n, metrics(sets.get(n)!)]));
const LINES: [string, (m: any) => string][] = [
  ["1 출처 인용 (6문항 중)", (m) => fmt(m.cited, 1)],
  ["2 범위 밖 거부 (3문항 중)", (m) => fmt(m.refusal, 1)],
  ["3 근거성 비율", (m) => fmt(m.groundedRate)],
  ["4 판정 cited 일치율", (m) => fmt(m.citedAgree)],
  ["5 답변 평균 길이(자)", (m) => fmt(m.avgLen, 0)],
  ["  judgeError 수", (m) => fmt(m.judgeErrors, 1)],
];
for (const [label, f] of LINES) {
  console.log(`${label.padEnd(28)} ${names.map((n) => f(M.get(n)).padEnd(24)).join("")}`);
}

// 기준 행과의 차이를 흔들림 폭과 견준다
if (names.length > 1) {
  const base = M.get(names[0])!;
  console.log(`\n기준 행(${names[0]})과의 차이 — 흔들림보다 큰가\n`);
  for (const n of names.slice(1)) {
    const m = M.get(n)!;
    console.log(`  ${n}`);
    for (const [label, key] of [["출처 인용", "cited"], ["범위 밖 거부", "refusal"],
                                ["근거성 비율", "groundedRate"], ["판정 cited 일치율", "citedAgree"]] as const) {
      const b = (base as any)[key], c = (m as any)[key];
      const diff = c.avg - b.avg;
      const noise = Math.max(b.max - b.min, c.max - c.min);   // 두 세팅의 흔들림 폭 중 큰 쪽
      const verdict = Math.abs(diff) > noise ? "← 흔들림보다 크다" : "흔들림 안 (변화로 읽지 않는다)";
      console.log(`    ${label.padEnd(18)} ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}  흔들림 폭 ${noise.toFixed(2)}  ${verdict}`);
    }
    console.log();
  }
}
