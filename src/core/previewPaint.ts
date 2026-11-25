// Preview rendering shares the main thread with input and scroll. Stop after
// a few milliseconds so a newly visible group cannot draw all at once.
const waiting: (() => void)[] = []
let frame = 0

function flush() {
  frame = 0
  const deadline = performance.now() + 4
  do {
    waiting.shift()?.()
  } while (waiting.length && performance.now() < deadline)
  if (waiting.length && !frame) frame = requestAnimationFrame(flush)
}

export function paintPreview<T>(paint: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    waiting.push(() => {
      try { resolve(paint()) } catch (error) { reject(error) }
    })
    if (!frame) frame = requestAnimationFrame(flush)
  })
}
