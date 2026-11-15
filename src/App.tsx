import EditorShell from './ui/EditorShell'

const SAMPLE = [
  '# onebox',
  '段落 **粗体**、*斜体*、~~删除线~~、`代码`。',
  '- 甲\n- 乙',
  '> 引用块',
  '```ts\nconst x = 1\n```',
  '---',
].join('\n\n')

export default function App() {
  return (
    <main class="app">
      <EditorShell markdown={SAMPLE} onReady={() => {}} onUpdate={() => {}} />
    </main>
  )
}
