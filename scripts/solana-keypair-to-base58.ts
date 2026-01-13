import { readFileSync } from 'node:fs'

function isByteArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
}

function extractKey(data: unknown): number[] | null {
  if (isByteArray(data)) return data
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    if (isByteArray(record.secretKey)) return record.secretKey
    if (isByteArray(record.privateKey)) return record.privateKey
    if (isByteArray(record.keypair)) return record.keypair
  }
  return null
}

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: npx ts-node scripts/solana-keypair-to-base58.ts <path-to-keypair.json>')
    process.exit(1)
  }

  let json: unknown
  try {
    const raw = readFileSync(filePath, 'utf8')
    json = JSON.parse(raw)
  } catch (err) {
    console.error(`Failed to read/parse JSON file: ${filePath}`)
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }

  const keyArray = extractKey(json)
  if (!keyArray) {
    console.error('Expected a JSON array of byte values (0-255), or an object with secretKey/privateKey/keypair.')
    process.exit(1)
  }

  const { default: bs58 } = await import('bs58')
  const bytes = Uint8Array.from(keyArray)
  console.log(bs58.encode(bytes))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
