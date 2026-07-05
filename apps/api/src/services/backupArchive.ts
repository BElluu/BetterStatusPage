import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const MAGIC = Buffer.from('BSPBKP01')
const HASH_SIZE = 32

export interface ArchiveEntry { name: string; source: string }

function safeName(name: string): string {
  const normalized = name.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..') {
    throw new Error(`Unsafe archive path: ${name}`)
  }
  return normalized
}

function sha256(file: string): Buffer {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let count = 0
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
  } finally { fs.closeSync(fd) }
  return hash.digest()
}

function copyBytes(input: number, output: number, size: number, hash?: crypto.Hash): void {
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let remaining = size
  while (remaining > 0) {
    const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, remaining), null)
    if (count === 0) throw new Error('Unexpected end of backup archive')
    const chunk = buffer.subarray(0, count)
    if (hash) hash.update(chunk)
    fs.writeSync(output, chunk)
    remaining -= count
  }
}

export function createArchive(output: string, entries: ArchiveEntry[]): void {
  const fd = fs.openSync(output, 'wx', 0o600)
  try {
    fs.writeSync(fd, MAGIC)
    for (const entry of entries) {
      const name = Buffer.from(safeName(entry.name), 'utf8')
      const stat = fs.statSync(entry.source)
      if (!stat.isFile()) throw new Error(`Archive source is not a file: ${entry.source}`)
      const header = Buffer.alloc(4 + 8 + HASH_SIZE)
      header.writeUInt32BE(name.length, 0)
      header.writeBigUInt64BE(BigInt(stat.size), 4)
      sha256(entry.source).copy(header, 12)
      fs.writeSync(fd, header)
      fs.writeSync(fd, name)
      const input = fs.openSync(entry.source, 'r')
      try { copyBytes(input, fd, stat.size) } finally { fs.closeSync(input) }
    }
    fs.writeSync(fd, Buffer.alloc(4))
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function readExact(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(fd, buffer, offset, size - offset, null)
    if (!count) throw new Error('Truncated backup archive')
    offset += count
  }
  return buffer
}

export function extractArchive(input: string, destination: string): string[] {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  const root = path.resolve(destination)
  const extracted: string[] = []
  const fd = fs.openSync(input, 'r')
  try {
    if (!readExact(fd, MAGIC.length).equals(MAGIC)) throw new Error('Unsupported backup format')
    for (let index = 0; index < 10000; index++) {
      const nameLength = readExact(fd, 4).readUInt32BE(0)
      if (nameLength === 0) return extracted
      if (nameLength > 4096) throw new Error('Invalid archive entry name')
      const metadata = readExact(fd, 8 + HASH_SIZE)
      const sizeBig = metadata.readBigUInt64BE(0)
      if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Archive entry is too large')
      const expectedHash = metadata.subarray(8)
      const name = safeName(readExact(fd, nameLength).toString('utf8'))
      const target = path.resolve(root, ...name.split('/'))
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Archive path escapes destination')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const output = fs.openSync(target, 'wx', 0o600)
      const hash = crypto.createHash('sha256')
      try { copyBytes(fd, output, Number(sizeBig), hash) } finally { fs.closeSync(output) }
      if (!crypto.timingSafeEqual(hash.digest(), expectedHash)) throw new Error(`Checksum mismatch: ${name}`)
      extracted.push(name)
    }
    throw new Error('Archive contains too many entries')
  } finally { fs.closeSync(fd) }
}
