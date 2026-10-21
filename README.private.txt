LV-AutoPic (lv_autopic) — 개인용 Lumiverse(Spindle) 확장. 공개·push·업로드 금지.

src/core.mjs     태그 파싱·이름 매칭·프롬프트 조립·마커 생성·설정/등록부 정규화 (백엔드/프론트 공용, 순수 함수만)
src/backend.mjs  GENERATION_ENDED/MESSAGE_EDITED 처리, imageGen.generate, chat.updateMessage,
                 characters.update(등록부), storage(설정), variables.chat(채팅별 자동생성 on/off),
                 registerInterceptor(F1 지시 끼워넣기 + 히스토리 그림 자리 요약)
src/frontend.mjs 입력창 버튼 'LV-AutoPic 설정' + 호스트 모달(설정/등록부/자동생성 토글/이 채팅 그림 목록)
scripts/build.mjs  src -> dist (의존성 없음). 빌드: node scripts/build.mjs
test/            node --test test/*.test.mjs — 2026-10-21 기준 69개 전부 통과

문서
docs/DESIGN.md     설계안(사용자 승인본)
docs/API-NOTES.md  이 확장이 의존하는 루미버스 API — 근거 파일:줄, VERIFIED/INFERRED/UNVERIFIED 표기

설치는 설치방법.txt 참고. 클린룸: SillyGgu/AutoPic 코드는 열람·참고하지 않았음(동작 설명만 docs/DESIGN.md에서 받음).

알려진 한계 (docs/API-NOTES.md 참고)
- 메시지 속 그림 렌더링 문법(마크다운 이미지)이 루미버스 화면에서 실제로 그림으로 보이는지 미시험.
  실제 서버에서 <pic prompt="..."> 한 번 써 보고 확인 필요 (DESIGN.md §6 "만들기 전 첫 작업"에 해당).
- MESSAGE_EDITED 이벤트의 payload 모양을 추정함(실제 수정으로 확인 안 함). 어긋나면 조용히 아무 일도
  안 함(안전하게 실패) — 재처리가 안 보이면 이 부분부터 의심.
- registerMessageAction(말풍선 버튼)은 존재를 확인했지만 이번 MVP엔 안 씀 — 패널의 "다시 그리기" 목록만.
