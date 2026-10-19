import { Buffer } from "node:buffer"

// Embedded 4.8KB WebAssembly binary compiled from optimized Rust
// Performs Keccak-f[1600] 23-round proof-of-work solving at ~700,000 hashes/sec
const WASM_BASE64 = "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AAAcAOsAAAAAAAAAuwAAAAAAAAAAAAAAArAAAAACpgAAAANvCwAABwAAAAftAwAAAACfBgAAACoAAAABPAMEWwsAAAkAAAAH7QMAAAAAn24AAACTAAAAAQoBAwACtQAAAAIAAAAAA2ULAAAJAAAAB+0DAAAAAJ80AAAAXQAAAAMmAwAAAAAALg0uZGVidWdfcmFuZ2VzbwsAAHYLAABlCwAAbgsAAFsLAABkCwAAAAAAAAAAAAAAlQMKLmRlYnVnX3N0cmluZGV4AF9STnZOdENzZ1hHcDVPcXgyTnlfNGNvcmU5cGFuaWNraW5nOXBhbmljX2ZtdABfUk52TnROdENzZ1hHcDVPcXgyTnlfNGNvcmU1c2xpY2U1aW5kZXgxNnNsaWNlX2luZGV4X2ZhaWwAX1JOdk50Q3NnWEdwNU9xeDJOeV80Y29yZTlwYW5pY2tpbmcxOHBhbmljX2JvdW5kc19jaGVjawBwYW5pY2tpbmcAY29yZQBzbGljZQAvcnVzdGMvNTk4MDc2MTZlMWZhMjU0MDcyNGJmYmFjMTRkNzk3NmQ3ZTRhMzg2MAAvcnVzdGMvNTk4MDc2MTZlMWZhMjU0MDcyNGJmYmFjMTRkNzk3NmQ3ZTRhMzg2MC9saWJyYXJ5L2NvcmUvc3JjL2xpYi5ycy9AL2NvcmUuYzU5MzBjODVhMTJkZTgyMi1jZ3UuMABjbGFuZyBMTFZNIChydXN0YyB2ZXJzaW9uIDEuOTUuMCAoNTk4MDc2MTZlIDIwMjYtMDQtMTQpKQAAugELLmRlYnVnX2xpbmWqAAAABABkAAAAAQEB+w4NAAEBAQEAAAABAAABbGlicmFyeS9jb3JlL3NyYwBsaWJyYXJ5L2NvcmUvc3JjL3NsaWNlAABwYW5pY2tpbmcucnMAAQAAcGFuaWMucnMAAQAAaW5kZXgucnMAAgAAAAUOCgAFAnALAAADzwABBgOwf0oCAgABAQQCBQkKAAUCZgsAAAOwAQECCAABAQUFCgAFAlwLAAADjgIBAggAAQEA/AEEbmFtZQATEmtlY2Nha19zb2x2ZXIud2FzbQG/AQUADmdldF9tZW1vcnlfcHRyAQlzb2x2ZV9wb3cCN19STnZOdENzZ1hHcDVPcXgyTnlfNGNvcmU5cGFuaWNraW5nMThwYW5pY19ib3VuZHNfY2hlY2sDOV9STnZOdE50Q3NnWEdwNU9xeDJOeV80Y29yZTVzbGljZTVpbmRleDE2c2xpY2VfaW5kZXhfZmFpbAQtX1JOdk50Q3NnWEdwNU9xeDJOeV80Y29yZTlwYW5pY2tpbmc5cGFuaWNfZm10BxIBAA9fX3N0YWNrX3BvaW50ZXIJCgEABy5yb2RhdGEATQlwcm9kdWNlcnMCCGxhbmd1YWdlAQRSdXN0AAxwcm9jZXNzZWQtYnkBBXJ1c3RjHTEuOTUuMCAoNTk4MDc2MTZlIDIwMjYtMDQtMTQpAJQBD3RhcmdldF9mZWF0dXJlcwgrC2J1bGstbWVtb3J5Kw9idWxrLW1lbW9yeS1vcHQrFmNhbGwtaW5kaXJlY3Qtb3ZlcmxvbmcrCm11bHRpdmFsdWUrD211dGFibGUtZ2xvYmFscysTbm9udHJhcHBpbmctZnB0b2ludCsPcmVmZXJlbmNlLXR5cGVzKwhzaWduLWV4dA=="

let wasmInstancePromise = null

async function getWasmInstance() {
  if (wasmInstancePromise) return wasmInstancePromise
  wasmInstancePromise = (async () => {
    try {
      if (typeof WebAssembly === "undefined") return null
      const buf = Buffer.from(WASM_BASE64, "base64")
      const { instance } = await WebAssembly.instantiate(buf)
      return instance
    } catch {
      return null
    }
  })()
  return wasmInstancePromise
}

// ---- Pure JS Keccak-f23 implementation (fallback & verification) ------------

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44]
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1]

function rotl64(x, n) {
  const b = BigInt(n)
  return ((x << b) | (x >> (64n - b))) & 0xffffffffffffffffn
}

function keccakF23(st, bc) {
  for (let round = 1; round <= 23; round++) {
    for (let i = 0; i < 5; i++) {
      bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20]
    }
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1)
      for (let j = 0; j < 25; j += 5) {
        st[j + i] ^= t
      }
    }
    let t = st[1]
    for (let i = 0; i < 24; i++) {
      const j = PILN[i]
      const tmp = st[j]
      st[j] = rotl64(t, ROTC[i])
      t = tmp
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) {
        bc[i] = st[j + i]
      }
      for (let i = 0; i < 5; i++) {
        st[j + i] = bc[i] ^ (~bc[(i + 1) % 5] & bc[(i + 2) % 5])
      }
    }
    st[0] ^= RC[round]
  }
}

/**
 * Computes DeepSeekHashV1 for a given buffer.
 * Matches chat.deepseek.com's 23-round Keccak-f[1600] specification.
 */
export function deepSeekHashV1(msgBytes) {
  const st = new BigUint64Array(25)
  const bc = new BigUint64Array(5)
  const rate = 136
  let offset = 0
  let remaining = msgBytes.length

  const dv = new DataView(msgBytes.buffer, msgBytes.byteOffset, msgBytes.byteLength)

  while (remaining >= rate) {
    for (let i = 0; i < rate / 8; i++) {
      st[i] ^= dv.getBigUint64(offset + i * 8, true)
    }
    keccakF23(st, bc)
    offset += rate
    remaining -= rate
  }

  const blk = new Uint8Array(rate)
  blk.set(msgBytes.subarray(offset))
  blk[remaining] = 0x06
  blk[rate - 1] |= 0x80

  const blkDv = new DataView(blk.buffer)
  for (let i = 0; i < rate / 8; i++) {
    st[i] ^= blkDv.getBigUint64(i * 8, true)
  }
  keccakF23(st, bc)

  const out = Buffer.alloc(32)
  for (let i = 0; i < 4; i++) {
    out.writeBigUInt64LE(st[i], i * 8)
  }
  return out.toString("hex")
}

function solvePowJs(prefixStr, targetHex, startNonce = 0, maxSteps = 2000000) {
  const targetBuf = Buffer.from(targetHex, "hex")
  const t0 = targetBuf.readBigUInt64LE(0)
  const t1 = targetBuf.readBigUInt64LE(8)
  const t2 = targetBuf.readBigUInt64LE(16)
  const t3 = targetBuf.readBigUInt64LE(24)

  const prefixBuf = Buffer.from(prefixStr, "utf8")
  const msgBuf = Buffer.alloc(136)
  prefixBuf.copy(msgBuf, 0)
  const plen = prefixBuf.length

  const blk = new Uint8Array(136)
  const blkDv = new DataView(blk.buffer)
  const st = new BigUint64Array(25)
  const bc = new BigUint64Array(5)

  for (let s = 0; s < maxSteps; s++) {
    const nonce = startNonce + s
    const nonceStr = String(nonce)
    const nlen = msgBuf.write(nonceStr, plen, "utf8")
    const mlen = plen + nlen

    blk.fill(0)
    msgBuf.copy(blk, 0, 0, mlen)
    blk[mlen] = 0x06
    blk[135] |= 0x80

    st.fill(0n)
    for (let i = 0; i < 17; i++) {
      st[i] = blkDv.getBigUint64(i * 8, true)
    }

    keccakF23(st, bc)

    if (st[0] === t0 && st[1] === t1 && st[2] === t2 && st[3] === t3) {
      return nonce
    }
  }
  return -1
}

/**
 * Solves a DeepSeek POW challenge.
 *
 * @param {object} challengeObj
 * @param {string} challengeObj.algorithm - e.g. "DeepSeekHashV1"
 * @param {string} challengeObj.challenge - 64-char hex target
 * @param {string} challengeObj.salt - salt string
 * @param {string} [challengeObj.signature]
 * @param {number} challengeObj.expire_at - timestamp in ms
 * @param {string} [challengeObj.target_path]
 * @param {object} [options]
 * @returns {Promise<object>} Solved POW object with `answer`
 */
export async function solvePow(challengeObj, options = {}) {
  const {
    algorithm = "DeepSeekHashV1",
    challenge,
    salt,
    signature = "",
    expire_at,
    target_path = "/api/v0/chat/completion",
  } = challengeObj

  if (algorithm && algorithm !== "DeepSeekHashV1") {
    throw new Error(`Unsupported POW algorithm: ${algorithm}`)
  }
  if (!challenge || !salt || !expire_at) {
    throw new Error("Invalid POW challenge: missing required fields")
  }

  const prefixStr = `${salt}_${expire_at}_`
  const prefixBuf = Buffer.from(prefixStr, "utf8")
  const targetBuf = Buffer.from(challenge, "hex")
  if (targetBuf.length !== 32) {
    throw new Error(`Invalid challenge hex length: ${challenge.length}`)
  }

  const t0 = targetBuf.readBigUInt64LE(0)
  const t1 = targetBuf.readBigUInt64LE(8)
  const t2 = targetBuf.readBigUInt64LE(16)
  const t3 = targetBuf.readBigUInt64LE(24)

  const wasm = await getWasmInstance()
  const maxSearchSteps = options.maxSteps || 2000000

  let answer = -1
  if (wasm) {
    const { solve_pow, get_memory_ptr, memory } = wasm.exports
    const memPtr = get_memory_ptr()
    const memView = new Uint8Array(memory.buffer, memPtr, prefixBuf.length)
    memView.set(prefixBuf)

    let currentNonce = 0n
    const chunkSize = 100000n
    const totalMax = BigInt(maxSearchSteps)

    while (currentNonce < totalMax) {
      const steps = currentNonce + chunkSize > totalMax ? totalMax - currentNonce : chunkSize
      const res = solve_pow(prefixBuf.length, t0, t1, t2, t3, currentNonce, steps)
      if (res >= 0n) {
        answer = Number(res)
        break
      }
      currentNonce += steps
    }
  }

  // Fallback to JS if WASM failed or was unavailable
  if (answer < 0) {
    answer = solvePowJs(prefixStr, challenge, 0, maxSearchSteps)
  }

  if (answer < 0) {
    throw new Error(`Failed to solve POW within ${maxSearchSteps} steps`)
  }

  return {
    algorithm,
    challenge,
    salt,
    answer,
    signature,
    target_path,
  }
}

/**
 * Builds the base64 JSON header required by DeepSeek `x-ds-pow-response`.
 */
export function buildPowResponseHeader(powResult) {
  return Buffer.from(JSON.stringify(powResult)).toString("base64")
}
