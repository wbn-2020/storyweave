import type { AiConnection, AiMessage } from '../../contracts/ai'

/** 所有文本入口使用同一请求格式，避免开书成功而正文生成因参数差异失败。 */
export function chatCompletionBody(connection: AiConnection, messages: readonly AiMessage[]) {
  return { model: connection.model, messages, stream: true, stream_options: { include_usage: true }, max_completion_tokens: connection.maxOutputTokens, n: 1 }
}

export function modelHttpError(status: number): string {
  const hint = status === 401 || status === 403 ? '请核对本次会话密钥、模型权限和接口地址。'
    : status === 429 ? '请核对额度或请求频率，稍后手动重试。'
      : status === 400 || status === 422 ? '接口拒绝请求参数，请核对模型、上下文预算及 Chat Completions 参数兼容性。'
        : status === 404 ? '请核对接口路径和模型名称。'
          : status >= 500 ? '服务方暂时异常，请保留当前输出并稍后手动重试。' : '请核对接口状态与配置。'
  return `模型接口返回 HTTP ${status}。${hint}未读取远端错误正文，也未自动重发。`
}
