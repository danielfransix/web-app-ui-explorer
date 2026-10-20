import readline from "node:readline"

/** True only in a real terminal on both ends — never in CI, a script, or an agent's non-interactive invocation. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

/** A plain y/n prompt. Resolves false (never hangs) if stdin closes before an answer, e.g. piped empty input. */
export async function confirm(question: string): Promise<boolean> {
  if (!isInteractive()) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.once("close", () => resolve("n"))
        rl.question(`${question} [y/n] `, resolve)
      })
      const normalised = answer.trim().toLowerCase()
      if (normalised === "y" || normalised === "yes") return true
      if (normalised === "n" || normalised === "no" || normalised === "") return false
      console.log("Please answer y or n.")
    }
  } finally {
    rl.close()
  }
}

/** A numbered choice among options. Resolves undefined on "0", empty input, or stdin closing. */
export async function chooseOne(question: string, options: string[]): Promise<number | undefined> {
  if (!isInteractive()) return undefined
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(question)
    options.forEach((option, index) => console.log(`  ${index + 1}. ${option}`))
    console.log(`  0. None of these`)
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.once("close", () => resolve("0"))
        rl.question("> ", resolve)
      })
      const trimmed = answer.trim()
      if (trimmed === "0" || trimmed === "") return undefined
      const index = Number(trimmed)
      if (Number.isInteger(index) && index >= 1 && index <= options.length) return index - 1
      console.log(`Please enter a number from 0 to ${options.length}.`)
    }
  } finally {
    rl.close()
  }
}
