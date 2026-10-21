삽화가 (개인용) / LV-Illust (lv_illust) — 개인용 Lumiverse(Spindle) 확장. 공개·push·업로드 금지.

src/core.mjs     태그 파싱·이름 매칭·프롬프트 조립·마커 생성·설정/등록부 정규화 (백엔드/프론트 공용, 순수 함수만)
src/backend.mjs  GENERATION_ENDED/MESSAGE_EDITED 처리, imageGen.generate, chat.updateMessage,
                 characters.update(등록부), storage(설정), variables.chat(채팅별 자동생성 on/off),
                 registerInterceptor(F1 지시 끼워넣기 + 히스토리 그림 자리 요약)
src/frontend.mjs 입력창 버튼 '삽화가 설정' + 호스트 모달(설정/등록부/자동생성 토글/이 채팅 그림 목록)
scripts/build.mjs  src -> dist (의존성 없음). 빌드: node scripts/build.mjs
test/            node --test test/*.test.mjs — 2026-10-21 기준 전부 통과 (리뷰 반영 후 73개)

문서
docs/DESIGN.md     설계안(사용자 승인본)
docs/API-NOTES.md  이 확장이 의존하는 루미버스 API — 근거 파일:줄, VERIFIED/INFERRED/UNVERIFIED 표기

설치는 설치방법.txt 참고. 클린룸: SillyGgu/AutoPic 코드는 열람·참고하지 않았음(동작 설명만 docs/DESIGN.md에서 받음).

알려진 한계 (docs/API-NOTES.md 참고)
- 메시지 속 그림 렌더링 문법(마크다운 이미지)이 루미버스 화면에서 실제로 그림으로 보이는지 미시험.
  실제 서버에서 <pic prompt="..."> 한 번 써 보고 확인 필요 (DESIGN.md §6 "만들기 전 첫 작업"에 해당).
- MESSAGE_EDITED 이벤트의 payload 모양을 추정함(실제 수정으로 확인 안 함) — 단, 신뢰하는 필드는
  chatId/message.id뿐이고 나머지(내용·메타데이터·is_user)는 전부 chat.getMessages로 다시 읽어 확인하므로,
  추정이 틀려도 조용히 아무 일도 안 함(안전하게 실패)이지 다른 확장 메타데이터를 덮어쓰지 않음.
- registerMessageAction(말풍선 버튼)은 존재를 확인했지만 이번 MVP엔 안 씀 — 패널의 "다시 그리기" 목록만.
- 그림 생성 중 같은 메시지를 수정/스와이프하면 생성이 끝날 때 옛 내용 기준으로 덮어쓸 수 있음(경쟁 상태,
  고치지 않음 — 드문 경우라 MVP 범위 밖으로 둠).

검토 이력 메모
- 1차 구현에서 "generation" 권한을 빠뜨려 GENERATION_ENDED 구독 자체가 막히는 치명적 버그가 있었음
  (worker-host.ts의 handleSubscribeEvent가 생성 관련 이벤트를 generation 권한으로 게이트).
  동료 검토에서 발견, spindle.json/설치방법.txt/API-NOTES에 반영 완료.
- 같은 검토에서 형식 오류 마커가 '<'를 이스케이프하지 않아 재처리 시 무한 증식할 수 있는 버그,
  인터셉터가 멀티모달(배열) content를 문자열화해 버리는 버그, imageGen.generate 동시 호출 상한(1)이
  실제로는 강제되지 않던 문제, MESSAGE_EDITED 처리가 검증 안 된 payload 필드를 그대로 신뢰하던 문제를
  함께 발견·수정함 (전부 테스트로 고정).
