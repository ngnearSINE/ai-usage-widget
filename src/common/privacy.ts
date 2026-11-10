/**
 * 화면 공유·녹화용 개인정보 가리기. 설정 '이메일 가리기'를 켜면 카드 이름·설명·알림의 이메일과 계정 표식을 줄여 보인다.
 * - 이메일: 'superrogin@gmail.com' → 's···@g···'
 * - 자동으로 붙인 계정 이름의 마지막 칸(이메일 앞부분·조직 이름): 'Claude 개인 · superrogin' → 'Claude 개인 · s···'
 * 사용자가 직접 바꾼 이름(가운뎃점 없이)은 그대로 둔다. 저장된 값은 바꾸지 않고 보여 줄 때만 가린다.
 */
const EMAIL = /([\w.+-])[\w.+-]*@([\w-])[\w.-]*\.[a-z]{2,}/gi
const LAST_ID = /^(.+ · )([\w.+-]{3,})$/

export function maskText(text: string, on: boolean): string {
  if (!on || !text) return text
  const out = text.replace(EMAIL, '$1···@$2···')
  // 줄마다(설명 창은 여러 줄) 끝 칸이 아이디처럼 생겼으면 줄인다.
  return out.split('\n').map(line => line.replace(LAST_ID, (_, head: string, id: string) => `${head}${id[0]}···`)).join('\n')
}
