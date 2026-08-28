// 사용 조건 4단계.
//
// 이 문장은 README.md 의 「쓰기 전에 확인할 것」과 **글자 그대로 같아야 한다.**
// 두 곳이 어긋나면 사용자는 어느 쪽을 따라야 할지 모른 채 자기 환경을 의심하게 된다.
// 눈으로 맞추지 않고 `node scripts/check_usage_steps.ts` 가 대조한다 (수용 기준 6번).

export const USAGE_STEPS = [
  "이 페이지를 열고, 이 챗봇이 다루는 자료와 물을 수 있는 질문을 읽습니다.",
  "내 컴퓨터에서 Ollama를 실행하고 `qwen3.5:2b`를 준비합니다.",
  "첫 방문에는 임베딩 모델 다운로드(약 200MB)가 있습니다. 끝날 때까지 기다립니다.",
  "`OLLAMA_ORIGINS`에 이 페이지 주소를 허용한 뒤, 안내된 질문과 자료 밖 질문을 각각 입력해 봅니다.",
] as const;

/**
 * 배포 주소(HTTPS)에서 로컬 Ollama 에 닿지 못하는 문제.
 *
 * H 단계에서 배포하고 실제로 따라가 보다 찾았다. `OLLAMA_ORIGINS` 는 제대로
 * 먹는다 — 프리플라이트에 `Access-Control-Allow-Origin` 이 정확히 돌아온다.
 * 그런데 HTTPS 페이지가 `http://localhost` 로 보내는 요청은 CORS 와 **별개의
 * 관문**(사설망 접근)을 하나 더 지나야 하고, Ollama 는 그 헤더
 * (`Access-Control-Allow-Private-Network`)를 보내지 않는다.
 *
 * 이 문장도 README 와 글자 그대로 같아야 한다 — check_usage_steps.ts 가 대조한다.
 */
export const HTTPS_NOTE =
  "배포 주소는 HTTPS이고 Ollama는 HTTP라, 브라우저가 그 요청을 막습니다. `OLLAMA_ORIGINS`를 설정해도 막힙니다. 지금 확실히 쓰는 방법은 저장소를 내려받아 `npm run dev`로 직접 띄우는 것입니다.";
