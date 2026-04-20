import { Header } from '@/components/layout/header'
import { ThemeProvider } from '@/components/layout/theme-provider'
import Dashboard from '@/pages/dashboard'

export default function App() {
  return (
    <ThemeProvider>
      <div className="app-shell">
        <Header />
        <main className="content">
          <Dashboard />
        </main>
      </div>
    </ThemeProvider>
  )
}
