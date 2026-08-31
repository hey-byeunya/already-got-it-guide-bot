// 사람이 누른 것과 자동 판정이 갈린 자리를 센다.
//
//   node scripts/check_feedback.ts                 # data/feedback/*.json 전부
//   node scripts/check_feedback.ts 파일.json ...   # 파일을 직접 지정
//
// 왜 이걸 세나.
// 판정은 답을 만든 것과 같은 qwen3.5:2b 가 한다. 독립 심사가 아니다.
// G 에서 판정의 cited 일치율이 0.74 로 나왔고, 배지와 점수가 다른 말을 한 것이
// 108건 중 55건이었다. **판정이 얼마나 못 미더운지를 재려면 판정 밖의 기준이 있어야 한다.**
// 사람이 누른 「도움됨 / 아니요」가 그 기준이다.
//
// 이 파일이 무엇이 아닌지도 분명히 해 둔다.
// **사용자 의견 접수함이 아니다.** 이 앱에는 서버가 없어서(PRD 3절 비목표)
// 남이 누른 값은 개발자에게 오지 않는다. 여기서 세는 것은 이 화면을 직접
// 띄워 본 사람이 파일로 꺼내 data/feedback/ 에 넣은 것뿐이다.
//
// 그리고 갈렸다고 해서 판정이 틀렸다는 증명은 아니다. 사람도 틀린다.
// 갈린 자리는 **원문과 대조해 볼 후보**이지 결론이 아니다.

import fs from "node:fs";
import path from "node:path";

// 어느 폴더에서 돌려도 같게 동작하게, 저장소 뿌리를 이 파일 위치에서 잡는다.
// (형제 스크립트들은 저장소 뿌리에서 도는 것을 전제하지만, 그 전제가 깨지면
//  cwd 를 못 읽어 node 가 시작조차 못 하는 자리를 봤다.)
const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "data/feedback");
const OUT = path.join(ROOT, "data/feedback-result.json");
const rel = (p: string) => path.relative(ROOT, p) || p;

type Verdict = {
  grounded: boolean;
  noHalluc: boolean;
  cited: boolean;
  refusal: boolean;
  score: number;
  rawScore?: number;
  comment?: string;
};
type Outcome = { ok: true; verdict: Verdict } | { ok: false; reason: string };

type Record = {
  turnId: string;
  at: string;
  where: string;
  model: string;
  question: string;
  feedback: "up" | "down";
  agreesWithJudge: boolean | null;
  hits: number;
  topScore: number;
  weakEvidence: boolean;
  chips: { id: string; section: string; method: string; score: number }[];
  answer: string;
  answerLen: number;
  idMarks: number;
  verdict: Outcome | null;
};

// ── 읽을 파일 고르기 ────────────────────────────────────────────
const given = process.argv.slice(2);
const files = given.length
  ? given
  : fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(DIR, f))
    : [];

if (files.length === 0) {
  console.log(`${rel(DIR)} 에 기록이 없습니다.`);
  console.log("");
  console.log("화면에서 답을 받고 「도움됨 / 아니요」를 누른 뒤,");
  console.log("「피드백 내려받기」로 받은 파일을 이 폴더에 넣고 다시 돌리세요.");
  console.log("");
  console.log("기록이 없는 것은 실패가 아닙니다 — 아직 아무도 누르지 않았다는 뜻입니다.");
  process.exit(0);
}

// ── 모으기. 같은 답(turnId)이 여러 파일에 있으면 마지막 것만 남긴다 ──
const byTurn = new Map<string, Record>();
let 읽은줄 = 0;
for (const f of files) {
  const rows = JSON.parse(fs.readFileSync(f, "utf-8")) as Record[];
  읽은줄 += rows.length;
  for (const r of rows) byTurn.set(r.turnId, r);
}
// 읽은 순서를 그대로 쓴다. at 은 "2026년 8월 31일 오후 12:11" 같은 사람이 읽는
// 문자열이라 사전순이 시간순이 아니다("10월" 이 "8월" 보다 앞선다).
// 파일 이름이 feedback-YYYY-MM-DD_HHMM.json 이라 파일 순서가 곧 시간 순서다.
const rows = [...byTurn.values()];
const 겹침 = 읽은줄 - rows.length;

// ── 판정이 이 답을 좋게 봤는가 — 앱의 Feedback 과 같은 기준 ──
function judgeLikes(r: Record): boolean | null {
  return r.verdict?.ok ? r.verdict.verdict.grounded && r.verdict.verdict.noHalluc : null;
}

const 판정있음 = rows.filter((r) => judgeLikes(r) !== null);
const 갈림 = 판정있음.filter((r) => (r.feedback === "up") !== judgeLikes(r));

// 갈린 방향을 나눈다. 두 방향은 뜻이 전혀 다르다.
const 판정이깐깐 = 갈림.filter((r) => r.feedback === "up");   // 사람은 됐다는데 판정은 나쁘다
const 판정이놓침 = 갈림.filter((r) => r.feedback === "down"); // 사람은 아니라는데 판정은 좋다

console.log(`파일 ${files.length}개 · 기록 ${rows.length}건${겹침 ? ` (같은 답 ${겹침}건은 마지막 것만 셈)` : ""}`);
console.log(`판정을 받은 것 ${판정있음.length}건 · 판정을 못 받은 것 ${rows.length - 판정있음.length}건`);
console.log("");
console.log(`도움됨 ${rows.filter((r) => r.feedback === "up").length}건 · 아니요 ${rows.filter((r) => r.feedback === "down").length}건`);
console.log("");

const 비율 = 판정있음.length ? (갈림.length / 판정있음.length) : 0;
console.log(`사람과 판정이 갈린 것 : ${갈림.length}/${판정있음.length}건 (${(비율 * 100).toFixed(0)}%)`);
console.log(`  사람은 「도움됨」인데 판정은 나쁘게  : ${판정이깐깐.length}건  ← 판정이 지나치게 깐깐한 후보`);
console.log(`  사람은 「아니요」인데 판정은 좋게    : ${판정이놓침.length}건  ← 판정이 놓친 후보`);

// ── 갈렸을 때 어느 배지가 원인이었나 ────────────────────────────
if (갈림.length) {
  // 「판정이 끈 배지」이므로 판정이 나쁘게 본 쪽에만 해당한다.
  // 판정이 놓친 쪽(사람은 아니요인데 판정은 좋게)은 끈 배지가 없어 여기 안 들어간다.
  const 원인 = { grounded: 0, noHalluc: 0, 둘다: 0 };
  for (const r of 판정이깐깐) {
    if (!r.verdict?.ok) continue;
    const v = r.verdict.verdict;
    if (!v.grounded && !v.noHalluc) 원인.둘다++;
    else if (!v.grounded) 원인.grounded++;
    else if (!v.noHalluc) 원인.noHalluc++;
  }
  console.log("");
  console.log(`사람은 「도움됨」인데 판정이 끈 배지 (${판정이깐깐.length}건)`);
  console.log(`  grounded(근거에 닿음)만 꺼짐   : ${원인.grounded}건`);
  console.log(`  noHalluc(지어낸 것 없음)만 꺼짐 : ${원인.noHalluc}건`);
  console.log(`  둘 다 꺼짐                      : ${원인.둘다}건`);

  console.log("");
  console.log("갈린 건 (원문과 대조할 후보)");
  console.log("-".repeat(104));
  for (const r of 갈림) {
    const v = r.verdict?.ok ? r.verdict.verdict : null;
    const 배지 = v ? `${v.grounded ? "근거O" : "근거X"}·${v.noHalluc ? "지어냄X" : "지어냄O"}·${v.score}점` : "";
    console.log(`${(r.feedback === "up" ? "도움됨" : "아니요").padEnd(4)} ${배지.padEnd(22)} ${r.question}`);
    console.log(`     근거 ${r.hits}개 top=${r.topScore.toFixed(3)} ${r.chips[0] ? `1위 ${r.chips[0].id}(${r.chips[0].method})` : ""} · 답 ${r.answerLen}자 · [AG-] 표기 ${r.idMarks}개`);
  }
  console.log("-".repeat(104));
}

// ── 표본이 작을 때는 비율을 읽지 말라고 적는다 ──────────────────
console.log("");
if (판정있음.length < 10) {
  console.log(`⚠️ 기록이 ${판정있음.length}건뿐입니다. 위 비율은 아직 값으로 읽을 것이 못 됩니다.`);
  console.log("   지금 쓸 수 있는 것은 비율이 아니라 **갈린 건 하나하나**입니다.");
} else {
  console.log("⚠️ 갈렸다고 판정이 틀린 것은 아닙니다. 사람도 틀립니다.");
  console.log("   갈린 자리는 원문과 대조해 볼 후보이지 결론이 아닙니다.");
}
console.log("   비교 기준: G 에서 판정의 cited 일치율 0.74, 배지와 점수가 다른 말 108건 중 55건.");

fs.writeFileSync(OUT, JSON.stringify({
  파일: files.map(rel),
  읽은줄,
  중복제외: rows.length,
  판정있음: 판정있음.length,
  갈림: 갈림.length,
  판정이깐깐: 판정이깐깐.length,
  판정이놓침: 판정이놓침.length,
  갈린건: 갈림.map((r) => ({
    at: r.at, question: r.question, feedback: r.feedback,
    verdict: r.verdict?.ok ? r.verdict.verdict : null,
    hits: r.hits, topScore: r.topScore, chips: r.chips, answerLen: r.answerLen,
    idMarks: r.idMarks, answer: r.answer,
  })),
}, null, 2) + "\n");
console.log(`\n기록: ${rel(OUT)}`);
