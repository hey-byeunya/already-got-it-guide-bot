// 사용 조건.
//
// 이 문장은 README.md 의 「쓰기 전에 확인할 것」과 **글자 그대로 같아야 한다.**
// 두 곳이 어긋나면 고객은 어느 쪽을 따라야 할지 모른 채 자기 환경을 의심하게 된다.
// 눈으로 맞추지 않고 `node scripts/check_usage_steps.ts` 가 대조한다.

/** 도움말 찾기까지는 아무 준비 없이 된다. 답변을 받으려면 아래가 필요하다. */
export const USAGE_STEPS = [
  "질문을 입력하시면 관련 도움말을 찾아 드립니다. 여기까지는 아무 준비도 필요하지 않습니다.",
  "상담 답변까지 받으시려면 내 컴퓨터에서 Ollama를 실행하고 `qwen3.5:2b`를 준비합니다.",
  "답변을 처음 받으실 때 검색용 모델을 약 195MB 내려받습니다. 한 번 받으면 다음부터 기다리지 않습니다.",
] as const;

/**
 * 배포 주소(HTTPS)에서 로컬 Ollama 에 닿지 못하는 문제.
 *
 * `OLLAMA_ORIGINS` 는 제대로 먹는다 — 프리플라이트에 `Access-Control-Allow-Origin` 이
 * 정확히 돌아온다. 그런데 HTTPS 페이지가 `http://localhost` 로 보내는 요청은 CORS 와
 * **별개의 관문**(사설망 접근)을 하나 더 지나야 하고, Ollama 는 그 헤더
 * (`Access-Control-Allow-Private-Network`)를 보내지 않는다.
 *
 * 이 문장도 README 와 글자 그대로 같아야 한다.
 */
export const HTTPS_NOTE =
  "배포 주소는 HTTPS이고 Ollama는 HTTP라, 브라우저가 그 요청을 막습니다. `OLLAMA_ORIGINS`를 설정해도 막힙니다. 답변까지 받으시려면 저장소를 내려받아 `npm run dev`로 직접 띄우세요.";

/** 첫 화면에 놓는 자주 묻는 질문. 도움말에 근거가 있는 것만 고른다. */
export const FAQ_BUTTONS = [
  "위시에 담아둔 걸 샀는데 어떻게 있템으로 옮겨요?",
  "카테고리는 꼭 넣어야 하나요?",
  "다 쓴 물건은 어디서 볼 수 있어요?",
  "D-day 배지 색깔이 무슨 뜻이에요?",
  "비밀번호를 잊었는데 어떻게 재설정해요?",
  "유통기한 알림이 오나요?",
] as const;
