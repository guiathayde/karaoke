import { StagePage } from './stage/StagePage'
import { JoinPage } from './join/JoinPage'

export function App() {
  const path = location.pathname.replace(/\/+$/, '')
  if (path === '/stage') return <StagePage />
  if (path === '/join' || path === '') return <JoinPage />
  return (
    <main className="center">
      <h1>Karaokê</h1>
      <p>
        <a href="/stage">Palco (TV)</a> · <a href="/join">Entrar (celular)</a>
      </p>
    </main>
  )
}
