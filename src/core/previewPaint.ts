// Preview rendering shares the main thread with input and scroll. Stop after
// a few milliseconds so a newly visible group cannot draw all at once.
const waiting: { run: () => void; scroller?: Element }[] = []
const lastScroll = new WeakMap<Element, number>()
let frame = 0
let timer: ReturnType<typeof setTimeout> | undefined

export function markPreviewScroll(scroller: Element) {
  lastScroll.set(scroller, performance.now())
}

function schedule() {
  clearTimeout(timer)
  timer = undefined
  if (!frame) frame = requestAnimationFrame(flush)
}

function flush() {
  frame = 0
  const deadline = performance.now() + 4
  // A chart can take more than a frame by itself. Draw after the scroll settles.
  let earliest = Infinity
  let remaining = waiting.length
  while (remaining > 0) {
    const job = waiting.shift()!
    const scrolledAt = job.scroller ? lastScroll.get(job.scroller) : undefined
    const ready = (scrolledAt ?? -Infinity) + 100
    if (ready > performance.now()) {
      waiting.push(job)
      earliest = Math.min(earliest, ready)
    } else {
      job.run()
    }
    remaining--
    if (performance.now() >= deadline) break
  }
  if (!waiting.length || frame) return
  if (remaining > 0) schedule()
  else timer = setTimeout(schedule, Math.max(0, earliest - performance.now()))
}

export function paintPreview<T>(paint: () => T, target?: HTMLElement): Promise<T> {
  return new Promise((resolve, reject) => {
    waiting.push({
      scroller: target?.closest('.editor-scroll') ?? undefined,
      run() {
        try { resolve(paint()) } catch (error) { reject(error) }
      },
    })
    schedule()
  })
}
