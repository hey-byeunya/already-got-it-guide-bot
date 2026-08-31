// 화면 문구와 README 가 어긋나지 않는지 눈이 아니라 프로그램으로 확인한다.
//
// 앱 소개 화면의 사용 조건과 README.md 의 「쓰기 전에 확인할 것」이
// 글자 그대로 같은지 대조한다. 어긋나면 0 이 아닌 코드로 끝난다.
//
//   node scripts/check_usage_steps.ts

import fs from "node:fs";
import { HTTPS_NOTE, USAGE_STEPS } from "../app/src/lib/usage-steps.ts";

const readme = fs.readFileSync("README.md", "utf8");
const section = readme.split("## 쓰기 전에 확인할 것")[1]?.split("\n## ")[0] ?? "";
const inReadme = [...section.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1].trim());

console.log(`사용 조건 ${USAGE_STEPS.length}단계 대조 — 앱 소개 화면 vs README.md\n`);
let bad = 0;
const n = Math.max(USAGE_STEPS.length, inReadme.length);
for (let i = 0; i < n; i++) {
  const a = USAGE_STEPS[i], b = inReadme[i];
  const same = a !== undefined && a === b;
  if (!same) bad++;
  console.log(`${i + 1}. ${same ? "같음" : "다름 ⚠️"}`);
  if (!same) {
    console.log(`     앱     : ${a ?? "(없음)"}`);
    console.log(`     README : ${b ?? "(없음)"}`);
  }
}

// HTTPS 주의 문장도 두 곳이 같아야 한다
const noteInReadme = readme.includes(HTTPS_NOTE);
console.log(`\nHTTPS 주의 문장 : ${noteInReadme ? "같음" : "다름 ⚠️"}`);
if (!noteInReadme) {
  bad++;
  console.log(`     앱     : ${HTTPS_NOTE}`);
  console.log(`     README : (같은 문장을 찾지 못함)`);
}

console.log(`\n${bad === 0 ? "모두 같음 — 통과" : `${bad}곳 어긋남 — 실패`}`);
process.exit(bad === 0 ? 0 : 1);
