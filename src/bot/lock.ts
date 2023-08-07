var set: Set<string> = new Set()

function lock(key: string) {
  set.add(key)
}

function release(key: string) {
  set.delete(key)
}

function isLock() {
  return set.size !== 0
}

export {
  lock,
  release,
  isLock,
}
