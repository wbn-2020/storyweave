import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './tokens.css'

class InterfaceBoundary extends Component<{ children: ReactNode }, { failed: boolean; busy: boolean; notice: string }> {
  state = { failed: false, busy: false, notice: '' }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // 不把异常对象或组件数据输出到日志，防止误带当前作品内容。
    window.storyweave?.reportInterfaceFault?.()
  }

  async recover(action: 'reload' | 'reveal') {
    if (this.state.busy) return
    this.setState({ busy: true, notice: '' })
    try {
      const result = await window.storyweave?.recoverInterface?.(action)
      this.setState({ notice: result?.ok ? '恢复操作已返回。重新打开作品后，请到草稿恢复中核对未保存的检查点。' : result?.error.message ?? '桌面恢复入口不可用，请使用窗口关闭按钮。' })
    } catch { this.setState({ notice: '恢复请求尚未确认，请保留窗口。' }) }
    finally { this.setState({ busy: false }) }
  }

  render() {
    if (this.state.failed) return <main className="fatal-screen" role="alert">
      <h1>界面暂时无法继续</h1>
      <p>请保留当前窗口。已确认保存的正文仍在作品库中，未确认的输入可能尚未落盘。</p>
      <p>为避免丢失未保存内容，程序不会自动刷新。</p>
      <button type="button" disabled={this.state.busy} onClick={() => void this.recover('reveal')}>打开作品库与恢复文件位置</button>
      <button type="button" disabled={this.state.busy} onClick={() => void this.recover('reload')}>查看重新打开界面的确认选项</button>
      {this.state.notice && <p role="status">{this.state.notice}</p>}
    </main>
    return this.props.children
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')

createRoot(root).render(<InterfaceBoundary><App api={window.storyweave} /></InterfaceBoundary>)
