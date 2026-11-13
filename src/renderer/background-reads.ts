const waiting: (() => void)[] = []
let active = 0

/** 辅助统计与图片共享两个读取名额，为打开作品和保存保留服务队列容量。 */
export function queueBackgroundRead<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active += 1
      void Promise.resolve().then(operation).then(resolve, reject).finally(() => {
        active -= 1
        waiting.shift()?.()
      })
    }
    if (active < 2) run()
    else waiting.push(run)
  })
}
