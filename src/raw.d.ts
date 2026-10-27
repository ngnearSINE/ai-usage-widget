// Vite의 '?raw' 가져오기(파일 내용을 문자열로)
declare module '*.md?raw' {
  const content: string
  export default content
}
