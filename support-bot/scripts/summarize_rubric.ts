// 세팅들을 나란히 놓고 비교한다.
//
//   node scripts/summarize_rubric.ts S0 S1 S2 S3
//
// 회차 간 흔들림을 함께 보여 준다. **흔들림보다 작은 차이는 변화로 읽지 않는다.**
//
// 지표 옆의 「프로그램」/「판정」 표시가 중요하다. 프로그램이 센 것은 다시 세도
// 같은 값이 나오고, 판정이 센 것은 같은 답에도 회차마다 달라질 수 있다.

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

function metrics(rows: Row[]) {
  const runs = [...new Set(rows.map((r) => r.run))];
  const per = runs.map((run) => {
    const R = rows.filter((r) => r.run === run);
    const 답해야 = R.filter((r) => r.expect.answerable);
    const 범위밖 = R.filter((r) => !r.expect.answerable && !r.expect.gated);
    const 게이트 = R.filter((r) => r.expect.gated);
    const 절차 = R.filter((r) => r.expect.procedural);
    const 판정받음 = R.filter((r) => r.verdict && !r.gated);
    const 근거기대 = R.filter((r) => r.hitRight !== null && r.hitRight !== undefined);
    return {
      run,
      // ── 프로그램이 센 것 ───────────────────────────────
      cited: 답해야.filter((r) => r.citation?.cited).length,                      // /11
      outOfRange: R.reduce((s, r) => s + (r.citation?.outOfRange?.length ?? 0), 0),
      leaked: R.reduce((s, r) => s + (r.citation?.leakedIds?.length ?? 0), 0),
      procedural: 절차.filter((r) => r.citation?.procedural).length,              // /5
      gated: 게이트.filter((r) => r.gated).length,                                // /2
      hitRight: 근거기대.length ? 근거기대.filter((r) => r.hitRight).length / 근거기대.length : 0,
      avgLen: Math.round(R.reduce((s, r) => s + r.answerLen, 0) / R.length),
      // ── 판정 모델이 센 것 ─────────────────────────────
      refusal: 범위밖.filter((r) => r.verdict?.refusal).length,                    // /2
      groundedRate: 답해야.length ? 답해야.filter((r) => r.verdict?.grounded).length / 답해야.length : 0,
      noHallucRate: 판정받음.length ? 판정받음.filter((r) => r.verdict?.noHalluc).length / 판정받음.length : 0,
      judgeErrors: R.filter((r) => r.judgeError).length,
    };
  });
  const agg = (k: string) => {
    const v = per.map((p) => Number((p as any)[k]));
    return { avg: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
  };
  const keys = ["cited", "outOfRange", "leaked", "procedural", "gated", "hitRight",
                "avgLen", "refusal", "groundedRate", "noHallucRate", "judgeErrors"];
  return { per, ...Object.fromEntries(keys.map((k) => [k, agg(k)])) } as any;
}

const fmt = (a: { avg: number; min: number; max: number }, d = 2) =>
  `${a.avg.toFixed(d)} (${a.min === a.max ? "흔들림 없음" : `${a.min.toFixed(d)}~${a.max.toFixed(d)}`})`;

const W = 26;
console.log(`${"지표".padEnd(34)} ${names.map((n) => n.padEnd(W)).join("")}`);
console.log("-".repeat(34 + names.length * W));
const M = new Map(names.map((n) => [n, metrics(sets.get(n)!)]));

const LINES: [string, string, number][] = [
  ["【프로그램】 출처 인용 (11문항 중)", "cited", 1],
  ["【프로그램】 지어낸 번호 (0이어야)", "outOfRange", 1],
  ["【프로그램】 내부 ID 노출 (0이어야)", "leaked", 1],
  ["【프로그램】 절차형 (5문항 중)", "procedural", 1],
  ["【프로그램】 게이트 차단 (2문항 중)", "gated", 1],
  ["【프로그램】 기대 도움말 인용 비율", "hitRight", 2],
  ["【프로그램】 답변 평균 길이(자)", "avgLen", 0],
  ["【판정】 범위 밖 거절 (2문항 중)", "refusal", 1],
  ["【판정】 근거성 비율", "groundedRate", 2],
  ["【판정】 환각 없음 비율", "noHallucRate", 2],
  ["  judgeError 수", "judgeErrors", 1],
];
for (const [label, key, d] of LINES) {
  console.log(`${label.padEnd(34)} ${names.map((n) => fmt(M.get(n)![key], d).padEnd(W)).join("")}`);
}

if (names.length > 1) {
  const base = M.get(names[0])!;
  console.log(`\n기준 행(${names[0]})과의 차이 — 흔들림보다 큰가\n`);
  for (const n of names.slice(1)) {
    const m = M.get(n)!;
    console.log(`  ${n} — ${sets.get(n)![0]?.setting ?? n}`);
    for (const [label, key] of LINES.map(([l, k]) => [l, k] as const)) {
      const b = base[key], c = m[key];
      const diff = c.avg - b.avg;
      const noise = Math.max(b.max - b.min, c.max - c.min);
      const verdict = Math.abs(diff) > noise ? "← 흔들림보다 크다" : "흔들림 안 (변화로 읽지 않는다)";
      console.log(`    ${label.replace(/【.*?】\s*/, "").padEnd(24)} ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}  흔들림 폭 ${noise.toFixed(2)}  ${verdict}`);
    }
    console.log();
  }
}
