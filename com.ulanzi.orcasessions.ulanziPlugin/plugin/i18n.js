// 알림·오류 문구만 Ulanzi Studio 언어를 따른다 (한국어면 한국어, 그 밖에는 영어). 키 위 문구는 영어 고정.
// ponytail: ko/en 두 가지뿐. 일본어·중국어는 en.json처럼 설정 화면 번역을 넣을 때 같이 늘린다.
let ko = false;
export const setLanguage = (lang) => { ko = String(lang || '').startsWith('ko'); };
export const t = (en, kr) => (ko ? kr : en);
