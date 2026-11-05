import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './tokens.css'

class InterfaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // 不把异常对象或组件数据输出到日志，防止误带当前作品内容。
  }

  render() {
    if (this.state.failed) return <main className="fatal-screen" role="alert">
      <h1>界面暂时无法继续</h1>
      <p>请保留当前窗口。已确认保存的正文仍在作品库中，未确认的输入可能尚未落盘。</p>
      <p>为避免丢失未保存内容，程序不会自动刷新。</p>
    </main>
    return this.props.children
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')

createRoot(root).render(<InterfaceBoundary><App api={window.storyweave} /></InterfaceBoundary>)
